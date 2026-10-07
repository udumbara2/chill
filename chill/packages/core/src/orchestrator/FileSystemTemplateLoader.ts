import type { ITemplateLoader } from '../interfaces/ITemplateLoader'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { SubagentTemplate } from './types'
import { parseTemplates } from './parsers/TemplateParser'
import { scanAssetFiles } from '../services/assets/assetDirectory'

export class FileSystemTemplateLoader implements ITemplateLoader {
  private fs: IFileSystemProvider
  private templatesDir: string

  constructor(fs: IFileSystemProvider, templatesDir: string) {
    this.fs = fs
    this.templatesDir = templatesDir
  }

  async loadBuiltinTemplates(): Promise<SubagentTemplate[]> {
    return this.loadTemplatesFromDirectory(this.templatesDir)
  }

  /**
   * 扫描指定目录下的所有 .md 模板文件并解析为模板数组
   * 目录不存在或读取失败时返回空数组，单个文件解析失败跳过不中断
   * @param onErrors - 可选回调：解析失败明细（errors）、行为相关警告（warnings，UI 可见）、
   * 卫生通知（infos，无损归一化，仅日志）原样上抛，由壳层打印可见
   */
  async loadTemplatesFromDirectory(
    dir: string,
    onErrors?: (errors: string[], warnings: string[], infos: string[]) => void
  ): Promise<SubagentTemplate[]> {
    // 目录扫描与读入收敛到通用资产目录服务(与工作流共用一份逻辑)
    const { files, errors } = await scanAssetFiles(this.fs, dir, '.md', '模板')
    const parsed = parseTemplates(files)
    errors.push(...parsed.errors)
    if (errors.length > 0 || parsed.warnings.length > 0 || parsed.infos.length > 0)
      onErrors?.(errors, parsed.warnings, parsed.infos)
    return parsed.templates
  }
}
