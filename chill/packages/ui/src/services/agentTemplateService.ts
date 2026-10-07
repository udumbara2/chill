import {
  FileSystemTemplateLoader,
  findProjectTemplateDirs,
  getTemplateManager,
  TemplateType,
  TemplatePriority,
  PriorityScope,
  type SubagentTemplate,
} from '@assistant-ai/core'
import { ElectronIPCFileSystemProvider } from '@assistant-ai/ui/adapters'

/**
 * UI 侧 Agent 模板服务（单点持有 fsProvider/loader 与项目级模板缓存）。
 *
 * 渲染进程硬约束：getTemplateManager() 是懒建裸实例，分层数组恒为空，
 * 不能调用 setCustomTemplates 等任何触发 mergeTemplates() 的方法（会清空 IPC 灌入的模板）。
 * 因此项目级模板只能在 manager 外与主进程基础模板（remote+builtin+user 合并结果）拼接，
 * 再 setAllTemplates 整体回写渲染进程 manager 副本（委派指南与 ModeSelector 前台候选由此刷新）。
 *
 * 生效时机：项目级在会话启动 / workDir 变更（chatEngine.setEngineWorkDir）时扫描一次，
 * 本迭代不做项目目录文件监听。
 */

let fsProvider: ElectronIPCFileSystemProvider | null = null
let templateLoader: FileSystemTemplateLoader | null = null

/** 项目级模板缓存（已规范化：type=custom / priority=PROJECT / priority_scope=project） */
let projectTemplates: SubagentTemplate[] = []

/** 最近一次基础模板（主进程 remote+builtin+user 合并结果），项目级重扫后重放合并用 */
let baseTemplates: SubagentTemplate[] = []

/** 启动初始化：装配 fsProvider/loader（幂等；main.ts 启动时调用，rescan 时兜底自初始化） */
export function initAgentTemplateService(): void {
  if (templateLoader) return
  fsProvider = new ElectronIPCFileSystemProvider()
  // templatesDir 构造参数仅服务 loadBuiltinTemplates()，项目级走 loadTemplatesFromDirectory 逐目录加载，传空串占位
  templateLoader = new FileSystemTemplateLoader(fsProvider, '')
}

/**
 * 基础模板与本地项目级在 manager 外合并（项目级 set 覆盖同名）后 setAllTemplates 回写渲染进程 manager 副本
 * @returns 合并结果（供 orchestratorStore 同步 templates ref）
 */
export function mergeAndApplyTemplates(base: SubagentTemplate[]): SubagentTemplate[] {
  baseTemplates = base
  const merged = new Map<string, SubagentTemplate>()
  for (const template of baseTemplates) {
    merged.set(template.subagent_type, template)
  }
  for (const template of projectTemplates) {
    merged.set(template.subagent_type, template)
  }
  const result = Array.from(merged.values())
  getTemplateManager().setAllTemplates(result)
  return result
}

/**
 * 以渲染进程当前 workDir 向上递归扫描项目各级 .agents/agents/（近→远、同名 subagent_type 先到先得，
 * 与 CLI rescanCustomTemplates 同一语义），缓存后重放"合并 + setAllTemplates"；
 * workDir 未设置时项目级为空（与 UI 项目级 skills 现状一致）
 */
export async function rescanProjectTemplates(workDir?: string): Promise<void> {
  if (!templateLoader || !fsProvider) {
    initAgentTemplateService()
  }
  projectTemplates = []
  if (workDir) {
    const projectDirs = await findProjectTemplateDirs(fsProvider!, workDir)
    // 解析/读取失败明细逐目录收集，扫完合并打印一条（此前静默丢弃）;归一化警告同样收集打印
    const loadErrors: string[] = []
    const loadWarnings: string[] = []
    const loadInfos: string[] = []
    const seen = new Set<string>()
    for (const dir of projectDirs) {
      for (const template of await templateLoader!.loadTemplatesFromDirectory(dir, (errs, warns, infos) => {
        loadErrors.push(...errs)
        loadWarnings.push(...(warns ?? []))
        loadInfos.push(...(infos ?? []))
      })) {
        if (seen.has(template.subagent_type)) continue
        seen.add(template.subagent_type)
        // 规范化目录来源模板（与 core manager.setCustomTemplates 同规则）：type 一律 custom、项目级 priority=1
        projectTemplates.push({
          ...template,
          type: TemplateType.CUSTOM,
          priority: TemplatePriority.PROJECT,
          priority_scope: PriorityScope.PROJECT,
        })
      }
    }
    if (loadErrors.length > 0) {
      console.warn(`【Agent模板】${loadErrors.length} 个项目级模板加载失败:\n${loadErrors.map((e) => `  - ${e}`).join('\n')}`)
    }
    if (loadWarnings.length > 0) {
      console.warn(`【Agent模板】${loadWarnings.length} 条项目级模板警告:\n${loadWarnings.map((w) => `  - ${w}`).join('\n')}`)
    }
    if (loadInfos.length > 0) {
      console.log(`【Agent模板】${loadInfos.length} 条项目级模板提示:\n${loadInfos.map((i) => `  - ${i}`).join('\n')}`)
    }
  }
  mergeAndApplyTemplates(baseTemplates)
}
