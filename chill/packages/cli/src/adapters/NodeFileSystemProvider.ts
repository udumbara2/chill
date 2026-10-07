/**
 * [M3 下沉兼容层] 实现已迁入 core（implementations/NodeFileSystemProvider.ts，
 * rule of three：CLI/Electron/daemon）。此文件保留 re-export，既有 import 路径零改动。
 */
export { NodeFileSystemProvider } from '@assistant-ai/core'
