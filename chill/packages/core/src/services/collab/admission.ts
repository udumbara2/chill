/**
 * 统一协作准入层(统一协作基板 · 迭代 1)
 *
 * 定位:所有 worker spawn 的准入判定与登记的唯一事实点(委派=1人团队:单委派=隐式身份,
 * 团队成员=显式命名身份)。六个唯一:caller 解析/身份解析/授权计算/门控/登记/工具定义豁免构建。
 *
 * 纪律:
 * - 纯判定与装配分离:判定均为纯函数可单测;本模块只做准入判定与登记,不碰执行/回流/审批;
 * - 两阶段形态(与既有登记顺序对齐,不发明新顺序):
 *   precheck(纯判定,无副作用)在 quota/hooks/preflight 之前;
 *   enroll(副作用:roster 入队+豁免计算)在 registry.register 同点——预检失败零痕迹的现状语义保持;
 * - 双轨期约定:本模块是 task 路径的判定来源;decideAndRegisterTeamMember/checkMemberSpawnGate
 *   的旧实现仅在未迁移路径(batch)存活,迭代 4 全删(重构原则:不留双轨)。
 */

import { getTeamRuntimeService } from '../team/TeamRuntimeService'
import { canSpawnWithinBudget, hasGrant, resolveGrants } from '../team/teamPolicy'
import type { ToolDefinition } from '../../types/models'
import { ORCHESTRATION_TOOL_NAMES } from '../../orchestrator/types'
import type { TeamInboxMessage } from '../team/teamRuntimeTypes'

// ---------------- caller 解析(唯一) ----------------

export type SpawnCaller = 'lead' | { member: string } | 'workflow' | 'system:review'

export interface SpawnOrigin {
  source?: string
  taskId?: string
}

/** caller 解析唯一:__origin → caller。成员身份经 roster 反查(origin.taskId→成员名),Worker 参数自报一律无效。 */
export function resolveSpawnCaller(origin?: SpawnOrigin): SpawnCaller {
  if (origin?.source !== 'subagent') return 'lead'
  const svc = getTeamRuntimeService()
  const memberName = svc?.getMemberNameByTaskId(origin.taskId)
  return memberName ? { member: memberName } : 'lead'
}

// ---------------- 门控(唯一):成员拉新三闸 ----------------

/**
 * 成员拉新门(纯判定):仅当 caller 是团队成员时生效。
 * 三闸:①授权(hasGrant task,含 派生名→词干→模板 回退链)②预算(canSpawnWithinBudget)③深度(budget.maxDepth 帽)。
 * lead 发起的委派直接放行(lead 的干预权由前台门控负责,不在此处)。
 */
export function checkSpawnGates(caller: SpawnCaller): string | null {
  // 只有团队成员对象才过闸;lead/workflow/system:review 直接放行(各自的门在别处)
  if (typeof caller !== 'object') return null
  const svc = getTeamRuntimeService()
  const team = svc?.getActiveTeam()
  if (!svc || !team) return `团队状态异常:成员 ${caller.member} 不在任何活动团队`
  const snapshot = team.snapshot
  const callerAgent = team.roster.find((e) => e.name === caller.member)?.agent
  if (!hasGrant(snapshot, caller.member, 'task', callerAgent)) {
    return '当前授权快照未授予你委派(拉新)权限(team_policy read 可查)。可经 send_message 向 Lead 请示,由 Lead 亲自委派或调整授权。'
  }
  const budgetCheck = canSpawnWithinBudget(snapshot, team.ledger?.memberCount ?? team.roster.length, team.ledger?.spentTokens ?? null, team.ledger?.estimated)
  if (!budgetCheck.ok) return budgetCheck.reason!
  const callerDepth = team.roster.find((e) => e.name === caller.member)?.depth ?? 1
  if (snapshot?.budget.maxDepth !== undefined && callerDepth + 1 > snapshot.budget.maxDepth) {
    return `嵌套深度超限:你当前深度 ${callerDepth},拉新将达 ${callerDepth + 1},超过团队预算 maxDepth=${snapshot.budget.maxDepth}。可请示 Lead 亲自委派(Lead 直派深度为 1)。`
  }
  return null
}

// ---------------- 授权计算(唯一):编排豁免 ----------------

/** 授权计算唯一:快照回退链(精确名→词干→模板→缺省)→ 编排工具豁免名单(让渡给执行器池子/定义层/网关同源使用) */
export function computeGrantedOrchestration(memberName: string | undefined, agent: string): string[] {
  if (!memberName) return []
  const snapshot = getTeamRuntimeService()?.getSnapshot()
  const grants = resolveGrants(snapshot, memberName, agent)
  return grants.filter((g) => ORCHESTRATION_TOOL_NAMES.includes(g))
}

// ---------------- 身份解析与登记(enroll;唯一) ----------------

