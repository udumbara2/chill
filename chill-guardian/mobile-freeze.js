#!/usr/bin/env node
/**
 * mobile-freeze.js — 手机端快照锚点：固化 chill-mobile 活树 → chill-mobile-versions/，支持一键回退
 *
 * 用法:
 *   node mobile-freeze.js <chill-mobile路径> [goal描述] [--name <名>] [--pending-visual]   # 固化快照（--name 覆盖时间戳命名，基线用它；--pending-visual 挂视觉/运行时未验证欠账）
 *   node mobile-freeze.js --status <chill-mobile路径>                   # 对照最新快照列活树差异（robocopy /L，同排除清单）
 *   node mobile-freeze.js --list <chill-mobile路径>                     # 列快照（时间/goal/pair/pendingVisual）
 *   node mobile-freeze.js --rollback <chill-mobile路径> [m<ts>|名称]    # 回退：先自动留底 → /MIR 拷回 → 更新指针
 *   node mobile-freeze.js --repair <chill-mobile路径>                   # 配对续期：只更新 m-current.json 的 pair/repairedAt
 *
 * 设计（见 weRealize/手机端自迭代实施规划.md）：
 *   - 活树永远不被重命名/删除（只覆盖拷贝）；快照不可变（重名加后缀）
 *   - 回退前必先留底（可来回跳）；缺省回退目标 = 指针的 previous（照桌面 current.json 语义）
 *   - pair 读 <父目录>/chill-versions/current.json 的 current（chill 当前版本），固化时自动写入
 *   - 指针 m-current.json 一律 tmp+rename 原子写；robocopy 退出码 0-7 均成功
 *   - 中文路径纪律：照 freeze.js——robocopy spawn 不走 shell；递归删除手写（Node fs.rmSync 在中文路径静默失败）
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// /XD=排除目录（名字匹配，任意层级）；/XF=排除文件（敏感/机器特定 + 快照元数据，双向豁免：不拷也不删）
// .keystore.json：e2e-harness 本地中继一次性密钥对，每轮 e2e 重新生成——入快照只会制造假残留
const XD = ['node_modules', '.git', '.gradle', '.cxx', 'build', 'Pods', 'coverage', '.bundle', '.metro-health-check*']
const XF = ['local.properties', '.env*', 'ca.key', 'server.key', '.version.json', '.keystore.json']
// 注：不用 *.key/*.pem 通配——robocopy 的 * 按扩展名前缀匹配（*.key 会吞 debug.keystore，
// *.pem 会吞公开 CA 资源 res/raw/ca_crt.pem）；本项目真实私钥就是 ca.key/server.key
// （chill-relay 证书件，本就不该出现在手机树里），点名排除即可。

const args = process.argv.slice(2)
const flag = args[0] && args[0].startsWith('--') ? args[0] : null
const mobilePath = flag ? args[1] : args[0]
if (!mobilePath) {
  console.error('用法: node mobile-freeze.js [--status|--list|--rollback|--repair] <chill-mobile路径> [goal] [--name <名>] [--pending-visual]')
  process.exit(1)
}
const positional = args.filter((a, i) => (flag ? i >= 2 : i >= 1) && !a.startsWith('--'))
const goalArg = flag ? null : (positional[0] || '')
const nameIdx = args.indexOf('--name')
const nameArg = nameIdx !== -1 ? args[nameIdx + 1] : null
// --pending-visual：固化时显式挂欠账（无设备验证不许宣称已验证；缺省=继承上一快照的欠账状态）
const pendingVisualArg = args.includes('--pending-visual')

const parentDir = path.dirname(path.resolve(mobilePath))
const versionsDir = path.join(parentDir, 'chill-mobile-versions')
const pointerPath = path.join(versionsDir, 'm-current.json')
const chillCurrentJson = path.join(parentDir, 'chill-versions', 'current.json')

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1) }

/** 目标防呆：像 chill-mobile 才动手（照 freeze.js 对 chill 的校验先例） */
function validateTarget() {
  const pkgPath = path.join(mobilePath, 'package.json')
  if (!fs.existsSync(pkgPath) || !fs.existsSync(path.join(mobilePath, 'App.tsx'))) {
    fail(`目标不像 chill-mobile（缺 package.json 或 App.tsx）: ${mobilePath}`)
  }
  try {
    const deps = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    if (!deps.dependencies || !deps.dependencies['react-native']) fail(`package.json 无 react-native 依赖，不像 chill-mobile: ${mobilePath}`)
  } catch (e) { fail(`package.json 解析失败: ${e.message}`) }
}

