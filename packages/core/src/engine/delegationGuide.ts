/**
 * 委派指南 prompt 片段（T2：task 可用时注入 system 消息）
 *
 * 取代 ModelSettings.vue 的 lead_agent_system_prompt 自定义配置（退役），
 * 是"何时委派/何时直答"调度人设的统一维护处。三部分：
 * ① 委派决策（提炼自旧调度人设并按新对话路径改写：前台可以直接回答，
 *    旧 prompt 的"只能委派"约束不适用）；
 * ② 可用 Subagent 列表（formatSubagentsForPrompt，T1 迁移到 delegation 模块）；
 * ③ 可用模型列表（formatModelsForPrompt，含能力/成本/速度等级），指导按任务性质选模型。
 *
 * 委派标准的调优是预期内工作（过度委派/委派不足时迭代本片段），属行为调优而非回归失败。
 * 纯逻辑、无 Node 依赖，渲染进程可用。
 */

import type { ModelInfo } from '../types/models'
import type { AvailableSubagent, AvailableModel } from '../orchestrator/types'
import { ORCHESTRATION_TOOL_NAMES } from '../orchestrator/types'
import type { ToolCatalogEntry } from './toolDiscovery'
import { formatSubagentsForPrompt, formatModelsForPrompt } from '../services/delegation/delegationPrompt'

/**
 * ModelInfo → AvailableModel 转换（迁移自 CLI CliChatService.convertModelInfo，单一事实源上收 core；
 * CLI 本地副本 T4 接入引擎后删除）。能力/成本/速度等级供委派时按任务性质选模型。
 */
export function convertModelInfoToAvailableModel(info: ModelInfo): AvailableModel {
  const capabilities: string[] = []
  if (info.supportsTools) capabilities.push('tools')
  if (info.supportsStreaming) capabilities.push('streaming')
  if (info.supportsThinking) capabilities.push('thinking')

  const supportedFeatures = [...capabilities]

  if (info.supportedModalities) {
    for (const m of info.supportedModalities) {
      const v = String(m).toLowerCase()
      if (v !== 'text') {
        supportedFeatures.push(v)
      }
    }
  }

  const applicableScenarios: string[] = []
  if (info.supportsTools) applicableScenarios.push('工具调用/Agent任务')
  if (info.supportsThinking) applicableScenarios.push('复杂推理/代码生成')
  if (!info.supportsThinking && !info.supportsTools) applicableScenarios.push('通用对话')

  const maxTokens = info.maxOutputTokens || 0
  let tokenConsumptionLevel: 'low' | 'medium' | 'high' = 'medium'
  if (maxTokens > 32000) tokenConsumptionLevel = 'high'
  else if (maxTokens < 8000) tokenConsumptionLevel = 'low'

  const nameLower = info.name.toLowerCase()
  let responseSpeedLevel: 'fast' | 'medium' | 'slow' = 'medium'
  if (nameLower.includes('turbo') || nameLower.includes('flash')) responseSpeedLevel = 'fast'
  else if (nameLower.includes('thinking') || nameLower.includes('reasoner')) responseSpeedLevel = 'slow'

  return {
    name: info.name,
    provider: info.provider,
    description: info.description,
    capabilities,
    tokenConsumptionLevel,
    responseSpeedLevel,
    supportedFeatures,
    applicableScenarios,
  }
}

