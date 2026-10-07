#!/usr/bin/env node
/**
 * freeze.js — 版本固化:把当前 chill/ 固化为 chill-versions/v<时间戳>/ 并重建 junction 指针
 *
 * 用法: node chill-guardian/freeze.js [--dry-run]
 *
 * 解决的问题:手工复制粘贴 chill 目录会把 junction 变成真实目录,指针静默丢失。
 * 本脚本把"固化 → 删旧 → 建链 → 校正指针"做成原子序列,防呆:
 *   1. robocopy 复制(排除 node_modules / dist-electron)
 *   2. 校验快照完整性(失败则中止,不动现有布局)
 *   3. 区分旧 chill 是 junction(只删链接)还是真实目录(完整删除)
 *   4. 重建 junction + 校正 current.json(previousPath 保留回滚目标)
 *
 * --dry-run: 只复制并校验快照,不删目录、不建链、不写指针。
 * --repair : 指针修复模式——chill 已是健康 junction 时直接报告并退出,不做任何改动;
 *            chill 缺失或链接悬空(手动固化/拷贝导致)时按 current.json 重建 junction;
 *            chill 是真实目录(复制粘贴导致断链)时执行完整固化修复。
 * --build  : 修复/固化后自动在新版本目录执行 CI=true pnpm install + packages/cli 构建。
 * 环境变量 FREEZE_HOME: 覆盖根目录(仅用于测试)。
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const dryRun = process.argv.includes('--dry-run')
const repairMode = process.argv.includes('--repair')
const autoBuild = process.argv.includes('--build')
const base = process.env.FREEZE_HOME || path.resolve(__dirname, '..')
const chillDir = path.join(base, 'chill')
const versionsDir = path.join(base, 'chill-versions')
const currentJsonPath = path.join(versionsDir, 'current.json')

// repair 模式:指针健康则不动
if (repairMode && fs.existsSync(chillDir) && fs.lstatSync(chillDir).isSymbolicLink()) {
  console.log('✓ 指针正常(chill 已是 junction),无需修复:', fs.readlinkSync(chillDir))
  process.exit(0)
}

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

/** 在指定版本目录执行 CI=true pnpm install + packages/cli 构建(供 --build 复用) */
function runBuild(targetPath) {
  console.log('[+] 安装依赖并构建…')
  const env = { ...process.env, CI: 'true' }
  const ins = spawnSync('pnpm', ['install'], { cwd: targetPath, stdio: 'inherit', shell: true, env })
  if (ins.status !== 0) fail(`pnpm install 失败(退出码 ${ins.status});指针已恢复,可稍后手动构建`)
  const bld = spawnSync('pnpm', ['build'], { cwd: path.join(targetPath, 'packages', 'cli'), stdio: 'inherit', shell: true, env })
  if (bld.status !== 0) fail(`构建失败(退出码 ${bld.status});指针已恢复,可稍后手动构建`)
  console.log('[+] 依赖与构建完成')
}

// repair 模式:chill 缺失或链接悬空(手动固化/拷贝导致)时,按 current.json 重建 junction
if (repairMode && !fs.existsSync(chillDir)) {
  let dangling = false
  try { dangling = fs.lstatSync(chillDir).isSymbolicLink() } catch { /* chill 完全不存在 */ }
  let currentPath = null
  try { currentPath = JSON.parse(fs.readFileSync(currentJsonPath, 'utf-8')).currentPath || null } catch { /* 无 current.json */ }
  if (!currentPath || !fs.existsSync(path.join(currentPath, 'packages', 'cli', 'package.json'))) {
    fail(`chill ${dangling ? '链接悬空' : '目录不存在'},且 current.json 指向的版本无效(${currentPath || '无记录'}),无法自动重建`)
  }
  if (dangling) fs.rmdirSync(chillDir) // 仅删除悬空链接
  fs.symlinkSync(currentPath, chillDir, 'junction')
  console.log(`✓ 链接${dangling ? '悬空' : '缺失'},已按 current.json 重建 junction: chill → ${currentPath}`)
  if (autoBuild) runBuild(currentPath)
  process.exit(0)
}

