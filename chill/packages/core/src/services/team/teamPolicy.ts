/**
 * 团队授权快照判定 SSOT(原子化灵活协作机制 · 一期迭代 1)
 *
 * 纪律:
 * - 纯函数、零服务依赖(不 import TeamRuntimeService),全部可纯单测;
 *   迭代 2(看板动作门控)/3(预算闸)/4(前台门控与解冻)/5(/team 展示)一律调本模块,禁止复制第二份判定逻辑。
 * - 快照缺失(undefined)= 默认语义(=现状:成员有团队三工具+请示通道,无编排工具;Lead 全权)——向后兼容红线。
 * - 元工具豁免是结构性的,不经快照:成员侧豁免 = send_message 请示通道 + team_policy 只读;
 *   lead 侧豁免 = team_policy 读写。任何快照变更试图收走豁免项 → 响亮拒绝(堵提权后门)。
 * - team_policy 的 update 权限按调用来源(__origin)判定,不在本模块(执行层;任何 agent 不可经快照授予自己 update)。
 */

import { PLAN_MODE_BLOCKED_TOOLS } from '../../orchestrator/toolPolicy'
import type { AtomGrant, SnapshotHistoryEntry, TeamBudget, TeamLedger, TeamSnapshot } from './teamRuntimeTypes'

/** team_board 的 action 名单(action 级授权的合法后缀;与 teamBoardTool 定义的 enum 保持一致) */
export const TEAM_BOARD_ACTIONS: readonly string[] = ['post', 'claim', 'release', 'update', 'read', 'remove']

/** 元工具豁免清单(任何快照不可收走;lead 与成员双向成立,粒度见模块头注释) */
export const META_TOOL_EXEMPTIONS: readonly string[] = ['team_policy', 'send_message']

/** 前台可收走的干预工具(迭代 4 前台门控的靶子;豁免清单内的永不在此列) */
export const LEAD_GATEABLE_TOOLS: readonly string[] = ['task', 'batch_task', 'resume_task', 'steer_task']

/** 前台门控判定(SSOT):当前快照下 Lead 被收走的干预工具名单(含解冻态恢复;缺省快照 = 零收走) */
export function computeLeadBlockedTools(snapshot: TeamSnapshot | undefined): string[] {
  if (!snapshot) return []
  return LEAD_GATEABLE_TOOLS.filter((n) => !hasGrant(snapshot, 'lead', n))
}

/** 成员默认授权(= 现状语义:三个团队工具固定注入 + team_policy 只读 + escalate 请示通道) */
export const DEFAULT_MEMBER_GRANTS: readonly AtomGrant[] = [
  'team_board',
  'team_status',
  'send_message',
  'escalate_to_lead',
  'team_policy:read',
]

/** Lead 默认授权 = 全权(现状语义) */
export const LEAD_DEFAULT_GRANTS: readonly AtomGrant[] = ['*']

/** AtomGrant 合法值集 = 编排/门控工具名(PLAN_MODE_BLOCKED_TOOLS 清单)+ team_board action 名 + 固定注入只读项 */
const LEGAL_GRANTS: ReadonlySet<string> = new Set([
  ...PLAN_MODE_BLOCKED_TOOLS,
  // 任务管理只读/控制(不在编排黑名单但可被显式保留;实测:lead 收权时想保留它们被误拒)
  'query_task_status',
  'cancel_task',
  ...TEAM_BOARD_ACTIONS.map((a) => `team_board:${a}`),
  'team_board',
  'team_status',
  'send_message',
  'escalate_to_lead',
  'team_policy:read',
  '*',
])

/** '*' 全权关键字仅允许出现在 lead 的授权里 */
export function isLegalGrant(grant: AtomGrant): boolean {
  return LEGAL_GRANTS.has(grant)
}

