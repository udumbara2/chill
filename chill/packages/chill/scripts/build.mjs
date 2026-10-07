/**
 * 全档壳包构建：装配 dist 为「与 chill-cli dist 同构的资产布局」。
 *
 * 设计要点：electron-main.js（packages/electron 的 esbuild 产物，core 已内联）对
 * 模板/技能/worker/渲染器的解析全部是 __dirname 相对路径——壳包 dist 只要复制成与
 * cli dist 相同的目录形状，四处候选（electron-main 内已加的 npm 布局兜底）全部命中，
 * 零运行时聪明、零 core 改动。
 *
 * 来源：
 * - packages/electron/dist/{electron-main.js, preload.js}   → dist/
 * - packages/cli/dist/{templates, skills, workers}          → dist/
 * - packages/cli/dist/web/web-dist（渲染器静态资产）          → dist/web/web-dist
 *
 * 缺任一来源即硬失败（发布防泄露支柱 2：dist 由构建全新产生，宁可构建红也不发缺件包）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  let count = 0
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) count += copyDir(s, d)
    else { fs.copyFileSync(s, d); count++ }
  }
  return count
}

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`[build] 错误: 缺少 ${label}: ${p}`)
    console.error(`[build] 前置构建顺序：pnpm --filter @assistant-ai/core build && pnpm --filter @assistant-ai/electron build && pnpm --filter @assistant-ai/chill-cli build`)
    process.exit(1)
  }
}

const distDir = path.join(pkgDir, 'dist')
removeRecursive(distDir)
fs.mkdirSync(distDir, { recursive: true })

// 1. Electron 主进程 bundle + preload（core 已内联，native-desktop 为运行时包名解析）
const electronMain = path.join(pkgDir, '../electron/dist/electron-main.js')
const preload = path.join(pkgDir, '../electron/dist/preload.js')
mustExist(electronMain, 'electron 主进程 bundle')
mustExist(preload, 'electron preload')
fs.copyFileSync(electronMain, path.join(distDir, 'electron-main.js'))
fs.copyFileSync(preload, path.join(distDir, 'preload.js'))
console.log('[copy] electron-main.js + preload.js → dist/')

// 2. 与 cli dist 同构的资产（模板/技能/自包含 worker）
for (const asset of ['templates', 'skills', 'workers']) {
  const src = path.join(pkgDir, '../cli/dist', asset)
  mustExist(src, `cli dist 资产 ${asset}`)
  const n = copyDir(src, path.join(distDir, asset))
  console.log(`[copy] ${asset}: ${n} 个文件`)
}

// 3. 渲染器静态资产（vite 产物；electron-main 生产候选 web/web-dist）
const rendererSrc = path.join(pkgDir, '../cli/dist/web/web-dist')
mustExist(path.join(rendererSrc, 'index.html'), '渲染器 index.html')
const rendererCount = copyDir(rendererSrc, path.join(distDir, 'web', 'web-dist'))
console.log(`[copy] 渲染器 web-dist: ${rendererCount} 个文件`)

// 4. 逐字节断言：electron-main 内四处 npm 布局候选对应的文件必须真实在位
for (const probe of [
  'templates/builtin',
  'skills/builtin',
  'workers/GenericSubagentWorker.js',
  'web/web-dist/index.html',
  'electron-main.js',
  'preload.js',
]) {
  if (!fs.existsSync(path.join(distDir, probe))) {
    console.error(`[build] 断言失败: dist/${probe} 缺失（electron-main npm 布局候选将落空）`)
    process.exit(1)
  }
}
console.log('[build] 全档壳包 dist 装配完成')