/** 委派决策指导（①，提炼自旧调度人设并按新对话路径改写） */
const DELEGATION_POLICY = `**何时直接回答（不委派）**：
- 简单问答、闲聊、解释说明——直接回答更快更准确
- 单步即可完成的任务（如读一个文件、改一处小地方、执行一条命令）
- 需要与用户持续往返确认、依赖对话上下文逐轮推进的事情

**何时委派 task**：
- 复杂的多步骤任务，可拆解为相对独立的子任务
- 需要从多个角度调研/分析的任务——默认并行：在同一次响应中同时发起多个 task 调用，多个 Subagent 会并行执行（而不是等上一个返回后才创建下一个），完成后整合各 Subagent 的结果形成全面回答
- 与主对话相对独立、工作量大的后台型子任务

**委派要点**：
1. 任务拆分：复杂任务拆分为多个独立子任务，每个从不同角度切入；同一次响应中生成多个 task 调用即自动并行
2. 没有专门 Subagent 匹配时，优先使用通用基础模板（general-purpose）——它是万能的问题解决者，不要假设它只能处理特定类型的任务
3. 需求不够明确时，先向用户询问关键信息再委派
4. Subagent 的工具集不含 task（Subagent 不能再向下委派），需要多层分解时由你逐层委派
5. 规划模式（plan mode）下 task 可用，但 Subagent 只获得只读工具（修改性工具已过滤）。适合委派调研任务（代码分析、网络搜索），不可委派修改操作
6. 报告约定：Subagent 的最终回复是唯一回传给你的内容——在 task_description 中明确期望的报告形态与详尽度（全文细节还是结论摘要）；长报告任务可用 override_parameters.max_tokens 调大输出配额

**委派是后台执行**：
- task 调用返回的是受理回执（任务已受理、后台执行中），不是执行结果——受理后继续推进或直接收尾，不要等待，更不要在回复里假装已有结果
- 同批任务全部落地后，你会收到一条【后台任务完成通知】，届时结果已写回对应工具消息，整合后答复用户即可
- 用户中途问进度时，用 query_task_status 如实查询回答；需要终止任务时用 cancel_task 取消`

/** 按任务性质选模型指导（③的引导语；不写死任何模型，列表数据来自运行时可用模型） */
const MODEL_SELECTION_POLICY = `**为 Subagent 选模型**（task 的 override_parameters.model，可选）：
- 不指定时按 Subagent 模板默认模型回退，无需强制指定
- 多模态任务（需要理解图片/视频/音频）→ 指定支持功能中含对应模态的模型
- 简单小任务 → 指定 Token 消耗低、响应速度快的模型，降低成本与延迟
- 复杂推理、代码生成、长链路工具任务 → 指定核心能力含 thinking/tools 的模型`

/**
 * 构建委派指南 system 消息内容。
 * @param toolCatalog 当轮工具目录（「可分配工具清单」section 数据源；buildToolset 产出，经 AssembleContext 传入）
 * @returns 指南文本；无可用 Subagent 时返回 null（无可委派对象，不注入）
 */
export function buildDelegationGuide(
  subagents: AvailableSubagent[],
  models: AvailableModel[],
  toolCatalog?: ToolCatalogEntry[]
): string | null {
  if (subagents.length === 0) {
    return null
  }

  const sections: string[] = [
    '## 任务委派指南\n\n你可以通过 task 工具把子任务委派给专门的 Subagent 执行。',
    DELEGATION_POLICY,
    `**可用 Subagent 列表**：\n\n${formatSubagentsForPrompt(subagents)}`,
  ]

  if (models.length > 0) {
    sections.push(MODEL_SELECTION_POLICY)
    sections.push(`**可用模型列表**（委派时按任务性质从中选择）：\n\n${formatModelsForPrompt(models)}`)
  }

  // 可分配工具清单（full-picture 分配）：按类别分组的纯名字索引（去描述化，与工具渐进发现索引同数据源）；
  // 剔除编排工具（task 系 + search_tools——Subagent 侧不可用），防主模型把它们照抄进 available_tools 触发 Worker 白名单校验报错
  if (toolCatalog && toolCatalog.length > 0) {
    const groups: Array<{ category: string; names: string[] }> = []
    for (const entry of toolCatalog) {
      if (ORCHESTRATION_TOOL_NAMES.includes(entry.name)) continue
      const group = groups.find((g) => g.category === entry.category)
      if (group) group.names.push(entry.name)
      else groups.push({ category: entry.category, names: [entry.name] })
    }
    const toolLines = groups.map((g) => `- ${g.category}: ${g.names.join(', ')}`).join('\n')
    sections.push(
      `**可分配工具清单**（task 的 available_tools 中的名称须从本清单精确照抄；不指定 available_tools 则默认分配全部工具）：\n\n${toolLines}\n\n**分配原则**：按子任务最小必要原则分配工具；预判子任务涉及大量文件编辑时，可建议用户先执行 /auto-apply on 以免逐个确认。`
    )
  }

  return sections.join('\n\n')
}
