import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
export default defineConfig({
    plugins: [
        vue(),
        nodePolyfills({
            include: ['path', 'fs', 'os', 'child_process', 'stream', 'util', 'buffer', 'events', 'crypto', 'http', 'https'],
            globals: {
                process: true,
                Buffer: true,
            },
        }),
    ],
    root: 'packages/ui',
    resolve: {
        alias: {
            '@assistant-ai/core': resolve(__dirname, 'packages/core/src/index.renderer.ts'),
            '@assistant-ai/ui/adapters': resolve(__dirname, 'packages/ui/src/adapters/index.ts'),
        },
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
        // outDir 在 root（packages/ui）之外，vite 默认不清空，必须显式开启，
        // 否则带哈希的旧 bundle 无限累积（实测 34 个 bundle 占 75M，并被固化进每个 chill-versions 版本）
        emptyOutDir: true,
    },
});