/** 与 switcher.js 一致的递归删除(中文路径下 Node fs.rmSync 会静默失败,禁用) */
function removeRecursive(p) {
  let stat
  try { stat = fs.lstatSync(p) } catch { return }
  if (stat.isSymbolicLink()) { fs.rmdirSync(p); return }
  if (!stat.isDirectory()) { fs.unlinkSync(p); return }
  for (const name of fs.readdirSync(p)) removeRecursive(path.join(p, name))
  fs.rmdirSync(p)
}

// 1. 前置检查
if (!fs.existsSync(chillDir)) fail(`chill 目录不存在: ${chillDir}`)
if (!fs.existsSync(path.join(chillDir, 'packages', 'cli', 'package.json'))) {
  fail('chill 目录不像 chill 项目(缺 packages/cli/package.json),中止')
}
if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true })

// 2. 旧指针(作为回滚目标保留)
let previousPath = null
try {
  const prev = JSON.parse(fs.readFileSync(currentJsonPath, 'utf-8'))
  previousPath = prev.currentPath || null
} catch { /* 无旧指针,首个版本 */ }

// 3. 时间戳版本名
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const version = `v${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const snapshotPath = path.join(versionsDir, version)
if (fs.existsSync(snapshotPath)) fail(`版本目录已存在: ${snapshotPath}`)

// 4. robocopy 复制(排除可重建/构建产物;spawn 不走 shell,中文路径安全)
//    target = Rust 构建缓存(chill 内为指向父目录 chill-rust-target 的 junction,robocopy
//    默认会遍历 junction 把 1.5GB 缓存实化进快照,必须排除;快照运行时只需包根 .node)
console.log(`[1/4] 固化 ${chillDir} → ${snapshotPath} ...`)
const rob = spawnSync('robocopy', [chillDir, snapshotPath, '/E', '/XD', 'node_modules', 'dist-electron', 'target', '/NFL', '/NDL', '/NP'], { stdio: 'inherit' })
// robocopy 退出码 0-7 均为成功(0=无变化,1=已复制,2/3=多余文件等)
if (rob.status === null || rob.status > 7) fail(`robocopy 失败(退出码 ${rob.status})`)

// 5. 校验快照
if (!fs.existsSync(path.join(snapshotPath, 'packages', 'cli', 'package.json'))) {
  removeRecursive(snapshotPath)
  fail('快照校验失败(缺 packages/cli/package.json),已清理不完整快照,现有布局未动')
}
console.log('[2/4] 快照校验通过')

if (dryRun) {
  console.log(`--dry-run: 快照已就绪于 ${snapshotPath},未改动现有布局`)
  process.exit(0)
}

// 6. 移除旧 chill(junction 只删链接,真实目录完整删)
const stat = fs.lstatSync(chillDir)
if (stat.isSymbolicLink()) {
  console.log('[3/4] 旧 chill 是 junction,仅删除链接')
  fs.rmdirSync(chillDir)
} else {
  console.log('[3/4] 旧 chill 是真实目录,完整删除(快照已就绪,可回滚)')
  removeRecursive(chillDir)
}

// 7. 重建 junction + 写指针
fs.symlinkSync(snapshotPath, chillDir, 'junction')
fs.writeFileSync(currentJsonPath, JSON.stringify({
  current: version,
  currentPath: snapshotPath,
  previousPath,
  at: now.toISOString()
}, null, 2) + '\n', 'utf-8')
console.log(`[4/4] junction 已重建: chill → ${version}`)

if (autoBuild) runBuild(snapshotPath)

console.log(JSON.stringify({
  ok: true, version, snapshotPath, previousPath,
  next: autoBuild ? '可直接使用' : `cd ${snapshotPath} && CI=true pnpm install && cd packages/cli && pnpm build`
}, null, 2))
