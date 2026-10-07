/**
 * use_team 工具:按名读取并激活一个固定团队(班底声明)
 *
 * 成队语义(迭代 1 起):成功读取即把团队物化为运行时实体(花名册+共享看板,
 * TeamRuntimeService);同名幂等——已是活动团队时纯重读,运行时状态分毫不动;
 * 异名调用归档当前队(固定/ad-hoc 皆可)后成新队。TeamRuntimeService 未装配时
 * 退化为旧版纯只读读取(文本注明未成队)。
 * 编排权归 Lead:本工具已入 ORCHESTRATION_TOOL_NAMES(Worker 网关永不放行)
 * 与 PLAN_MODE_BLOCKED_TOOLS(plan 只读)。
 * 成员模板缺失列明(先建团队后建成员的合法顺序;Lead 决定换人或中止)。
 */

import type { ToolDefinition } from '../../types/models'
import { getTemplateManager } from '../../orchestrator/managers/SubagentTemplateManager'
import { getTeamServiceForIndex } from './TeamTemplateService'
import { getTeamRuntimeService } from './TeamRuntimeService'

export const useTeamToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'use_team',
    description:
      '按名读取并激活一个固定团队(预先保存的班底声明:lead + 成员 + 分工与协作说明,YAML 资产)。' +
      '调用即把团队激活为当前活动团队(花名册+共享看板自动就位);同名重复调用是安全的纯重读,' +
      '调用异名团队会归档当前团队再成新队。激活后你(Lead)用 team_board 挂任务、task 派活(默认入队)、' +
      'team_status 看全局——成员固定、流程每次即兴,团队本身没有固定流程(固定流程请用 run_workflow)。' +
      '可用团队清单见系统提示中的团队索引。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '团队调用键(kebab-case,如 news-team)',
        },
      },
      required: ['name'],
    },
  },
}

/** use_team 工具执行:校验 + 成队(同名幂等/异名归档换队/未装配降级);团队不存在时响亮报错并列出可用团队 */
export async function executeUseTeam(argsJson: string, sessionId?: string): Promise<{ success: boolean; data?: string; error?: string }> {
  let name: string | undefined
  try {
    name = (JSON.parse(argsJson) as { name?: string }).name
  } catch {
    return { success: false, error: '解析 use_team 参数失败' }
  }
  const svc = getTeamServiceForIndex()
  if (!svc) return { success: false, error: '团队服务未装配' }
  if (!name) {
    return { success: false, error: `缺少必填参数 name。可用团队:\n${readableTeamList()}` }
  }
  const def = svc.getTeamByName(name)
  if (!def) {
    return { success: false, error: `团队 "${name}" 不存在。可用团队:\n${readableTeamList()}` }
  }

  // 成员模板存在性校验(实时;先建团队后建成员的合法顺序)
  const tm = getTemplateManager()
  const present: string[] = []
  const missing: string[] = []
  for (const m of def.members) {
    ;(tm.getTemplateByType(m.agent) ? present : missing).push(m.agent)
  }

  const lines: string[] = [
    `# 团队「${def.title || def.name}」(@${def.name})`,
    '',
    def.description ? `描述: ${def.description}` : '',
    def.when_to_use ? `适用: ${def.when_to_use}` : '',
    '',
    '## 成员与分工',
    ...def.members.map((m) => {
      const status = missing.includes(m.agent) ? ' ⚠️ 模板不存在' : ''
      const planFirst = m.plan_first ? '(先报计划)' : ''
      return `- @${m.agent}${m.role ? `(${m.role})` : ''}${planFirst}${m.note ? ` — ${m.note}` : ''}${status}`
    }),
  ]
  if (def.orchestration) {
    lines.push('', '## 协作说明', def.orchestration)
  }
  if (missing.length > 0) {
    lines.push('', `⚠️ 成员模板缺失: ${missing.join(', ')}。请换用现有模板补位、先创建缺失模板,或中止并告知用户。`)
  }

  // 成队(同名幂等;异名归档换队;未装配降级为纯只读)
  const runtime = getTeamRuntimeService()
  if (!runtime) {
    lines.push('', '⚠️ 团队运行时未装配,本次仅为读取,未成队。')
  } else if (runtime.isActiveNamedTeam(def.name)) {
    lines.push('', `✅ 本团队已是当前活动团队(纯重读,花名册与看板状态未动;runId: ${runtime.getActiveTeam()!.runId})。`)
  } else {
    const { runId, archivedRunId } = await runtime.formFromDefinition(def, sessionId)
    lines.push('', `✅ 团队已激活(runId: ${runId})——花名册与共享看板已就位。`)
    if (archivedRunId) {
      lines.push(`ℹ️ 此前的活动团队已归档留档(${archivedRunId};每会话一个活动团队)。`)
    }
  }
  lines.push(
    '',
    '你现在是本团队的 Lead:按上述分工与协作说明,用 team_board 挂任务 → task 派活(团队激活期间默认入队,成员可在看板认领)→ team_status 看全局;resume_task 追问纠偏,steer_task 中途指示。',
  )

  return { success: true, data: lines.filter((l) => l !== '').join('\n') }
}

function readableTeamList(): string {
  const svc = getTeamServiceForIndex()
  const all = svc?.getAllTeams() ?? []
  if (all.length === 0) return '(当前没有可用的团队)'
  return all.map((t) => `- ${t.name}: ${t.description || t.title || ''}`).join('\n')
}
