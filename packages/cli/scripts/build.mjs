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

  // guardian switcher（以 chill/ 为根的源码仓库不含它，位于其兄弟目录；npm 包内置于 guardian/）
  // 从包目录向上逐级查找：开发布局（chill/packages/cli）与版本快照布局（chill-versions/vX/packages/cli）层级不同，写死相对层级会在版本目录内构建时静默缺失
  let switcherSrc = null
  for (let dir = pkgDir; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'chill-guardian', 'switcher.js')
    if (fs.existsSync(candidate)) { switcherSrc = candidate; break }
  }
  if (switcherSrc) {
    const destDir = path.join(pkgDir, 'guardian')
    fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(switcherSrc, path.join(destDir, 'switcher.js'))
    console.log('[copy] guardian/switcher.js')
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
