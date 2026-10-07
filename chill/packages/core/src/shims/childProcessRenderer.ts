/**
 * 渲染端 child_process 空 shim（与 nativeFetch.ts 同家族）。
 * 渲染进程无子进程能力：命令执行走 codeExecutor IPC 到主进程、hooks 走 ElectronIPCHookProcessRunner；
 * 本 shim 仅为消解 core 模块（builtInToolExecutor 等）的顶层具名 import。
 * 必须显式 alias（vite.config）：vite-plugin-node-polyfills 的 child_process 垫片是 null 模块，
 * dev 服务器 esbuild 互操作对 null 读 .spawn 直接炸（生产 rollup 宽容，故仅 dev 崩）。
 * 渲染端运行时若真调到这些函数（如 trigger_guardian 的 spawn），行为与 null 垫片一致：undefined 不可调用。
 */
export const spawn = undefined
export const spawnSync = undefined
export const exec = undefined
export const execSync = undefined
export const execFile = undefined
export const execFileSync = undefined
export const fork = undefined
export default {}
