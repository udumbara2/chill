/**
 * packages/web 构建脚本（WebUI 规划 M1.1）：esbuild 单入口
 *
 * 产物（dist/）：
 * - dist/serve.js   daemon 主 bundle（serve.ts + core 全量内联；ws 为运行时依赖不内联）
 *
 * 前端静态资产不拷贝：daemon 直接服务 UI 构建产物目录 packages/dist（开发形态），
 * 打包形态（M5.5）服务包内 web-dist——serve.ts 双候选探测。这样规避 Node 24 在
 * 含非 ASCII 路径（助手）下递归 fs 操作（rmSync/cpSync 均实测 0xC0000409 fail-fast）。
 *
 * 打包配方照抄 cli/scripts/build.mjs 先例（nativeFetch 别名 / createRequire banner）。
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [path.join(pkgDir, 'src/serve.ts')],
  outfile: path.join(pkgDir, 'dist/serve.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['ws', 'tsx', '@assistant-ai/native-desktop'],
  alias: { 'node-fetch': path.resolve(pkgDir, '../core/src/shims/nativeFetch.ts') },
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __chillCreateRequire } from 'node:module'; const require = __chillCreateRequire(import.meta.url);",
  },
})

// M4.1：自包含 Subagent Worker（fork 网关的子进程脚本——cli 同款入口）
await build({
  entryPoints: [path.join(pkgDir, '../core/src/orchestrator/isolation/workers/GenericSubagentWorker.ts')],
  outfile: path.join(pkgDir, 'dist/workers/GenericSubagentWorker.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['tsx', '@assistant-ai/native-desktop'],
  alias: { 'node-fetch': path.resolve(pkgDir, '../core/src/shims/nativeFetch.ts') },
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __chillCreateRequire } from 'node:module'; const require = __chillCreateRequire(import.meta.url);",
  },
})

console.log('[build] daemon bundle + worker 完成')
