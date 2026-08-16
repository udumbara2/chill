import type { ITemplateLoader } from '../interfaces/ITemplateLoader'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { SubagentTemplate } from './types'
import { parseTemplates } from './parsers/TemplateParser'

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
   * @param onErrors - 可选错误回调：解析失败/读取失败的明细（路径 + 原因）原样上抛，
   * 由壳层打印可见（此前错误被静默丢弃，写错的模板无人察觉）
   */
  async loadTemplatesFromDirectory(
    dir: string,
    onErrors?: (errors: string[]) => void
  ): Promise<SubagentTemplate[]> {
    const listResult = await this.fs.listDirectory(dir)
    if (!listResult.success || !listResult.data) {
      return []
    }

    const allFiles: Array<{ name: string; type: string }> = listResult.data.files || []
    const mdFiles = allFiles.filter((f) => f.name.endsWith('.md'))

    // 读取失败的文件如实报"读取失败"（不映射为空串——那会被解析成"缺少必填字段 name"的误导性报错）
    const errors: string[] = []
    const files: Array<{ content: string; path: string }> = []
    await Promise.all(
      mdFiles.map(async (f) => {
        const filePath = `${dir}/${f.name}`
        const readResult = await this.fs.readFile(filePath)
        if (readResult.success && readResult.data) {
          files.push({ content: readResult.data.content, path: filePath })
        } else {
          errors.push(`模板读取失败: ${filePath}${readResult.error ? `（${readResult.error}）` : ''}`)
        }
      })
    )

    const parsed = parseTemplates(files)
    errors.push(...parsed.errors)
    if (errors.length > 0) onErrors?.(errors)
    return parsed.templates
  }
}
