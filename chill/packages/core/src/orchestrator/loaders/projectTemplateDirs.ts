/**
 * 项目级 Agent 模板目录枚举
 * 从 workDir 向上递归查找存在的 .agents/agents/ 目录
 */

import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import { findProjectAssetDirs } from '../../services/assets/assetDirectory'

/**
 * 从 workDir 向上递归枚举存在的 .agents/agents/ 目录
 * 实现收敛到通用资产目录服务 findProjectAssetDirs(与工作流共用一份逻辑)
 * @param fsProvider - 文件系统提供者
 * @param workDir - 起始工作目录
 * @returns 存在的模板目录，按"近→远"排序（workDir 本级在前，根目录在后）
 */
export async function findProjectTemplateDirs(
  fsProvider: IFileSystemProvider,
  workDir: string,
): Promise<string[]> {
  return findProjectAssetDirs(fsProvider, workDir, ['.agents', 'agents'])
}
