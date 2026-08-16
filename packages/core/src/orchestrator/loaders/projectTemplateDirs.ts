/**
 * 项目级 Agent 模板目录枚举
 * 从 workDir 向上递归查找存在的 .agents/agents/ 目录
 */

import { dirname, join, resolve as resolvePath } from 'path'
import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'

/**
 * 从 workDir 向上递归枚举存在的 .agents/agents/ 目录
 * 参照 SkillLoader.scanProjectLevels 的向上递归模式
 * @param fsProvider - 文件系统提供者
 * @param workDir - 起始工作目录
 * @returns 存在的模板目录，按"近→远"排序（workDir 本级在前，根目录在后）
 */
export async function findProjectTemplateDirs(
  fsProvider: IFileSystemProvider,
  workDir: string,
): Promise<string[]> {
  const dirs: string[] = []

  let currentDir = resolvePath(workDir)
  const rootPath = resolvePath('/') // Windows上为盘符根

  while (currentDir.length >= rootPath.length) {
    const agentsDir = join(currentDir, '.agents', 'agents')
    // fileExists 契约:data 一律为 boolean(见 IFileSystemProvider)
    const result = await fsProvider.fileExists(agentsDir)
    if (result?.success && result.data === true) {
      dirs.push(agentsDir)
    }

    // 到达根目录，停止
    const parent = dirname(currentDir)
    if (parent === currentDir) break
    currentDir = parent
  }

  return dirs
}