/** 校验一组授权合法值;非法响亮抛错(文案列出合法集) */
export function assertLegalGrants(grants: AtomGrant[], owner: string): void {
  for (const g of grants) {
    if (!isLegalGrant(g)) {
      throw new Error(`"${owner}" 的授权项 "${g}" 不合法。合法值 = 编排工具名(如 task/batch_task/resume_task)、team_board[:action]、团队工具名;'*' 仅限 lead`)
    }
    if (g === '*' && owner !== 'lead') {
      throw new Error(`"${owner}" 的授权项 "*" 仅限 lead 使用`)
    }
  }
}

/** 豁免校验:任何 grants 表不得收走豁免项(成员侧 send_message + team_policy:read;lead 侧 team_policy) */
export function assertExemptionsIntact(grants: Record<string, AtomGrant[]>): void {
  for (const [owner, list] of Object.entries(grants)) {
    if (owner === 'lead') {
      if (!list.includes('*') && !list.includes('team_policy')) {
        throw new Error('lead 的授权不可收走 team_policy(元工具豁免——否则放权快照会锁死改管通道)')
      }
    } else {
      if (!list.includes('send_message')) {
        throw new Error(`成员 "${owner}" 的授权不可收走 send_message(请示通道豁免——否则强控制下成员连请示都做不到)`)
      }
      if (!list.includes('team_policy:read')) {
        throw new Error(`成员 "${owner}" 的授权不可收走 team_policy:read(观测豁免)`)
      }
    }
  }
}

/** 系统默认预算(设置页/CLI 双通道;壳注入提供者,core 零存储依赖——仿 delegation/quota.ts) */
export type TeamBudgetDefaultsProvider = () => Partial<TeamBudget> | null

let budgetDefaultsProvider: TeamBudgetDefaultsProvider | null = null

export function setTeamBudgetDefaultsProvider(p: TeamBudgetDefaultsProvider | null): void {
  budgetDefaultsProvider = p
}

/** 读系统默认预算(未注入/缺键 = 不限;快照生成的兜底来源与 team_policy 越界判定的基准) */
export function getTeamBudgetDefaults(): Partial<TeamBudget> {
  try {
    return budgetDefaultsProvider?.() ?? {}
  } catch {
    return {}
  }
}

/** 生成默认快照(成队时由 TeamRuntimeService.activate 调用;policy = 团队 YAML policy 段;预算三级:policy > 系统默认 > 不限) */
export function createDefaultSnapshot(policy?: {
  grants?: Record<string, AtomGrant[]>
  default_member_grants?: AtomGrant[]
  budget?: { max_members?: number; max_tokens?: number; max_depth?: number }
}): TeamSnapshot {
  const grants: Record<string, AtomGrant[]> = { lead: [...LEAD_DEFAULT_GRANTS], ...(policy?.grants ?? {}) }
  const defaultMemberGrants = policy?.default_member_grants ?? [...DEFAULT_MEMBER_GRANTS]
  for (const [owner, list] of Object.entries(grants)) assertLegalGrants(list, owner)
  assertLegalGrants(defaultMemberGrants, 'default_member_grants')
  assertExemptionsIntact({ ...grants, '<default>': defaultMemberGrants })
  const sys = getTeamBudgetDefaults()
  const budget: TeamBudget = {
    maxMembers: policy?.budget?.max_members ?? sys.maxMembers,
    maxTokens: policy?.budget?.max_tokens ?? sys.maxTokens,
    maxDepth: policy?.budget?.max_depth ?? sys.maxDepth,
  }
  const history: SnapshotHistoryEntry[] = [
    { at: Date.now(), by: 'system', note: policy ? '成队:按团队 YAML policy 段生成初始快照' : '成队:系统默认快照(=现状语义)' },
  ]
  return {
    grants,
    defaultMemberGrants,
    budget,
    source: policy ? 'template' : 'default',
    createdAt: Date.now(),
    history,
  }
}

/** 有效授权(解冻态叠加:lead 被解冻时 restoredGrants 临时并入) */
function effectiveGrants(snapshot: TeamSnapshot, member: string, agent?: string): AtomGrant[] {
  const base = resolveGrants(snapshot, member, agent)
  if (member === 'lead' && snapshot.unfreeze) {
    return [...new Set([...base, ...snapshot.unfreeze.restoredGrants])]
  }
  return base
}

