/**
 * 命名工作流模板服务
 *
 * 职责:从用户级(~/.chill/workflows/)与项目级(.agents/workflows/,向上递归)目录
 * 加载 YAML 工作流定义,按"项目 > 用户"优先级合并,同名项目级覆盖用户级。
 * 非法文件不静默跳过——错误带路径与原因对外可见(getErrors)。
 * 热生效由壳层 watcher 调用 reload() 完成(core 不含 watcher,与模板系统同构)。
 */

import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import { scanAssetFiles, findProjectAssetDirs, mergeAssetLayers } from '../assets/assetDirectory'
import { parseWorkflowDefinition } from '../../workflow/dsl/workflowParser'
import type { WorkflowDefinition } from '../../workflow/dsl/types'

export const WORKFLOW_FILE_EXTENSION = '.yaml'
export const WORKFLOW_PROJECT_DIR_SEGMENTS = ['.agents', 'workflows']

export class WorkflowTemplateService {
  private fs: IFileSystemProvider
  private userDir: string
  private workflows: Map<string, WorkflowDefinition> = new Map()
  private errors: string[] = []
  private warnings: string[] = []
  private infos: string[] = []
  private initialized = false

  constructor(fs: IFileSystemProvider, userDir: string) {
    this.fs = fs
    this.userDir = userDir
  }

  /** 更新用户级目录(异步获取目录路径的场景,如 Electron 渲染进程) */
  setUserDir(dir: string): void {
    this.userDir = dir
  }

  async initialize(workDir?: string): Promise<void> {
    await this.reload(workDir)
    this.initialized = true
  }

  /** 全量重扫(watcher 热生效入口) */
  async reload(workDir?: string): Promise<void> {
    const errors: string[] = []
    const warnings: string[] = []
    const infos: string[] = []

    const userResult = await scanAssetFiles(this.fs, this.userDir, WORKFLOW_FILE_EXTENSION)
    errors.push(...userResult.errors)
    const userWorkflows = this.parseAll(userResult.files, 'user', errors, warnings, infos)

    let projectWorkflows: WorkflowDefinition[] = []
    if (workDir) {
      const projectDirs = await findProjectAssetDirs(this.fs, workDir, WORKFLOW_PROJECT_DIR_SEGMENTS)
      // 近者优先:远→近依次放入,近者覆盖远者
      for (const dir of [...projectDirs].reverse()) {
        const result = await scanAssetFiles(this.fs, dir, WORKFLOW_FILE_EXTENSION)
        errors.push(...result.errors)
        projectWorkflows.push(...this.parseAll(result.files, 'project', errors, warnings, infos))
      }
    }

    const merged = mergeAssetLayers([userWorkflows, projectWorkflows], (w) => w.name)
    this.workflows = new Map(merged.map((w) => [w.name, w]))
    this.errors = errors
    this.warnings = warnings
    this.infos = infos
  }

  private parseAll(
    files: Array<{ content: string; path: string }>,
    scope: 'user' | 'project',
    errors: string[],
    warnings: string[],
    infos: string[],
  ): WorkflowDefinition[] {
    const definitions: WorkflowDefinition[] = []
    for (const file of files) {
      const result = parseWorkflowDefinition(file.content, file.path)
      if (result.success && result.definition) {
        definitions.push({ ...result.definition, sourcePath: file.path, scope })
        if (result.warnings) warnings.push(...result.warnings)
        if (result.infos) infos.push(...result.infos)
      } else {
        errors.push(result.error ?? `未知解析错误: ${file.path}`)
      }
    }
    return definitions
  }

  getAllWorkflows(): WorkflowDefinition[] {
    return Array.from(this.workflows.values())
  }

  getWorkflowByName(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name)
  }

  /** 加载/解析错误(非法文件"带原因可见") */
  getErrors(): string[] {
    return [...this.errors]
  }

  /** 行为相关警告(有损/可能与预期不同;UI 可见) */
  getWarnings(): string[] {
    return [...this.warnings]
  }

  /** 卫生通知(无损归一化;仅日志,不上 UI) */
  getInfos(): string[] {
    return [...this.infos]
  }

  isInitialized(): boolean {
    return this.initialized
  }
}
