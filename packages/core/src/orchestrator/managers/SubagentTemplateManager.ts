import type { SubagentTemplate, TemplatePriority, PriorityScope, TemplateType } from '../types'
import { getBuiltinTemplates } from '../templates/builtin'
import type { ITemplateLoader } from '../../interfaces/ITemplateLoader'

export class SubagentTemplateManager {
  private templateLoader?: ITemplateLoader

  private builtinTemplates: SubagentTemplate[] = []

  /** 用户级模板（个人目录，~/.chill/agents/templates/） */
  private userTemplates: SubagentTemplate[] = []

  /** 项目级模板（项目 .agents/agents/，向上递归各级由调用方拼好传入） */
  private projectTemplates: SubagentTemplate[] = []

  private remoteTemplates: SubagentTemplate[] = []

  private allTemplates: Map<string, SubagentTemplate> = new Map()

  private initialized = false

  constructor(templateLoader?: ITemplateLoader) {
    this.templateLoader = templateLoader
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    this.builtinTemplates = await getBuiltinTemplates(this.templateLoader)

    this.mergeTemplates()

    this.initialized = true
  }

  getBuiltinTemplates(): SubagentTemplate[] {
    return [...this.builtinTemplates]
  }

  getAllTemplates(): SubagentTemplate[] {
    return Array.from(this.allTemplates.values())
  }

  getTemplateByType(subagentType: string): SubagentTemplate | undefined {
    return this.allTemplates.get(subagentType)
  }

  /**
   * 合并模板：remote → builtin → user → project 依次 set 覆盖
   * 同名冲突时项目 > 用户 > 内置 > 远程（与 TemplatePriority 数值小者胜一致）
   * 同层数组内同名按数组顺序后者覆盖
   */
  private mergeTemplates(): void {
    this.allTemplates.clear()

    for (const template of this.remoteTemplates) {
      this.allTemplates.set(template.subagent_type, template)
    }

    for (const template of this.builtinTemplates) {
      this.allTemplates.set(template.subagent_type, template)
    }

    for (const template of this.userTemplates) {
      this.allTemplates.set(template.subagent_type, template)
    }

    for (const template of this.projectTemplates) {
      this.allTemplates.set(template.subagent_type, template)
    }
  }

  getRemoteTemplates(): SubagentTemplate[] {
    return [...this.remoteTemplates]
  }

  /**
   * 设置自定义模板（替换式，供扫描器/watcher 调用）
   * 赋值时按目录来源统一规范化：type 一律 custom，
   * priority 用户=2(USER)/项目=1(PROJECT)，priority_scope 同步为 user/project
   * @param userTemplates - 用户级模板数组
   * @param projectTemplates - 项目级模板数组
   */
  setCustomTemplates(
    userTemplates: SubagentTemplate[],
    projectTemplates: SubagentTemplate[],
  ): void {
    this.userTemplates = userTemplates.map((t) =>
      this.normalizeCustomTemplate(t, 2 as TemplatePriority.USER, 'user' as PriorityScope.USER),
    )
    this.projectTemplates = projectTemplates.map((t) =>
      this.normalizeCustomTemplate(t, 1 as TemplatePriority.PROJECT, 'project' as PriorityScope.PROJECT),
    )
    this.mergeTemplates()
  }

  /** 规范化目录来源模板：返回新对象，不修改入参 */
  private normalizeCustomTemplate(
    template: SubagentTemplate,
    priority: TemplatePriority,
    scope: PriorityScope,
  ): SubagentTemplate {
    return { ...template, type: 'custom' as TemplateType.CUSTOM, priority, priority_scope: scope }
  }

  clearRemoteTemplates(): void {
    this.remoteTemplates = []
    this.mergeTemplates()
  }

  registerRemoteTemplate(template: SubagentTemplate): void {
    this.remoteTemplates.push(template)
    this.mergeTemplates()
  }

  unregisterRemoteTemplate(subagentType: string): void {
    this.remoteTemplates = this.remoteTemplates.filter(
      (t) => t.subagent_type !== subagentType
    )
    this.mergeTemplates()
  }

  resetRemoteTemplates(templates: SubagentTemplate[]): void {
    this.remoteTemplates = [...templates]
    this.mergeTemplates()
  }

  setAllTemplates(templates: SubagentTemplate[]): void {
    this.allTemplates.clear()
    for (const template of templates) {
      this.allTemplates.set(template.subagent_type, template)
    }
  }
}

let globalTemplateManager: SubagentTemplateManager | null = null

export function getTemplateManager(): SubagentTemplateManager {
  if (!globalTemplateManager) {
    globalTemplateManager = new SubagentTemplateManager()
  }
  return globalTemplateManager
}

export function createTemplateManager(
  templateLoader: ITemplateLoader
): SubagentTemplateManager {
  const manager = new SubagentTemplateManager(templateLoader)
  globalTemplateManager = manager
  return manager
}

export function resetTemplateManager(): void {
  globalTemplateManager = null
}
