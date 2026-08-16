/**
 * Worker 路径工具
 * 用于获取 Worker 脚本路径
 * 注意：此文件在主进程中使用，不在 Worker 中使用
 */

import path from 'path'
import { existsSync } from 'node:fs'

let customWorkerScriptPath: string | null = null

export function setWorkerScriptPath(path: string): void {
  customWorkerScriptPath = path
}

export function getWorkerScriptPath(): string {
  if (customWorkerScriptPath) {
    return customWorkerScriptPath
  }

  const isProduction = process.env.NODE_ENV === 'production'
  const resourcesPath = (process as any).resourcesPath

  if (isProduction) {
    return path.join(resourcesPath, 'workers', 'GenericSubagentWorker.js')
  }

  const monorepoRoot = process.cwd()
  const tsPath = path.join(
    monorepoRoot,
    'packages',
    'core',
    'src',
    'orchestrator',
    'isolation',
    'workers',
    'GenericSubagentWorker.ts'
  )

  if (existsSync(tsPath)) {
    return tsPath
  }

  return path.join(resourcesPath, 'workers', 'GenericSubagentWorker.js')
}
