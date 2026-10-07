/**
 * 渲染端 fs/promises 空 shim（与 fsRenderer.ts / childProcessRenderer.ts 同家族）。
 * 渲染进程无真实文件系统：fs 访问一律经 IFileSystemProvider（Electron IPC 到主进程）。
 * 必须显式 alias（vite.config 的 'fs/promises' 与 'node:fs/promises'）：未 alias 时
 * vite 会把子路径解析成 fsRenderer.ts/promises 直接 ENOENT（实测 boardStore.ts 击穿）。
 * 导出名清单 = core 渲染面全部具名导入的并集（grep 实测：boardStore 静态五名 +
 * TemplateSubagentForkManager 动态 import 后 mkdir/rm）；命名导出 undefined 而非空对象，
 * 与 fsRenderer 先例一致：dev 具名导入可解析、prod rollup 具名导出检查通过；
 * 渲染端运行时若真调到这些函数，undefined 不可调用（本来就不该调到）。
 */
export const access = undefined
export const mkdir = undefined
export const readFile = undefined
export const rename = undefined
export const rm = undefined
export const writeFile = undefined
export default {}