/**
 * 授权查找统一回退链(SSOT,网关/拉新门/执行豁免共用):
 * 精确成员名 → 去派生后缀(reader-a-2→reader-a,uniqueMemberName 的派生规则)→ 模板名 → defaultMemberGrants;
 * 快照缺失 = 默认语义(lead 全权/成员缺省)。
 */
export function resolveGrants(snapshot: TeamSnapshot | undefined, member: string, agent?: string): AtomGrant[] {
  if (!snapshot) return member === 'lead' ? [...LEAD_DEFAULT_GRANTS] : [...DEFAULT_MEMBER_GRANTS]
  const stem = member.replace(/-\d+$/, '')
  return (
    snapshot.grants[member] ??
    (stem !== member ? snapshot.grants[stem] : undefined) ??
    (agent ? snapshot.grants[agent] : undefined) ??
    snapshot.defaultMemberGrants
  )
}

/** grant 命中判定:'*' 全权;工具级授权覆盖其 action 级('team_board' 覆盖 'team_board:claim');action 级精确匹配 */
function grantCovers(list: AtomGrant[], grant: AtomGrant): boolean {
  if (list.includes('*')) return true
  if (list.includes(grant)) return true
  const toolLevel = grant.split(':')[0]
  return grant.includes(':') && list.includes(toolLevel)
}

/** 是否持有某原子授权;快照缺失 = 默认语义(向后兼容红线);agent 用于回退链(按模板授权) */
export function hasGrant(snapshot: TeamSnapshot | undefined, member: string, grant: AtomGrant, agent?: string): boolean {
  if (!snapshot) {
    return member === 'lead' || DEFAULT_MEMBER_GRANTS.some((d) => grantCovers([d], grant) || d === grant || (grant.startsWith('team_board:') && d === 'team_board'))
  }
  return grantCovers(effectiveGrants(snapshot, member, agent), grant)
}

/** 看板 action 级判定(迭代 2 门控用) */
export function canBoardAction(snapshot: TeamSnapshot | undefined, member: string, action: string): boolean {
  return hasGrant(snapshot, member, `team_board:${action}`)
}

/** 预算闸判定(迭代 3 填调用点):人数 = 硬闸;token = 扩张闸(无计量数据 null 时该闸不生效;
 *  estimated = 账本含估值时拦截理由追加"(含估值)"——估值得出的拦截必须可识别) */
export function canSpawnWithinBudget(
  snapshot: TeamSnapshot | undefined,
  currentMemberCount: number,
  spentTokens: number | null,
  estimated?: boolean,
): { ok: boolean; reason?: string } {
  const budget = snapshot?.budget
  if (!budget) return { ok: true }
  if (budget.maxMembers !== undefined && currentMemberCount + 1 > budget.maxMembers) {
    return { ok: false, reason: `团队人数预算已达上限(${currentMemberCount}/${budget.maxMembers}),不可拉新;可请示 Lead 用现有人手完成,或向用户申请追加预算` }
  }
  if (budget.maxTokens !== undefined && spentTokens !== null && spentTokens >= budget.maxTokens) {
    return { ok: false, reason: `团队 token 预算已耗尽(${spentTokens}/${budget.maxTokens})${estimated ? '(含估值)' : ''},不可拉新(扩张闸);进行中的任务不受影响,可请示 Lead 或向用户申请追加` }
  }
  return { ok: true }
}

/** token 超预算判定(UI 三层显示统一 · "运行"药丸变红/账本行标红;与扩张闸 canSpawnWithinBudget 同族同阈值):
 *  maxTokens 未设或无计量数据(null/undefined)→ false;恰好等于上限 → true(与扩张闸一致,到顶即超) */
export function isOverTokenBudget(snapshot: TeamSnapshot | undefined, ledger: TeamLedger | undefined): boolean {
  const max = snapshot?.budget?.maxTokens
  const spent = ledger?.spentTokens
  if (max === undefined || spent === null || spent === undefined) return false
  return spent >= max
}

