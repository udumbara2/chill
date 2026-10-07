/**
 * 渲染端 fs 空 shim（与 nativeFetch.ts / childProcessRenderer.ts 同家族）。
 * 渲染进程无真实文件系统：fs 访问一律经 IFileSystemProvider（Electron IPC 到主进程）。
 * 必须显式 alias（vite.config）：vite-plugin-node-polyfills 的 fs 垫片是 null 模块
 * （node-stdlib-browser mock/empty.js = module.exports = null），
 * dev 服务器互操作对具名导入（如 createWriteStream）读 null 属性即炸；alias 优先于 polyfill。
 * 导出名清单 = core 渲染面全部具名导入的并集（grep 实测）；命名导出 undefined 而非空对象，
 * 使 dev 具名导入可解析、prod rollup 具名导出检查通过。
 * 渲染端运行时若真调到这些函数，行为与 null 垫片时代一致：undefined 不可调用（本来就不该调到）。
 */
export const appendFileSync = undefined
export const chmodSync = undefined
export const copyFileSync = undefined
export const createReadStream = undefined
export const createWriteStream = undefined
export const existsSync = undefined
export const mkdirSync = undefined
export const mkdtempSync = undefined
export const readFileSync = undefined
export const readdirSync = undefined
export const renameSync = undefined
export const rmSync = undefined
export const statSync = undefined
export const unlinkSync = undefined
export const watch = undefined
export const writeFileSync = undefined
export const promises = undefined
export default {}
