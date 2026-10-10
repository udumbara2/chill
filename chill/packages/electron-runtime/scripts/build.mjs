/**
 * electron-runtime 构建装配：把 Electron 官方预编译 win32-x64 发行包原样搬进本包。
 *
 * 设计要点（0.0.3 治理项：GitHub 出安装链路）：
 * - 用户侧零编译零下载：本包纯文件（无 install 脚本），装完即用——安装链路只剩 npm registry
 * - 内容 = 官方 zip 原样（electron.exe + DLL + resources + locales）+ 官方 cli.js（启动引导）
 *   + 合规 LICENSE 文件；我们不修改任何二进制
 * - 构建期取 zip：优先本地 electron 缓存（发布机今晚已缓存），否则 ELECTRON_MIRROR/官方源下载
 * - 版本编法：与 electron 版本严格一致（28.3.3）——engine 升补丁时本包才发新版，
 *   壳包（@assistant-ai/chill）升级 UI 时复用同一运行时包（npm 缓存命中，不重下 100MB）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON_VERSION = '28.3.3'
const ZIP_NAME = `electron-v${ELECTRON_VERSION}-win32-x64.zip`

function removeRecursive(p) {
  let stat
  try { stat = fs.lstatSync(p) } catch { return }
  if (stat.isSymbolicLink()) { fs.rmdirSync(p); return }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(p)) removeRecursive(path.join(p, name))
    fs.rmdirSync(p)
  } else {
    fs.unlinkSync(p)
  }
}

/** 本地 electron 缓存（@electron/get 的标准缓存位） */
function findCachedZip() {
  const cacheDirs = [
    path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'),
    path.join(os.homedir(), '.cache', 'electron'),
  ]
  for (const dir of cacheDirs) {
    if (!fs.existsSync(dir)) continue
    // 缓存结构：<cache>/<hash>/<filename>（@electron/get 布局），递归找目标名
    const found = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name === ZIP_NAME) found.push(p)
      }
    }
    try { walk(dir) } catch { /* 继续 */ }
    if (found.length > 0) return found[0]
  }
  return null
}

function downloadZip(dest) {
  const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
  const urls = [
    `${mirror}v${ELECTRON_VERSION}/${ZIP_NAME}`,
    `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP_NAME}`,
  ]
  for (const url of urls) {
    console.log(`[runtime] 下载 ${url}`)
    const r = spawnSync('curl', ['-L', '--fail', '-o', dest, url], { stdio: 'inherit' })
    if (r.status === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 50 * 1024 * 1024) return true
    console.log(`[runtime] 该源失败（退出码 ${r.status}），尝试下一源`)
  }
  return false
}

function unzip(zipPath, destDir) {
  console.log(`[runtime] 解压 → ${destDir}`)
  fs.mkdirSync(destDir, { recursive: true })
  const r = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`解压失败（退出码 ${r.status}）`)
}

// ---------- 装配 ----------
const distDir = path.join(pkgDir, 'dist')
removeRecursive(distDir)

let zip = findCachedZip()
if (zip) {
  console.log(`[runtime] 命中本地缓存: ${zip}`)
} else {
  const tmpZip = path.join(os.tmpdir(), ZIP_NAME)
  if (!downloadZip(tmpZip)) {
    console.error('[runtime] 错误: 无法获得 electron zip（缓存/镜像/官方源均失败）')
    process.exit(1)
  }
  zip = tmpZip
}

unzip(zip, distDir)

// 断言：引擎核心文件必须在位
for (const probe of ['electron.exe', 'resources', 'LICENSE', 'LICENSES.chromium.html']) {
  if (!fs.existsSync(path.join(distDir, probe))) {
    console.error(`[runtime] 断言失败: dist/${probe} 缺失`)
    process.exit(1)
  }
}

// 合规文件平铺到包根（files 白名单引用）
for (const f of ['LICENSE', 'LICENSES.chromium.html']) {
  fs.copyFileSync(path.join(distDir, f), path.join(pkgDir, f))
}

// 官方 cli.js：从 monorepo 的 electron 包拷贝（启动引导，node cli.js <app> 形态）
const officialCli = path.join(pkgDir, '../electron/node_modules/electron/cli.js')
if (fs.existsSync(officialCli)) {
  fs.copyFileSync(officialCli, path.join(pkgDir, 'cli.js'))
} else {
  // 兜底：官方 cli.js 逻辑极薄（定位 dist/electron.exe 并 spawn），自写等价引导
  fs.writeFileSync(path.join(pkgDir, 'cli.js'), `#!/usr/bin/env node
// electron-win32-x64 启动引导（等价官方 cli.js：node cli.js <app目录> [参数…]）
const { spawn } = require('node:child_process')
const path = require('node:path')
const args = process.argv.slice(2)
const electronExe = path.join(__dirname, 'dist', 'electron.exe')
const child = spawn(electronExe, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code == null ? 0 : code)
})
`)
}

console.log(`[runtime] 装配完成：@assistant-ai/electron-win32-x64@${ELECTRON_VERSION}（纯文件包，零 install 脚本）`)