/** 快照热更新(纯函数):校验 → 应用 → history 留痕 → 清除未收回的 unfreeze(显式布线永远覆盖探测态) */
export function applySnapshotUpdate(
  snapshot: TeamSnapshot,
  update: { grants?: Record<string, AtomGrant[]>; defaultMemberGrants?: AtomGrant[]; budget?: TeamBudget },
  by: SnapshotHistoryEntry['by'],
  note: string,
): TeamSnapshot {
  // grants 按成员合并(提交谁的改谁,其余原样保留——整表替换会把未提交的成员(尤其 lead:*)挤掉,实测陷阱)
  const grants = update.grants ? { ...snapshot.grants, ...update.grants } : snapshot.grants
  const defaultMemberGrants = update.defaultMemberGrants ?? snapshot.defaultMemberGrants
  const budget = update.budget ?? snapshot.budget
  for (const [owner, list] of Object.entries(grants)) assertLegalGrants(list, owner)
  assertLegalGrants(defaultMemberGrants, 'defaultMemberGrants')
  assertExemptionsIntact({ ...grants, '<default>': defaultMemberGrants })
  return {
    ...snapshot,
    grants,
    defaultMemberGrants,
    budget,
    source: by === 'user-direct' ? 'user-direct' : by === 'lead' ? 'lead' : snapshot.source,
    unfreeze: undefined,
    history: [...snapshot.history, { at: Date.now(), by, note }],
  }
}

/** team_policy 预算越界判定:超过系统默认上限的字段列表(系统默认未设的字段不拦;deny 文案引导用户侧调整) */
export function budgetExceedsDefaults(budget: TeamBudget): string[] {
  const sys = getTeamBudgetDefaults()
  const violations: string[] = []
  if (budget.maxMembers !== undefined && sys.maxMembers !== undefined && budget.maxMembers > sys.maxMembers) {
    violations.push(`人数上限 ${budget.maxMembers} 超过系统默认(${sys.maxMembers})`)
  }
  if (budget.maxTokens !== undefined && sys.maxTokens !== undefined && budget.maxTokens > sys.maxTokens) {
    violations.push(`token 上限 ${budget.maxTokens} 超过系统默认(${sys.maxTokens})`)
  }
  if (budget.maxDepth !== undefined && sys.maxDepth !== undefined && budget.maxDepth > sys.maxDepth) {
    violations.push(`深度上限 ${budget.maxDepth} 超过系统默认(${sys.maxDepth})`)
  }
  return violations
}

/** 快照人话摘要(team_policy read 与 /team 展示共用) */
export function summarizeSnapshot(snapshot: TeamSnapshot | undefined): string {
  if (!snapshot) return '当前无授权快照(默认语义:成员有看板/总览/请示通道,无编排工具;Lead 全权)'
  const lines: string[] = [
    `# 授权快照(来源:${snapshot.source},生成于 ${new Date(snapshot.createdAt).toLocaleString()})`,
    `预算: 人数上限 ${snapshot.budget.maxMembers ?? '不限'} / token 上限 ${snapshot.budget.maxTokens ?? '不限'} / 深度上限 ${snapshot.budget.maxDepth ?? '不限'}`,
    `新成员缺省授权: ${snapshot.defaultMemberGrants.join(', ') || '(无)'}`,
    `授权表:`,
    ...Object.entries(snapshot.grants).map(([owner, list]) => `- ${owner}: ${list.join(', ') || '(无)'}`),
  ]
  if (snapshot.unfreeze) {
    lines.push(`⚠️ 当前处于解冻态(${snapshot.unfreeze.by} 于 ${new Date(snapshot.unfreeze.at).toLocaleString()}:${snapshot.unfreeze.reason};临时恢复 ${snapshot.unfreeze.restoredGrants.join(', ')})`)
  }
  const recent = snapshot.history.slice(-5)
  if (recent.length > 0) {
    lines.push('最近变更:')
    for (const h of recent) lines.push(`- [${new Date(h.at).toLocaleString()}] ${h.by}: ${h.note}`)
  }
  return lines.join('\n')
}
