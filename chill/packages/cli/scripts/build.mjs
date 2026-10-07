#!/usr/bin/env node
/**
 * CLI 打包脚本（T8）：esbuild 三入口 + 资源复制
 *
 * 产物（dist/）：
 * - dist/bootstrap.js                    薄启动器（独立小入口；读指针决定委托或运行包内 cli.js）
 * - dist/cli.js                          主 bundle（cli.ts + @assistant-ai/core 全量内联，npm 独立运行）
 * - dist/workers/GenericSubagentWorker.js 自包含 Subagent worker（旧布局依赖整个 core dist 树，不可独立发布）
 * 复制：
 * - core templates → dist/templates/builtin（模板 md，TemplateManager 的 FileSystemTemplateLoader 源）
 * - core skills    → dist/skills/builtin（修复：此前从未进包，npm 模式 skill-creator 静默缺失）
 * - chill-guardian/switcher.js → guardian/（缺失仅警告：/fetch-source 的版本切换降级不可用）
 *
 * 用法：node scripts/build.mjs [--watch]
 *   --watch 开发监听：三入口增量重建（复制步骤只在启动时执行一次）
 */
import { build, context } from 'esbuild'
import { spawnSync } from 'node:child_process' // builtin：快照树同样可用（非兄弟包相对导入）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',          // 包 "type": "module"，CJS 会与 .js 后缀冲突
  target: 'node18',       // 对齐 electron 的 bundle 目标
  external: ['tsx', 'react-devtools-core', '@assistant-ai/native-desktop'],      // tsx: TemplateSubagentForkManager 运行时 require.resolve('tsx/cli');react-devtools-core: ink 仅 DEV=true 时动态加载,生产不执行,留为运行时可选 require;@assistant-ai/native-desktop: napi 原生模块(.node 不可 bundle),运行时经 createRequire 懒加载
  // node-fetch v2（openai shim 静态依赖）整体替换为原生 fetch 替身：
  // 消除 punycode DEP0040 / url.parse DEP0169 警告并瘦身 bundle
  alias: { 'node-fetch': path.resolve(pkgDir, '../core/src/shims/nativeFetch.ts') },
  logLevel: 'info',
  // core 依赖图中存在无法静态分析的动态 require（CJS 依赖），ESM 输出下经 createRequire 兜底
  banner: {
    js: "import { createRequire as __chillCreateRequire } from 'node:module'; const require = __chillCreateRequire(import.meta.url);",
  },
}

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: [path.join(pkgDir, 'src/bootstrap.ts')],
    outfile: path.join(pkgDir, 'dist/bootstrap.js'),
    // 薄启动器保持小入口：npm 模式回退运行时经 import('./cli.js') 加载主 bundle，不内联
    external: [...common.external, './cli.js'],
  },
  // 主 bundle 启用分包:TUI 壳(ink/react)经动态 import 进入懒加载 chunk,
  // 纯 CLI / -p / 非 TTY 路径不加载,启动解析量与分包前一致(原则 2)
  { ...common, entryPoints: [path.join(pkgDir, 'src/cli.ts')], outdir: path.join(pkgDir, 'dist'), splitting: true, outExtension: { '.js': '.js' } },
  {
    ...common,
    entryPoints: [path.join(pkgDir, '../core/src/orchestrator/isolation/workers/GenericSubagentWorker.ts')],
    outfile: path.join(pkgDir, 'dist/workers/GenericSubagentWorker.js'),
  },
]

/** 递归复制目录（filter 过滤文件名；缺省全量） */
function copyDir(src, dest, filter) {
  if (!fs.existsSync(src)) return 0
  let count = 0
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      count += copyDir(s, d, filter)
    } else if (!filter || filter(entry.name)) {
      fs.copyFileSync(s, d)
      count++
    }
  }
  return count
}

