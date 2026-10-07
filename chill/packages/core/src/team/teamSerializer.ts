/**
 * 团队 DSL 解析器 + 序列化器（parseTeamDefinition ⇄ serializeTeam 双向同构）
 *
 * 规则：
 * - name 必填 kebab-case；version 必填且 ≤ 当前 DSL 版本
 * - members 非空数组；每项 agent 必填 kebab-case；role/note 可选字符串
 * - 成员引用的模板是否存在不在此校验（创建顺序可能"先团队后成员"；use_team 时校验并列明）
 * - 序列化：可选字段省略不写（"不写=省略"与解析语义一致）
 */

import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { WORKFLOW_NAME_PATTERN } from '../workflow/dsl/types'
import type { TeamDefinition, TeamMember, TeamParseResult, TeamPolicySection } from './types'
import { TEAM_DSL_VERSION } from './types'

export function parseTeamDefinition(content: string, filePath?: string): TeamParseResult {
  const at = filePath ? ` (${filePath})` : ''
  let raw: any
  try {
    raw = loadYaml(content)
  } catch (error: any) {
    return { success: false, error: `YAML 解析失败${at}: ${error.message}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: `团队文件必须是 YAML 对象${at}` }
  }

  if (!raw.name || typeof raw.name !== 'string') {
    return { success: false, error: `团队缺少必填字段 "name"${at}` }
  }
  if (!WORKFLOW_NAME_PATTERN.test(raw.name)) {
    return { success: false, error: `name "${raw.name}" 不符合命名规范,只能包含小写字母、数字和连字符${at}` }
  }
  if (raw.version === undefined || raw.version === null) {
    return { success: false, error: `团队缺少必填字段 "version"(当前 DSL 版本为 ${TEAM_DSL_VERSION})${at}` }
  }
  if (typeof raw.version !== 'number' || raw.version > TEAM_DSL_VERSION || raw.version < 1) {
    return { success: false, error: `不支持的 DSL 版本 "${raw.version}",当前支持 1..${TEAM_DSL_VERSION}${at}` }
  }
  for (const field of ['title', 'description', 'when_to_use', 'orchestration'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      return { success: false, error: `字段 "${field}" 必须是字符串${at}` }
    }
  }

  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    return { success: false, error: `团队必须至少包含 1 个成员(members 数组为空或缺失)${at}` }
  }
  const members: TeamMember[] = []
  for (const item of raw.members) {
    if (!item || typeof item !== 'object') return { success: false, error: `members 数组项必须是对象${at}` }
    if (typeof item.agent !== 'string' || !WORKFLOW_NAME_PATTERN.test(item.agent)) {
      return { success: false, error: `成员的 agent 字段必填且符合命名规范(kebab-case)${at}` }
    }
    if (item.role !== undefined && typeof item.role !== 'string') return { success: false, error: `成员 "${item.agent}" 的 role 必须是字符串${at}` }
    if (item.note !== undefined && typeof item.note !== 'string') return { success: false, error: `成员 "${item.agent}" 的 note 必须是字符串${at}` }
    if (item.plan_first !== undefined && typeof item.plan_first !== 'boolean') return { success: false, error: `成员 "${item.agent}" 的 plan_first 必须是布尔值${at}` }
    members.push({ agent: item.agent, role: item.role, note: item.note, plan_first: item.plan_first })
  }

  // policy 段(可选;授权快照初始值;类型校验,语义合法性在成队时由 teamPolicy 复核)
  let policy: TeamPolicySection | undefined
  if (raw.policy !== undefined) {
    if (typeof raw.policy !== 'object' || raw.policy === null || Array.isArray(raw.policy)) {
      return { success: false, error: `字段 "policy" 必须是对象${at}` }
    }
    const p = raw.policy
    if (p.default_member_grants !== undefined && (!Array.isArray(p.default_member_grants) || p.default_member_grants.some((g: unknown) => typeof g !== 'string'))) {
      return { success: false, error: `policy.default_member_grants 必须是字符串数组${at}` }
    }
    if (p.grants !== undefined && (typeof p.grants !== 'object' || p.grants === null || Array.isArray(p.grants))) {
      return { success: false, error: `policy.grants 必须是对象(键=成员名或 lead,值=字符串数组)${at}` }
    }
    if (p.budget !== undefined) {
      if (typeof p.budget !== 'object' || p.budget === null) return { success: false, error: `policy.budget 必须是对象${at}` }
      for (const k of ['max_members', 'max_tokens', 'max_depth'] as const) {
        if (p.budget[k] !== undefined && (typeof p.budget[k] !== 'number' || p.budget[k] < 0)) {
          return { success: false, error: `policy.budget.${k} 必须是非负数字${at}` }
        }
      }
    }
    policy = { default_member_grants: p.default_member_grants, grants: p.grants, budget: p.budget }
  }

  const definition: TeamDefinition = {
    name: raw.name,
    version: raw.version,
    title: raw.title,
    description: raw.description,
    when_to_use: raw.when_to_use,
    members,
    orchestration: raw.orchestration,
    policy,
  }
  return { success: true, definition }
}

/** Definition → YAML 文本（可选字段省略不写；sourcePath/scope 不落盘） */
export function serializeTeam(def: TeamDefinition): string {
  const { sourcePath: _sp, scope: _sc, ...rest } = def
  const data: Record<string, unknown> = {
    name: rest.name,
    version: rest.version,
  }
  if (rest.title) data.title = rest.title
  if (rest.description) data.description = rest.description
  if (rest.when_to_use) data.when_to_use = rest.when_to_use
  data.members = rest.members.map((m) => {
    const item: Record<string, unknown> = { agent: m.agent }
    if (m.role) item.role = m.role
    if (m.note) item.note = m.note
    if (m.plan_first) item.plan_first = true
    return item
  })
  if (rest.orchestration) data.orchestration = rest.orchestration
  if (rest.policy) data.policy = rest.policy
  return dumpYaml(data, { lineWidth: 120, noRefs: true })
}
