/**
 * 通用资产目录服务
 *
 * 从模板系统(FileSystemTemplateLoader / SubagentTemplateManager / projectTemplateDirs)
 * 抽取的公共逻辑:目录扫描、项目级目录向上递归、按层级优先级合并、错误可见。
 * 单 Agent 模板(.md)与命名工作流(.yaml)共用这一份,不再各抄一份。
 */

import { dirname, join, resolve as resolvePath } from 'path'
import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'

export interface AssetFile {
  content: string
  path: string
}

/**
 * 扫描目录下指定扩展名的文件并读入内容
 * 目录不存在/读取失败返回空数组;单个文件读取失败记入 errors(不静默丢弃)
 */
export async function scanAssetFiles(
  fs: IFileSystemProvider,
  dir: string,
  extension: string,
  label: string = '资产文件',
): Promise<{ files: AssetFile[]; errors: string[] }> {
  const listResult = await fs.listDirectory(dir)
  if (!listResult.success || !listResult.data) {
    return { files: [], errors: [] }
  }

  const allFiles: Array<{ name: string; type: string }> = listResult.data.files || []
  const matched = allFiles.filter((f) => f.name.endsWith(extension))

  const errors: string[] = []
  const files: AssetFile[] = []
  await Promise.all(
    matched.map(async (f) => {
      const filePath = `${dir}/${f.name}`
      const readResult = await fs.readFile(filePath)
      if (readResult.success && readResult.data) {
        files.push({ content: readResult.data.content, path: filePath })
      } else {
        errors.push(`${label}读取失败: ${filePath}${readResult.error ? `(${readResult.error})` : ''}`)
      }
    }),
  )
  return { files, errors }
}

/**
 * 从 workDir 向上递归枚举存在的资产目录
 * @param segments - 相对路径段,如 ['.agents', 'agents'] 或 ['.agents', 'workflows']
 * @returns 存在的目录,按"近→远"排序(近者优先级高)
 */
export async function findProjectAssetDirs(
  fsProvider: IFileSystemProvider,
  workDir: string,
  segments: string[],
): Promise<string[]> {
  const dirs: string[] = []
  let currentDir = resolvePath(workDir)
  const rootPath = resolvePath('/')

  while (currentDir.length >= rootPath.length) {
    const assetDir = join(currentDir, ...segments)
    const result = await fsProvider.fileExists(assetDir)
    if (result?.success && result.data === true) {
      dirs.push(assetDir)
    }
    const parent = dirname(currentDir)
    if (parent === currentDir) break
    currentDir = parent
  }
  return dirs
}

/**
 * 按层级合并资产:layers 按优先级从低到高排列,同名(key)高层覆盖低层
 * 同层数组内同名按数组顺序后者覆盖
 */
export function mergeAssetLayers<T>(layers: T[][], key: (item: T) => string): T[] {
  const merged = new Map<string, T>()
  for (const layer of layers) {
    for (const item of layer) {
      merged.set(key(item), item)
    }
  }
  return Array.from(merged.values())
}