// 递归删除（lstatSync+unlinkSync+rmdirSync 手写递归）。
// 禁用 fs.rmSync：本机 Node 24 在含非 ASCII 字符（如「助手」）的路径下静默失败
// （见 guardian/switcher.js:171-173 的实证注释）；本函数与 chill-guardian/freeze.js 同款。
function removeRecursive(p) {
  let stat
  try { stat = fs.lstatSync(p) } catch { return }
  if (stat.isSymbolicLink()) { fs.rmdirSync(p); return }
  if (!stat.isDirectory()) { fs.unlinkSync(p); return }
  for (const name of fs.readdirSync(p)) removeRecursive(path.join(p, name))
  fs.rmdirSync(p)
}

function copyAssets() {
  // 内置模板（.md）
  const templates = copyDir(
    path.join(pkgDir, '../core/src/orchestrator/templates/builtin'),
    path.join(pkgDir, 'dist/templates/builtin'),
    (name) => name.endsWith('.md')
  )
  console.log(`[copy] templates: ${templates} 个文件`)

  // 内置技能（全量；self-iterate 的 npm 模式过滤在 core 注册表编排处按规则处理）
  const skills = copyDir(
    path.join(pkgDir, '../core/src/skills/builtin'),
    path.join(pkgDir, 'dist/skills/builtin')
  )
  console.log(`[copy] skills: ${skills} 个文件`)

  // 桌面原生模块（npm 分发：.node 与 napi 加载器随包携带，files 已含 dist）
  // index.js → dist/native-desktop.cjs（**.cjs 后缀强制 CJS**——cli 包 type:module，.js 会被当 ESM
  // 导致 napi 加载器内部的相对 require 失去模块上下文而解析失败；加载器内部按相对路径 require 同目录 .node）
  const nativeDir = path.join(pkgDir, '../native-desktop')
  let nativeCount = 0
  if (fs.existsSync(nativeDir)) {
    const distDir = path.join(pkgDir, 'dist')
    fs.mkdirSync(distDir, { recursive: true })
    const indexSrc = path.join(nativeDir, 'index.js')
    if (fs.existsSync(indexSrc)) {
      fs.copyFileSync(indexSrc, path.join(distDir, 'native-desktop.cjs'))
      nativeCount++
    }
    for (const f of fs.readdirSync(nativeDir)) {
      if (f.endsWith('.node')) {
        fs.copyFileSync(path.join(nativeDir, f), path.join(distDir, f))
        nativeCount++
      }
    }
  }
  console.log(`[copy] native-desktop: ${nativeCount} 个文件${nativeCount === 0 ? '（警告：未找到原生模块，桌面能力在 npm 包内不可用）' : ''}`)

  // 隐私内联复检：dist 里的 .node 必须零命中构建机路径。
  // 惰性挂接：仅当兄弟包在场（nativeCount > 0）才解析并调用校验器——严禁顶层
  // 静态 import 校验器（相对路径），快照树（无 native-desktop 兄弟包）会在模块
  // 加载期崩溃；spawnSync 子进程形态天然惰性。校验器缺失 = 仓库残缺，硬失败。
  if (nativeCount > 0) {
    const verifier = path.join(pkgDir, '../native-desktop/scripts/verify-native.mjs')
    if (!fs.existsSync(verifier)) {
      console.error(`[copy] 错误: 找到原生模块但缺少隐私校验器 ${verifier}（仓库残缺），终止构建`)
      process.exit(1)
    }
    const r = spawnSync(process.execPath, [verifier, path.join(pkgDir, 'dist')], { stdio: 'inherit' })
    if (r.status !== 0) {
      console.error('[copy] 隐私守卫阻断: dist 内 .node 含构建机路径信息，终止构建')
      process.exit(1)
    }
  }

  // chill Web daemon + 前端静态资产（M5.5：web dist 整树进包——chill web 子命令运行
  // dist/web/serve.js，daemon 静态双候选探测 dist/web/web-dist/。缺失仅警告降级）
  const webDist = path.join(pkgDir, '../web/dist')
  if (fs.existsSync(path.join(webDist, 'serve.js'))) {
    const webDest = path.join(pkgDir, 'dist', 'web')
    removeRecursive(webDest)
    copyDir(webDist, webDest)
    console.log('[copy] web daemon → dist/web/（含 Worker；chill web 子命令）')
  } else {
    console.warn('[copy] 警告: packages/web/dist 未构建（chill web 将不可用；跑 pnpm --filter @assistant-ai/web build）')
  }
  const uiDist = path.join(pkgDir, '../dist')
  if (fs.existsSync(path.join(uiDist, 'web.html'))) {
    const webStaticDest = path.join(pkgDir, 'dist', 'web', 'web-dist')
    removeRecursive(webStaticDest)
    copyDir(uiDist, webStaticDest)
    console.log('[copy] 前端 web-dist → dist/web/web-dist/')
  } else {
    console.warn('[copy] 警告: packages/dist 未含 web.html（chill web 无页面；跑 pnpm build:renderer）')
  }

  // guardian 工具（以 chill/ 为根的源码仓库不含它们，位于其兄弟目录；npm 包内置于 guardian/）
  // 从包目录向上逐级查找：开发布局（chill/packages/cli）与版本快照布局（chill-versions/vX/packages/cli）层级不同，写死相对层级会在版本目录内构建时静默缺失
  // switcher.js=版本切换；mobile-freeze.js=手机端自迭代快照锚点；mobile-push.js=手机端远程推送（缺失仅对应功能降级）
  let guardianSrcDir = null
  for (let dir = pkgDir; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'chill-guardian')
    if (fs.existsSync(path.join(candidate, 'switcher.js'))) { guardianSrcDir = candidate; break }
  }
  // guardian/ 在 files 白名单内且不随构建重建——复制前先整目录清扫（重建即真相），
  // 复制后断言内容恰为 switcher.js + mobile-freeze.js：白名单路径上的任何多余文件都不得进入 tarball。
  const guardianDir = path.join(pkgDir, 'guardian')
  if (fs.existsSync(guardianDir)) removeRecursive(guardianDir)
  if (guardianSrcDir) {
    fs.mkdirSync(guardianDir, { recursive: true })
    fs.copyFileSync(path.join(guardianSrcDir, 'switcher.js'), path.join(guardianDir, 'switcher.js'))
    const freezeSrc = path.join(guardianSrcDir, 'mobile-freeze.js')
    if (fs.existsSync(freezeSrc)) fs.copyFileSync(freezeSrc, path.join(guardianDir, 'mobile-freeze.js'))
    else console.warn('[copy] 警告: chill-guardian/ 缺 mobile-freeze.js，跳过复制（手机端自迭代将不可用）')
    const pushSrc = path.join(guardianSrcDir, 'mobile-push.js')
    if (fs.existsSync(pushSrc)) fs.copyFileSync(pushSrc, path.join(guardianDir, 'mobile-push.js'))
    else console.warn('[copy] 警告: chill-guardian/ 缺 mobile-push.js，跳过复制（手机端远程推送将不可用）')
    const allowed = ['switcher.js', 'mobile-freeze.js', 'mobile-push.js']
    const leftovers = fs.readdirSync(guardianDir).filter((f) => !allowed.includes(f))
    if (leftovers.length > 0) {
      console.error(`[copy] 错误: guardian/ 清扫后仍有残留（${leftovers.join(', ')}），终止构建`)
      process.exit(1)
    }
    console.log('[copy] guardian/switcher.js（+mobile-freeze.js+mobile-push.js）（目录已清扫 + 内容断言通过）')
  } else {
    console.warn('[copy] 警告: 向上未找到 chill-guardian/switcher.js，跳过复制（/fetch-source 的版本切换将不可用）')
  }
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => context(b)))
  copyAssets()
  await Promise.all(contexts.map((c) => c.rebuild()))
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[watch] 开发监听中（三入口增量重建；资源复制仅在启动时执行）…')
} else {
  for (const b of builds) {
    await build(b)
  }
  copyAssets()
  console.log('[build] 三入口打包 + 资源复制完成')
}
