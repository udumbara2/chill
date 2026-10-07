/**
 * [M3 下沉兼容层] 实现已迁入 core（implementations/NodeFileSystemProvider.ts，
 * rule of three：CLI/Electron/daemon）。此文件保留 re-export，既有 import 路径零改动；
 * core 版为合并超集（较本仓原版新增 renameFile/watch，纯增量不破坏现行为）。
 */
export { NodeFileSystemProvider } from '@assistant-ai/core'