export interface EnrollInput {
  caller: SpawnCaller
  agent: string
  memberName?: string
  asTeammate?: boolean
  taskId: string
}

export interface Enrollment {
  joined: boolean
  memberName?: string
  teamLabel?: string
  depth?: number
  undelivered?: TeamInboxMessage[]
  planFirst?: boolean
  grantedOrchestrationTools: string[]
}

/**
 * 身份解析与登记(enroll;registry.register 同点调用):
 * 入队判定(有队默认入队/as_teammate=false 退出/无队 true 成队)+ 成员名派生 + depth 计算(成员拉新=父+1)
 * + 编排豁免计算(成员名经实际派生后按回退链授权)。
 * 预检失败零痕迹:本函数只在预检通过后调用。
 */
// ---------------- 工具定义构建(唯一) ----------------

/**
 * 任务清单四工具:Worker 一律无条件剥离(不可经 allowedOrchestration 放行——allowed 只豁免编排工具)。
 * 原因:Worker 的清单从未可用(无 read 工具、Worker 上下文无清单注入——写了读不回,纯噪声),
 * 且其 TASK_* 事件带宿主 sessionId 会整表覆盖主会话清单(污染主 Agent 每轮上下文注入与桌面显示);
 * 协作语义规定成员进展一律 team_board 汇报。
 */
const WORKER_STRIPPED_TASK_TOOLS: readonly string[] = ['create_task_list', 'update_task_status', 'delete_task', 'add_task']

/**
 * Worker 工具定义列表构建(唯一事实点;收编自 delegationTools.filterSubagentTools):
 * 默认剥掉全部编排工具定义(防无限套娃);allowedOrchestration(授权快照授予的编排工具)豁免保留——
 * 定义层/池子层(StandardSubagentExecutor)/网关层(ForkManager hasGrant 复核)的豁免数据同源。
 * 任务清单四工具无条件剥离(见 WORKER_STRIPPED_TASK_TOOLS 注)。
 */
export function buildWorkerToolDefinitions(
  toolDefinitions?: ToolDefinition[],
  allowedOrchestration?: string[],
): ToolDefinition[] | undefined {
  if (!toolDefinitions) return undefined
  const allowed = allowedOrchestration ?? []
  // 会话看板工具(board)不在此层强制并集——Worker 固定注入(escalate_to_lead 同款:
  // GenericSubagentWorker 固定注册 + 网关白名单豁免),本函数保持纯过滤语义
  return toolDefinitions.filter((tool) => {
    const name = tool.function?.name ?? ''
    if (WORKER_STRIPPED_TASK_TOOLS.includes(name)) return false
    return !ORCHESTRATION_TOOL_NAMES.includes(name) || allowed.includes(name)
  })
}

// ---------------- 非委派 caller 的显式准入(workflow / 评审回路) ----------------

/**
 * workflow 节点准入(语义钉死,红线):身份=匿名单元,**永不入队,不论是否有活动团队**
 * (现状:workflow 节点无成员登记点,从不入队;统一身份解析后不得凭空产生入队行为);
 * 不计配额(现状;是否统一计入全局配额为后续拍板项)、无编排豁免(节点不是团队成员)。
 * 纯声明式:返回匿名身份;本函数的存在使"workflow 不走团队"成为代码而非"没有代码"。
 */
export function admitWorkflowSpawn(): Enrollment {
  return { joined: false, grantedOrchestrationTools: [] }
}

/**
 * 评审回路准入(reviewer/返工,executor 内生命周期):不计配额、不计账本(现状语义——
 * MAX_REVIEW_ROUNDS=2 天然封顶)。纯声明式:caller='system:review' 豁免一切准入闸。
 */
export function admitReviewSpawn(): Enrollment {
  return { joined: false, grantedOrchestrationTools: [] }
}

export async function enrollWorkerSpawn(input: EnrollInput): Promise<Enrollment> {
  const svc = getTeamRuntimeService()
  const hasTeam = !!svc?.getActiveTeam()
  const join = svc ? (hasTeam ? input.asTeammate !== false : input.asTeammate === true) : false
  if (!svc || !join) {
    return { joined: false, grantedOrchestrationTools: [] }
  }
  const callerDepth =
    typeof input.caller === 'object'
      ? svc.getActiveTeam()?.roster.find((e) => e.name === (input.caller as { member: string }).member)?.depth ?? 1
      : undefined
  const depth = callerDepth !== undefined ? callerDepth + 1 : 1
  const { entry, undelivered } = await svc.registerMember({
    agent: input.agent,
    memberName: input.memberName,
    taskId: input.taskId,
    depth,
  })
  const team = svc.getActiveTeam()!
  return {
    joined: true,
    memberName: entry.name,
    teamLabel: team.name ? `「${team.name}」` : '临时团队',
    depth,
    undelivered,
    planFirst: entry.planFirst,
    grantedOrchestrationTools: computeGrantedOrchestration(entry.name, input.agent),
  }
}
