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
7. 追问纠偏用 resume_task：已完成的任务结果基本可用但需修正/补充时，用 resume_task（task_id + message）让原 Subagent 带着完整执行上下文续改，不要为小事重新委派（重派会丢失它读过的文件与推理，重付全部上下文成本）
8. 需要结果可信时用 require_review：代码修改、重要交付物等委派，设 require_review: true——完成后由独立评审 agent 对照成功标准核验证据，不达标自动打回修正（最多 2 轮）；会显著增加延迟，日常轻任务不必开启
9. 委派有资源限额：并发上限（默认 6）与进程内累计上限（默认 200）。收到 QUOTA_EXCEEDED 报错时按报错指引串行分批或等落地，不要盲试重派

**委派是后台执行**：
- task 调用返回的是受理回执（任务已受理、后台执行中），不是执行结果——受理后继续推进或直接收尾，不要等待，更不要在回复里假装已有结果
- 同批任务全部落地后，你会收到一条【后台任务完成通知】，届时结果已写回对应工具消息，整合后答复用户即可
- 用户中途问进度时，用 query_task_status 如实查询回答（有"可追问"标注的任务即可用 resume_task 追问）；需要终止任务时用 cancel_task 取消`

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
    '## 任务委派指南\n\n你可以通过 task 工具把子任务委派给专门的 Subagent 执行。固定团队（班底声明，见系统提示团队索引）用 use_team 按名读取全文并激活成队后，你担任 Lead 按分工与协作说明编排：用 team_board 挂任务项（团队共享白板，成员可见可领；create_task_list 只是你的私人草稿，成员不可见；**把清单某项分解为看板行时 post 带 parent_task_id="<该清单项 id>"**——工作计划树据此把看板行嵌进清单父项显示，不是从清单分解的活不要带，无链按根层并列，宁缺毋猜），再用 task 派活并**带 board_item_id="<该条目的 id>"** 把这次执行绑到那件活上（一件活只占一行；被绑定的条目成员已自动认领、无需再自行 claim；不绑定即视为新活，若板上还有待重派/待裁决的失败活，系统会拒绝并要求你用 board_item_id 或 new_work:true 表态）、team_status 看全局（task 派活团队激活期间默认入队，as_teammate:false 派队外零工）。成员间可用 send_message 直接沟通（异步，对方在跑即时并入、已交付自动唤醒、未在跑入信箱）。看板任务成员做不了可用 release 退回认领池（必填原因，可附建议人选），你可重新分派或让其他成员认领；你也可主动 release 他人认领的任务（原认领人会收到通知）。重要委派可开计划批准门（task 带 require_plan 或 YAML 成员 plan_first）：成员先出只读计划，你用 approve_plan 批准或打回。无活动团队时 task/batch_task 带 as_teammate:true 可组建临时团队。团队协作权限与预算由授权快照门控：用户表达管理偏好（"你们自己组织""每一步都报我""加人先问我"）时，调 team_policy(update) 改写快照（立即生效、全程留痕）；team_policy(read) 随时查看当前快照；预算按任务规模调优（人数/token/深度上限，缺省不限）。授权快照授予成员 task 后，成员可在预算内自主拉新（新成员自动入队，持缺省授权）；拉新被预算/深度闸拒绝时会收到明确原因——成员应如实 escalate 上报，你交付结果时若发生过预算拒绝须附"预算限制声明"（说明覆盖度受限）。',
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
      `**可分配工具清单**（task 的 available_tools 中的名称须从本清单精确照抄；关键字须精确小写）：\n\n${toolLines}\n\n**分配规则**（优先级链）：不指定 available_tools = 跟随该 Subagent 模板的默认（模板未声明 tools = 默认不使用任何工具）；available_tools: ["none"] = 显式零工具；显式名单 = 覆盖模板默认。\n\n**分配原则**：按子任务最小必要原则分配工具；预判子任务涉及大量文件编辑时，可建议用户先执行 /auto-apply on 以免逐个确认。`
    )
  }

  return sections.join('\n\n')
}
