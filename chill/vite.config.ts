import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    vue(),
    nodePolyfills({
      // fs/child_process 不在此列：polyfill 垫片是 null 模块（dev 互操作读具名导入即炸），
      // 统一走 resolve.alias 的显式空 shim（core/src/shims/fsRenderer.ts、childProcessRenderer.ts）
      include: ['path', 'os', 'stream', 'util', 'buffer', 'events', 'crypto', 'http', 'https'],
      globals: {
        process: true,
        Buffer: true,
      },
    }),
  ],
  root: 'packages/ui',
  resolve: {
    alias: [
      { find: '@assistant-ai/core', replacement: resolve(__dirname, 'packages/core/src/index.renderer.ts') },
      { find: '@assistant-ai/ui/adapters', replacement: resolve(__dirname, 'packages/ui/src/adapters/index.ts') },
      // child_process / fs 显式空 shim（core/src/shims/*Renderer.ts）：polyfill 的 null 垫片在 dev 服务器
      // 互操作下读 .spawn 即炸；alias 优先于 polyfill，dev/prod 行为归一。
      // fs 家族必须正则精确锚：字符串键是前缀匹配——'node:fs' 会先命中 'node:fs/promises' 前缀
      // 并拼出 fsRenderer.ts/promises 的 ENOENT（实测 boardStore.ts 击穿）
      { find: /^node:child_process$/, replacement: resolve(__dirname, 'packages/core/src/shims/childProcessRenderer.ts') },
      { find: /^child_process$/, replacement: resolve(__dirname, 'packages/core/src/shims/childProcessRenderer.ts') },
      { find: /^node:fs\/promises$/, replacement: resolve(__dirname, 'packages/core/src/shims/fsPromisesRenderer.ts') },
      { find: /^fs\/promises$/, replacement: resolve(__dirname, 'packages/core/src/shims/fsPromisesRenderer.ts') },
      { find: /^node:fs$/, replacement: resolve(__dirname, 'packages/core/src/shims/fsRenderer.ts') },
      { find: /^fs$/, replacement: resolve(__dirname, 'packages/core/src/shims/fsRenderer.ts') },
    ],
  },
  server: {
    port: 5173,
    host: true
  },
  base: './',
  build: {
    outDir: '../dist',
    assetsDir: 'assets',
    sourcemap: false,
    // 多页入口（WebUI 规划 M1.4）：index.html=Electron 渲染层；web.html=Web 壳入口
    // （连接 WS → 安装 HostAPI → 动态 import 同一份 main——与桌面共用全部 chunk）
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'packages/ui/index.html'),
        web: resolve(__dirname, 'packages/ui/web.html'),
      },
    },
    // outDir 在 root（packages/ui）之外，vite 默认不清空，必须显式开启，
    // 否则带哈希的旧 bundle 无限累积（实测 34 个 bundle 占 75M，并被固化进每个 chill-versions 版本）
    emptyOutDir: true,
  },
})
