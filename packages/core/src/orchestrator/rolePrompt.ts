/**
 * 角色与能力分离（T3：前台 Agent 选择）
 *
 * SubagentTemplate.system_prompt 只描述能力，不承担角色；角色由使用场景包装：
 * - 前台场景（被选为会话前台）：wrapFrontAgentPrompt——"直接面对用户的 Agent"；
 * - 子任务场景（被 task 委派）：wrapSubtaskPrompt——"执行子任务的 Subagent"。
 *
 * 前台候选限定本地模板（builtin/custom）：远程模板（remote-mcp/remote-api）
 * 没有本地连续对话能力，只能被 task 委派、不能作前台。
 *
 * 纯逻辑、无 Node 依赖，渲染进程可用。
 */

import { TemplateType, type SubagentTemplate } from './types'
import type { AvailableSubagent } from './types'
import { buildWriteBoundaryPrompt } from '../services/writeBoundary'

/** 模板是否本地模板（type 缺省按 builtin 处理，与 TaskExecutor 执行分发一致） */
export function isLocalSubagentTemplate(template: SubagentTemplate): boolean {
  const type = template.type ?? TemplateType.BUILTIN
  return type === TemplateType.BUILTIN || type === TemplateType.CUSTOM
}

/** AvailableSubagent 是否前台候选（templateType 缺省按 builtin 处理，与 convert 的 FALLBACK 一致） */
export function isFrontAgentCandidate(subagent: AvailableSubagent): boolean {
  const type = subagent.templateType ?? 'builtin'
  return type === 'builtin' || type === 'custom'
}

/** 从候选列表过滤出可作前台的本地模板 */
export function filterFrontAgentCandidates(subagents: AvailableSubagent[]): AvailableSubagent[] {
  return subagents.filter(isFrontAgentCandidate)
}

/**
 * 前台场景角色包装：直接面对用户的 Agent。
 * 能力描述取自模板 system_prompt；模型规则：模板 model 字段已注册时以模板为准，
 * 否则跟随用户选定模型（resolveModelName 前台分支；委派链同语义）。
 * @param taskAvailable - task 委派工具在当前工具集内（前台模板 tools 白名单可能滤掉；
 * 不可用时省略委派句，防模型幻觉调用不存在的工具）
 */
export function wrapFrontAgentPrompt(template: SubagentTemplate, taskAvailable = true): string {
  const capability = (template.system_prompt ?? '').trim()
  const sections = [
    `你是「${template.name}」，一个直接面对用户的 Agent。`,
    '## 角色\n你直接与用户对话：理解用户需求、回答用户问题、维护对话上下文——用户感知到的对话者就是你，不是幕后执行者。',
  ]
  if (capability) {
    sections.push(`## 能力描述\n${capability}`)
  }
  sections.push(
    taskAvailable
      ? '## 工作方式\n能力范围内的任务直接完成；遇到复杂、可拆解或适合并行的子任务时，使用 task 工具委派给专门的 Subagent 执行，并整合委派结果回复用户。'
      : '## 工作方式\n能力范围内的任务直接完成；超出能力范围的，如实告知用户。'
  )
  return sections.join('\n\n')
}

/**
 * 委派时随子任务提示携带的写边界信息（Worker 不吃主会话注入器，边界必须随委派传递）
 */
export interface SubtaskWriteBoundary {
  /** 当前可写根集合 */
  roots: string[]
  /** -p readonly：写本被拦截（注入只读提示而非边界规则） */
  readonly?: boolean
  /** autoApply on（含 -p --auto）：全量直接写、无审批 */
  fullAccess?: boolean
}

/**
 * 子任务场景角色包装：执行子任务的 Subagent。
 * 能力描述取自模板 system_prompt；委派链的模型选择（override_parameters.model >
 * 模板 model > 用户当前模型）由 TaskExecutor/执行适配器负责，与本文案无关。
 * writeBoundary 提供时把当前边界集合与状态分支一并写入（与主会话 write-boundary 注入同源）。
 */
export function wrapSubtaskPrompt(template: SubagentTemplate, writeBoundary?: SubtaskWriteBoundary): string {
  const capability = (template.system_prompt ?? '').trim()
  const sections = [
    `你是「${template.name}」，一个执行子任务的 Subagent。`,
    '## 角色\n你由调用方经 task 工具委派，负责完成一个明确的子任务。你只对本子任务负责：按任务描述与成功标准推进，充分利用可用工具。你的最终回复是唯一会回传给调用方的内容（中间过程调用方不可见）——请按任务描述要求的详尽度，把需要交付的信息完整写入最终回复；你不与用户直接对话。',
  ]
  if (capability) {
    sections.push(`## 能力描述\n${capability}`)
  }
  if (writeBoundary) {
    sections.push(
      buildWriteBoundaryPrompt(writeBoundary.roots, {
        readonly: writeBoundary.readonly,
        fullAccess: writeBoundary.fullAccess,
      }),
    )
  }
  return sections.join('\n\n')
}
