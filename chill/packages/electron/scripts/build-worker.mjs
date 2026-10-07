#!/usr/bin/env node
/**
 * Subagent Worker 自包含打包（T9）
 *
 * 问题：extraResources 只带 core/dist 的 workers 目录 3 个文件，而 tsc 版
 * GenericSubagentWorker.js 的相对 import 指向目录外（../types.js、../../../services/...），
 * 生产包内解析不到（已实证 ERR_MODULE_NOT_FOUND）。
 *
 * 方案：与 T8 CLI 同法，esbuild 把 worker 打成自包含 ESM bundle，
 * 落到 packages/electron/resources/workers/，随 electron-builder extraResources 进安装包。
 * 附带 workers/package.json（type:module）——child_process.fork 按最近 package.json
 * 判定模块类型，resources/ 下无其他 package.json，必须显式声明 ESM。
 *
 * 用法：node scripts/build-worker.mjs（electron build 链路调用；monorepo dev 走
 * workerPaths 的 src/.ts 候选，不依赖本产物，两形态共存）
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(pkgDir, 'resources/workers')

await build({
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  external: ['tsx'],
  // node-fetch v2 → 原生 fetch 替身（消除 DEP0040/DEP0169，与 CLI 同法）
  alias: { 'node-fetch': path.resolve(pkgDir, '../core/src/shims/nativeFetch.ts') },
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __chillCreateRequire } from 'node:module'; const require = __chillCreateRequire(import.meta.url);",
  },
  entryPoints: [path.join(pkgDir, '../core/src/orchestrator/isolation/workers/GenericSubagentWorker.ts')],
  outfile: path.join(outDir, 'GenericSubagentWorker.js'),
})

// fork() 按最近 package.json 判定 .js 模块类型；resources/workers 下必须显式 ESM
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')
console.log(`[build-worker] 自包含 worker 已产出: ${outDir}`)
