/**
 * [M3.7 下沉兼容层] 本实现已迁入 core（services/hooks/nodeHookProcessRunner.ts，
 * rule of three：CLI/Electron/daemon 三消费者）。此文件保留 re-export，
 * cli 内既有 import 路径零改动。
 */
export { NodeHookProcessRunner, expandHomeCommand } from '@assistant-ai/core'