function robocopY(src, dst, extra = []) {
  const rob = spawnSync('robocopy', [src, dst, '/E', ...extra,
    '/XD', ...XD, '/XF', ...XF, '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, stdio: 'ignore' })
  // robocopy 0-7 均成功；/L 模式 0=无差异 1=有差异
  return rob.status === null ? 999 : rob.status
}

/** 递归删除（手写，照 freeze.js：Node fs.rmSync 中文路径静默失败；符号链接只删链接） */
function removeRecursive(p) {
  let stat
  try { stat = fs.lstatSync(p) } catch { return }
  if (stat.isSymbolicLink()) { fs.rmdirSync(p); return }
  if (!stat.isDirectory()) { fs.unlinkSync(p); return }
  for (const name of fs.readdirSync(p)) removeRecursive(path.join(p, name))
  fs.rmdirSync(p)
}

/** XD/XF 名单匹配（dir 名精确 + 通配；file 名通配） */
function xdMatch(name) { return XD.some(p => p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p) }
function xfMatch(name) {
  return XF.some(p => {
    if (p.endsWith('*') && p.startsWith('*')) return name.endsWith(p.slice(1)) && name.length > p.length - 1
    if (p.endsWith('*')) return name.startsWith(p.slice(0, -1))
    return name === p
  })
}

/** 纯 Node 递归收集相对文件路径（排除名单生效；避开 robocopy /L 退出码位语义坑——实测 code2 由快照内 .version.json 等"目标侧额外文件"误置） */
function walkFiles(root, rel = '', out = []) {
  for (const name of fs.readdirSync(path.join(root, rel))) {
    if (xdMatch(name)) continue
    const relPath = rel ? `${rel}/${name}` : name
    if (fs.lstatSync(path.join(root, relPath)).isDirectory()) walkFiles(root, relPath, out)
    else if (!xfMatch(name)) out.push(relPath)
  }
  return out
}

/** 内容级差异：live 相对最新快照的新增/删除/改动（mtime+size 比较，不做字节级哈希——快照由 robocopy 原样拷贝，时间戳保真） */
function diffAgainstSnapshot(liveRoot, snapRoot) {
  const live = walkFiles(liveRoot)
  const snap = walkFiles(snapRoot)
  const snapSet = new Set(snap)
  const liveSet = new Set(live)
  const added = live.filter(f => !snapSet.has(f))
  const removed = snap.filter(f => !liveSet.has(f))
  const changed = live.filter(f => {
    if (!snapSet.has(f)) return false
    const a = fs.statSync(path.join(liveRoot, f)), b = fs.statSync(path.join(snapRoot, f))
    return a.size !== b.size || a.mtimeMs !== b.mtimeMs
  })
  return { added, removed, changed }
}
function atomicWrite(file, data) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function readPointer() {
  try { return JSON.parse(fs.readFileSync(pointerPath, 'utf-8')) } catch { return null }
}

function readChillCurrent() {
  try { return JSON.parse(fs.readFileSync(chillCurrentJson, 'utf-8')).current || '' } catch { return '' }
}

function listSnapshots() {
  if (!fs.existsSync(versionsDir)) return []
  return fs.readdirSync(versionsDir)
    .filter(f => /^m[A-Za-z0-9._-]+$/.test(f) && fs.statSync(path.join(versionsDir, f)).isDirectory())
    .map(name => {
      let meta = {}
      try { meta = JSON.parse(fs.readFileSync(path.join(versionsDir, name, '.version.json'), 'utf-8')) } catch { /* 无元数据按空 */ }
      return { name, ...meta }
    })
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.name.localeCompare(b.name))
}

function uniqueName(base) {
  let candidate = base, n = 2
  while (fs.existsSync(path.join(versionsDir, candidate))) candidate = `${base}-${n++}`
  return candidate
}

function makeTimestamp() {
  const d = new Date(), pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 固化（内部复用：用户固化 + 回退前自动留底） */
function doFreeze(goal, name, pendingVisual) {
  validateTarget()
  fs.mkdirSync(versionsDir, { recursive: true })
  const version = uniqueName(name || `m${makeTimestamp()}`)
  const snapshotPath = path.join(versionsDir, version)
  const code = robocopY(mobilePath, snapshotPath)
  if (code > 7) {
    removeRecursive(snapshotPath)
    fail(`robocopy 固化失败（退出码 ${code}），已清理不完整快照，活树未动`)
  }
  if (!fs.existsSync(path.join(snapshotPath, 'App.tsx'))) {
    removeRecursive(snapshotPath)
    fail('快照校验失败（缺 App.tsx），已清理不完整快照，活树未动')
  }
  const prev = readPointer()
  const meta = {
    version, at: new Date().toISOString(), goal,
    pair: readChillCurrent(),
    pendingVisual: pendingVisual !== undefined ? pendingVisual : (prev ? prev.pendingVisual === true : false)
  }
  fs.writeFileSync(path.join(snapshotPath, '.version.json'), JSON.stringify(meta, null, 2) + '\n')
  atomicWrite(pointerPath, JSON.stringify({
    current: version, currentPath: snapshotPath, previous: prev ? prev.current : null,
    at: meta.at, goal, pair: meta.pair, pendingVisual: meta.pendingVisual
  }, null, 2) + '\n')
  console.log(`✓ 固化完成: ${version}（pair: ${meta.pair || '未知'}${meta.pendingVisual ? '，欠账: 视觉未验证' : ''}）`)
  return version
}

// === 子命令 ===
if (flag === '--list') {
  validateTarget()
  const snaps = listSnapshots()
  if (snaps.length === 0) { console.log('（无快照——先固化基线）'); process.exit(0) }
  const ptr = readPointer()
  for (const s of snaps) {
    const isCurrent = ptr && ptr.current === s.name
    // pair 展示：当前快照以指针为准（--repair 续期后指针是新值，快照 .version.json 保持诞生时记录不可变）
    const pairShown = isCurrent ? (ptr.pair || s.pair) : s.pair
    const repaired = isCurrent && ptr && ptr.repairedAt ? `（续验 ${ptr.repairedAt.slice(0, 10)}）` : ''
    console.log(`${s.name}${isCurrent ? '  ← 当前' : ''}  ${s.at || ''}  pair=${pairShown || '?'}${repaired}${s.pendingVisual ? '  [pendingVisual]' : ''}\n    ${s.goal || '(无目标描述)'}`)
  }
  process.exit(0)
}

if (flag === '--status') {
  validateTarget()
  const snaps = listSnapshots()
  if (snaps.length === 0) fail('无基线，先固化：node mobile-freeze.js <路径> "<基线描述>" --name m6-baseline')
  const latestName = snaps[snaps.length - 1].name
  const { added, removed, changed } = diffAgainstSnapshot(mobilePath, path.join(versionsDir, latestName))
  const total = added.length + removed.length + changed.length
  if (total === 0) { console.log(`✓ 与最新快照无差异（${latestName}）`); process.exit(0) }
  console.log(`检出未固化差异（对照 ${latestName}，共 ${total} 项）：`)
  for (const f of changed) console.log(`  改动  ${f}`)
  for (const f of added) console.log(`  新增  ${f}`)
  for (const f of removed) console.log(`  已删  ${f}`)
  process.exit(2)
}

if (flag === '--repair') {
  validateTarget()
  const ptr = readPointer()
  if (!ptr) fail('尚无快照指针，先固化基线')
  const pair = readChillCurrent()
  if (!pair) fail(`读不到 chill 当前版本（${chillCurrentJson}），无法续期`)
  atomicWrite(pointerPath, JSON.stringify({ ...ptr, pair, repairedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(`✓ 配对续期: pair=${pair}（repairedAt 已记录；本命令不做验证，须先 e2e 全绿再调用）`)
  process.exit(0)
}

if (flag === '--rollback') {
  validateTarget()
  const snaps = listSnapshots()
  if (snaps.length === 0) fail('无快照可回退，先固化基线')
  const ptr = readPointer()
  if (!ptr) fail('指针缺失，无法确定当前版本')
  let targetName = positional[0] || ''
  if (!targetName) {
    if (!ptr.previous) fail('仅一份快照（无 previous），须显式指定回退目标')
    targetName = ptr.previous
  }
  const exact = snaps.filter(s => s.name === targetName)
  const matched = exact.length ? exact : snaps.filter(s => s.name.startsWith(targetName))
  if (matched.length === 0) fail(`版本不存在: ${targetName}（--list 查看可用快照）`)
  if (matched.length > 1) fail(`前缀不唯一: ${targetName} 匹配 [${matched.map(s => s.name).join(', ')}]`)
  if (matched[0].name === ptr.current) fail(`${matched[0].name} 已是当前版本，无需回退`)

  const targetPath = path.join(versionsDir, matched[0].name)
  // 1) 自动留底当前态（可来回跳的保证）
  doFreeze('自动留底（回退前）', null, ptr.pendingVisual === true)
  // 2) 依赖差异检测（快照不含 node_modules，防依赖错配）
  const depFiles = ['package.json', 'package-lock.json']
  const readOr = (p) => { try { return fs.readFileSync(p, 'utf-8') } catch { return null } }
  const depChanged = depFiles.filter(f => {
    const a = readOr(path.join(mobilePath, f)), b = readOr(path.join(targetPath, f))
    return a !== b // 双缺失=null=null→无差异；单缺失或内容不同→提示
  })
  // 3) /MIR 拷回（/XD /XF 双向豁免：node_modules 与敏感文件不删）
  const code = robocopY(targetPath, mobilePath, ['/MIR'])
  if (code > 7) fail(`robocopy /MIR 失败（退出码 ${code}），活树可能不完整——重试或对照快照手工恢复`)
  // 4) 指针更新（pendingVisual 恢复为目标快照的欠账状态）
  const targetMeta = matched[0]
  atomicWrite(pointerPath, JSON.stringify({
    current: targetMeta.name, currentPath: targetPath, previous: readPointer().current,
    at: new Date().toISOString(), goal: `回退到 ${targetMeta.name}`, pair: targetMeta.pair || '',
    pendingVisual: targetMeta.pendingVisual === true
  }, null, 2) + '\n')
  console.log(`✓ 已回退到 ${targetMeta.name}（${targetMeta.goal || '无描述'}）—— Metro/设备刷新即生效`)
  if (targetMeta.pendingVisual === true) console.log('⚠ 该快照带视觉欠账（pendingVisual）——设备可达后说"补验手机端"')
  if (depChanged.length > 0) console.log(`⚠ 依赖清单变化（${depChanged.join(', ')}）——回退后需在 chill-mobile 执行 npm install`)
  process.exit(0)
}

// 默认：固化（欠账=本轮判定，不继承：带 --pending-visual = 挂账；不带 = 本轮已验证——
// 与 SKILL 规矩五一致，补验后下次固化自然清账；上轮欠账由 --list/指针如实展示，回退留底的显式保留不受影响）
doFreeze(goalArg, nameArg, pendingVisualArg === true)
