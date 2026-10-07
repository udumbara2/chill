/**
 * task 委派工具（T1：从旧调度器专属下沉为普通内置工具）
 *
 * 职责：
 * - task 工具定义（schema 完整保留 override_parameters）
 * - task 工具执行：经 TaskExecutor.executeFromToolCall 路由到 Subagent 执行层
 * - 同一轮多个 task toolCall 并行执行（Promise.all）
 * - 进度经 eventBus 发 SUBAGENT_TASK_STARTED / COMPLETED / FAILED 事件（COMPLETED 携带 taskOutput）
 * - 传给 Subagent 的工具集过滤编排工具（防无限套娃）
 *
 * 执行位置：引擎所在进程（CLI 进程 / UI 渲染进程）直接执行；
 * Subagent 的 Worker 执行由 TaskExecutor 注入的适配器路由（UI 侧经 IPC 到 electron 主进程），
 * 因此本模块不需要 requiresNodeFs 声明。
 */

import type { ToolCall, ToolDefinition } from '../../types/models'
import type { ToolMetadata, TaskToolOutput, TaskToolInput } from '../../orchestrator/types'
import { TaskExecutionStatus } from '../../orchestrator/types'
import { getTaskExecutor, isTaskExecutorInitialized } from '../../orchestrator/executor/TaskExecutor'
import { eventBus, EVENTS } from '../../utils/eventBus'
import { getTaskRegistry, type RegisteredTask, type RegisteredTaskStatus, type TaskRegistry } from './taskRegistry'
import { getApprovalChannel } from '../approvals'
import { getDelegationQuotaError } from './quota'
import { getTeamRuntimeService } from '../team/TeamRuntimeService'
import { buildWorkerToolDefinitions, checkSpawnGates, computeGrantedOrchestration, enrollWorkerSpawn, resolveSpawnCaller } from '../collab/admission'
import type { TeamInboxMessage } from '../team/teamRuntimeTypes'
import { boardSettleBridge } from '../board/boardSettleBridge'
import { getSessionBoardService, type SessionBoardService } from '../board/SessionBoardService'
import { boardBindingCandidate, type BoardBindingCandidateState, type BoardItem } from '../board/boardTypes'

/**
 * task 工具定义（单一事实源）
 * override_parameters 完整保留（model/max_iterations/token_budget/timeout/temperature）——
 * 分配时动态选模型依赖它，执行侧合并逻辑在 TaskExecutor.validateAndMergeParameters。
 */
export const taskToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'task',
    description:
      '分配任务给指定的 Subagent 执行。使用此工具将子任务分派给专门的 Subagent 处理。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '任务唯一标识符',
        },
        subagent_type: {
          type: 'string',
          description: 'Subagent 类型标识符，对应模板中的 subagent_type',
        },
        task_description: {
          type: 'string',
          description: '任务描述，说明需要 Subagent 完成的具体工作',
        },
        success_criteria: {
          type: 'string',
          description: '任务的可量化成功标准，用于评估Subagent执行结果是否达标',
        },
        require_review: {
          type: 'boolean',
          description: '是否要求验证闭环：任务完成后由独立评审 agent 对照成功标准核验证据，不达标打回修正（最多 2 轮）。代码修改、重要交付物等需要结果可信时设为 true；会显著增加延迟',
        },
        available_tools: {
          type: 'array',
          description: '分配给 Subagent 的工具名称列表（优先级链：显式名单 = 覆盖模板默认；["none"] = 显式零工具；不指定/空 = 跟随模板默认，模板未声明 tools 则为零工具）。名称须从委派指南的可用工具清单精确照抄，关键字精确小写',
          items: {
            type: 'string',
            description: '工具名称',
          },
        },
        override_parameters: {
          type: 'object',
          description: '可选的参数覆盖，用于覆盖模板的默认配置',
          properties: {
            max_iterations: {
              type: 'number',
              description: '最大迭代次数',
            },
            token_budget: {
              type: 'number',
              description: 'Token 预算',
            },
            timeout: {
              type: 'number',
              description: '超时时间（秒）',
            },
            temperature: {
              type: 'number',
              description: '温度参数',
            },
            model: {
              type: 'string',
              description: '覆盖默认模型',
            },
            max_tokens: {
              type: 'number',
              description: '最大输出 Token 数（thinking 模型建议 ≥32000，推理 token 与正文共享配额）',
            },
          },
        },
        as_teammate: {
          type: 'boolean',
          description: '团队身份（可选）：当前无活动团队时设为 true = 组建临时团队（ad-hoc 成队）；有活动团队时委派默认入队，无需传此参数，显式传 false 表示派队外零工。团队成员可使用 team_board/team_status 共享看板协作',
        },
        member_name: {
          type: 'string',
          description: '成员名（可选，仅入队时生效；默认取 subagent_type，撞名自动派生 -2/-3 后缀；同模板派多个实例时用于区分）',
        },
        require_plan: {
          type: 'boolean',
          description: '计划批准门（可选）：成员先出只读计划（无修改性工具），交付后你用 approve_plan(task_id, approved, feedback?) 批准开工或打回修订（最多两轮）。用于重要交付物；显著增加 token 消耗',
        },
        board_item_id: {
          type: 'string',
          description:
            '看板工作单元 id（可选；但重派/接续一件已在板上的活**必须**给）：本次执行做的是哪件活——系统在该条目上开始一次尝试（认领或换绑），不再新挂一行。' +
            '失败回流条目的 id 会在【后台任务完成通知】里给出；也可用 board/team_board 的 read 查看。' +
            '不给它、而看板上还有待处置的失败活时，派活会被拒绝并要求表态（见 new_work）。',
        },
        new_work: {
          type: 'boolean',
          description:
            '声明"这次是一件新活"（可选）：确认与看板上那几件待重派/待裁决的活无关时置 true。' +
            '不给 board_item_id 也不给 new_work、而看板上还有待处置的失败活时，派活会被拒绝（防同一件活被重复挂成两行）。',
        },
      },
      required: ['task_id', 'subagent_type', 'task_description', 'success_criteria'],
    },
  },
}


/**
 * 委派执行上下文：执行 task 时提供给 Subagent 的工具视图
 */
export interface DelegationContext {
  /** 工具元信息列表，用于在模型未指定 available_tools 时提供默认值 */
  toolMetadata: ToolMetadata[]
  /** 工具定义列表，传给 Subagent（执行层会再过滤一次编排工具） */
  toolDefinitions: ToolDefinition[]
  /**
   * 后台任务落地回调（引擎侧绑定，T2）：任务完成/失败时调用，
   * 驱动占位写回与批次汇报；缺省时静默跳过（注册表终态与事件照常）。
   */
  notifyTaskSettled?: (toolCallId: string, output: TaskToolOutput) => void
  /** 会话工作目录（per-agent 记忆 project/local 作用域解析用；与 AssembleContext.workDir 同源） */
  workDir?: string
}

/**
 * 委派上下文提供者：由宿主/引擎在装配工具集时注册（T2 ChatEngine），
 * 使 task 执行时能看到与当轮对话一致的全量工具集（内置 + MCP + agent 资源）。
 * 未注册时由内置工具统一入口（builtInToolExecutor）提供内置工具集兜底。
 */
let delegationContextProvider: (() => DelegationContext) | null = null

export function setDelegationContextProvider(provider: (() => DelegationContext) | null): void {
  delegationContextProvider = provider
}

/**
 * 委派 hooks 派发器（阶段 4；引擎构造时注册，仿 setDelegationContextProvider 先例）：
 * PreDelegation（preflight 调用点前，deny 拒绝委派、reason 反馈模型）/
 * PostDelegation（settle 链，注入式，携带任务结果摘要）。
 * 未注册时两挂载点零开销短路。
 */
export interface DelegationHookDispatcher {
  /** PreDelegation：返回 deny 原因 = 拒绝委派；undefined = 放行 */
  preDelegation(call: { toolCallId: string; toolName: string; args: Record<string, unknown> }): Promise<string | undefined>
  /** PostDelegation：任务 settle 后触发（注入式；output 为任务终态输出） */
  postDelegation(call: { toolCallId: string; toolName: string; args: Record<string, unknown>; output: TaskToolOutput }): Promise<void>
}

let delegationHookDispatcher: DelegationHookDispatcher | null = null
/** 2.3：handle → 引擎派发器（多引擎委派 hook 各回各 runner；键 = SessionScope 句柄） */
const delegationHookDispatchersByHandle = new Map<string, DelegationHookDispatcher>()

export function setDelegationHookDispatcher(dispatcher: DelegationHookDispatcher | null): void {
  delegationHookDispatcher = dispatcher
}

/** 2.3：按 handle 注册引擎派发器（与 SessionScope 同句柄；dispose 对称注销） */
export function registerDelegationHookDispatcher(handle: string, dispatcher: DelegationHookDispatcher): void {
  delegationHookDispatchersByHandle.set(handle, dispatcher)
}

export function unregisterDelegationHookDispatcher(handle: string): void {
  delegationHookDispatchersByHandle.delete(handle)
}

/** 当前 legacy 单槽（dispose 身份核对用：仅当还是自己才清，防拆别人通道） */
export function getLegacyDelegationHookDispatcher(): DelegationHookDispatcher | null {
  return delegationHookDispatcher
}

/**
 * 归因解析（2.3）：__origin.handle 直查 →（task→engineHandle）→ handle 派发器；
 * 无归因回退 legacy 单槽（现状语义，逐位不变）。
 */
function resolveDelegationHookDispatcher(args: Record<string, unknown>): DelegationHookDispatcher | null {
  const origin = args.__origin as { handle?: string; taskId?: string } | undefined
  let handle = typeof origin?.handle === 'string' && origin.handle ? origin.handle : undefined
  if (!handle && origin?.taskId) {
    handle = getTaskRegistry().getByToolCallId(origin.taskId)?.engineHandle
  }
  if (handle) {
    const keyed = delegationHookDispatchersByHandle.get(handle)
    if (keyed) return keyed
  }
  return delegationHookDispatcher
}

/** 解析 task 入参（hooks 载荷用；解析失败给空对象，执行路径自行报错） */
function parseTaskArgsForHooks(toolCall: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(toolCall.function.arguments)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** PreDelegation hook 派发：返回 deny 原因 = 拒绝委派；hooks 故障 fail-open 放行（双保险） */
async function runPreDelegationHooks(toolCall: ToolCall): Promise<string | undefined> {
  const args = parseTaskArgsForHooks(toolCall)
  // 2.3 归因解析：__origin.handle →（task→engineHandle）→ 引擎派发器；无归因回退单槽
  const dispatcher = resolveDelegationHookDispatcher(args)
  if (!dispatcher) return undefined
  try {
    return await dispatcher.preDelegation({
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name ?? 'task',
      args,
    })
  } catch {
    return undefined
  }
}

/** PostDelegation hook 派发（注入式；hooks 故障静默，不反向影响执行） */
async function runPostDelegationHooks(toolCall: ToolCall, output: TaskToolOutput): Promise<void> {
  const dispatcher = resolveDelegationHookDispatcher(parseTaskArgsForHooks(toolCall))
  if (!dispatcher) return
  try {
    await dispatcher.postDelegation({
      toolCallId: toolCall.id,
      toolName: toolCall.function?.name ?? 'task',
      args: parseTaskArgsForHooks(toolCall),
      output,
    })
  } catch {
    /* hooks 故障静默 */
  }
}

/**
 * 读取当轮委派上下文（执行侧零签名透传通道；未注册返回 null）。
 * StandardSubagentExecutor 解析 per-agent 记忆 workDir 用——
 * 依赖方向与本模块的 taskRegistry 消费方一致（orchestrator → services/delegation）。
 */
export function getDelegationContext(): DelegationContext | null {
  try {
    return delegationContextProvider?.() ?? null
  } catch {
    return null
  }
}

/**
 * SUBAGENT_TASK_* 事件载荷
 */
export interface SubagentTaskEventPayload {
  /** 任务唯一标识（toolCall.id） */
  taskId: string
  /** Subagent 类型标识符（解析自 toolCall 参数，解析失败为 'unknown'） */
  subagentType: string
  /** 任务描述（解析自 toolCall 参数） */
  description: string
  /** 原始工具调用 */
  toolCall: ToolCall
  /** 任务输出（仅 COMPLETED / FAILED 事件携带） */
  taskOutput?: TaskToolOutput
}

/**
 * 单个 task 的执行结果
 */
export interface DelegationTaskResult {
  toolCall: ToolCall
  taskOutput: TaskToolOutput
}

/**
 * 从 toolCall 参数中解析事件载荷所需信息
 */
function buildEventPayload(toolCall: ToolCall): SubagentTaskEventPayload {
  let subagentType = 'unknown'
  let description = ''
  try {
    const args = JSON.parse(toolCall.function.arguments)
    subagentType = args.subagent_type ?? 'unknown'
    description = args.task_description ?? ''
  } catch {
    // 参数解析失败不阻断执行，事件载荷用兜底值
  }
  return {
    taskId: toolCall.id,
    subagentType,
    description,
    toolCall,
  }
}

/**
 * 执行单个 task（异常兜底为 FAILED 输出）
 */
async function executeOne(
  toolCall: ToolCall,
  toolMetadata: ToolMetadata[],
  subagentTools?: ToolDefinition[],
  teamMember?: boolean,
  inboxNote?: string,
  requirePlan?: boolean,
  grantedOrchestrationTools?: string[]
): Promise<TaskToolOutput> {
  try {
    return await getTaskExecutor().executeFromToolCall(toolCall, toolMetadata, subagentTools, teamMember, inboxNote, requirePlan, grantedOrchestrationTools)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Task 工具执行失败'
    console.error(`[delegation] Task 工具执行失败:`, errorMessage)
    return {
      status: TaskExecutionStatus.FAILED,
      final_output: '',
      error_info: {
        code: 'EXECUTION_ERROR',
        message: errorMessage,
      },
    }
  }
}

/** 解析 toolCall 参数（登记与占位用；解析失败用兜底值，不阻断执行） */
function parseTaskArgs(toolCall: ToolCall): { taskId: string; subagentType: string; description: string } {
  try {
    const args = JSON.parse(toolCall.function.arguments)
    return {
      taskId: args.task_id ?? toolCall.id,
      subagentType: args.subagent_type ?? 'unknown',
      description: args.task_description ?? '',
    }
  } catch {
    return { taskId: toolCall.id, subagentType: 'unknown', description: '' }
  }
}

/**
 * 发起引擎句柄提取（2.3 Worker 归属路由）：从 __origin.handle 拷贝进 RegisteredTask.engineHandle。
 * 无 __origin（老调用/异常路径）为 undefined = 回退 legacy 单槽。
 */
function handleOfOrigin(origin: unknown): string | undefined {
  const handle = (origin as { handle?: unknown } | undefined)?.handle
  return typeof handle === 'string' && handle ? handle : undefined
}

/** 从 toolCall 参数的 __origin 提取发起引擎句柄（登记拷贝用） */
function engineHandleOf(toolCall: ToolCall): string | undefined {
  return handleOfOrigin(parseTaskArgsForHooks(toolCall).__origin)
}

/**
 * 团队成员判定与登记(会话级团队身份:有活动团队默认入队、as_teammate=false 退出;
 * 无活动团队时 as_teammate=true 组建 ad-hoc 临时队)。
/** 信箱未读拼入文本(种子注入的统一 drain 形态;限长防爆,更早的指引翻信箱档案) */
function formatInboxNote(undelivered?: TeamInboxMessage[]): string | undefined {
  if (!undelivered || undelivered.length === 0) return undefined
  const lines = undelivered.map((m) => `- [${new Date(m.at).toLocaleString()}] ${m.from}: ${m.content}`)
  const note = `\n\n【信箱未读 ${undelivered.length} 条,按时间序】\n${lines.join('\n')}`
  return note.length > 6000 ? `${note.slice(0, 6000)}\n…(更早的未读见团队目录信箱档案)` : note
}

/**
 * settle/cancel 统一回写花名册(delegationTools 全部 settle 站点调用;
 * 未登记为成员的任务是无操作;已离开 running 的条目幂等忽略——取消后 destroy 的二次 settle 不会误覆写;
 * requirePlan 仅用于 planPending 置真判定:completed 且 plan 任务才置真,其余一律置假)
 */
function syncTeamRosterOnSettle(toolCallId: string, taskOutput: TaskToolOutput, requirePlan?: boolean): void {
  getTeamRuntimeService()?.syncOnTaskSettle(
    toolCallId,
    taskOutput.status === TaskExecutionStatus.COMPLETED ? 'completed' : 'failed',
    toolCallId,
    requirePlan,
    taskOutput.final_output,
  )
  // 账本(迭代 3):token 消耗入账——全部 settle 站点经此,聚合 Worker resource_usage;无计量数据不入账;
  // 估值标记透传(账本 estimated 单向置位,展示标 ~)
  getTeamRuntimeService()?.addTokenSpend(taskOutput.resource_usage?.tokens_used, taskOutput.resource_usage?.tokens_estimated)
}

/**
 * settle/cancel 统一咽喉(4 站点共用;V1.5 settle bridge 单点挂接):
 * team 半边调用形态与原站点一字不动——completed/failed 走 syncTeamRosterOnSettle(含账本),
 * cancelled 走原 executeCancelTask 的直调形态(取消路径不入账本);board 半边挂 boardSettleBridge
 * (boardCore.onTaskSettle:completed 自动结项 / failed|cancelled 死亡回流)。
 * V3.1 拉活:completed 后该工位留有「已认领未绑」条目 → 同工位带种子续跑(意图条目换绑新键)。
 */
export async function settleTaskSurfaces(
  toolCallId: string,
  outcome: 'completed' | 'failed' | 'cancelled',
  opts?: { taskOutput?: TaskToolOutput; requirePlan?: boolean; originArgs?: Record<string, unknown>; sync?: boolean },
): Promise<void> {
  if (outcome === 'cancelled') {
    getTeamRuntimeService()?.syncOnTaskSettle(toolCallId, 'cancelled')
  } else if (opts?.taskOutput) {
    syncTeamRosterOnSettle(toolCallId, opts.taskOutput, opts.requirePlan === true)
  }
  // 计划批准门（M7 增量 2）：阶段 1（只读规划）completed **不等于活干完**——team 半边早有此规则
  //（planPending 置真并跳过团队板结项），会话板半边此前漏了这道门 → 行会假报「已交付」且内容只是计划文本。
  // 两侧同规则：计划待批准期间不结项，行保持 in_progress，等 approve_plan 的续跑（按 resume 绑定规则回同一行）。
  const planPhaseOnly = outcome === 'completed' && opts?.requirePlan === true
  if (!planPhaseOnly) {
    const boardHalf = await boardSettleBridge(
      toolCallId,
      outcome,
      outcome === 'completed' ? { result: opts?.taskOutput?.final_output } : undefined,
    )
    // 回流/冻结条目 id 带进完成通知（M7 增量 2）：让"重派"成为自然动作，而不是要模型自己去查板
    const touched = [...boardHalf.reflowedIds, ...boardHalf.frozenIds]
    if (touched.length > 0) getTaskRegistry().markBoardReflow(toolCallId, touched)
  }
  // V3.1 拉活续跑:仅 completed(死亡回流路径条目已回池,无"已认领未绑"存留);-p 同步路径不拉
  // (同步执行随进程退出收尾,后台续跑会变孤儿);续跑失败只告警——意图条目留 in_progress 供 Lead release/cancel 清场
  if (outcome === 'completed' && opts?.sync !== true) {
    void continueIntentWork(toolCallId, opts?.originArgs).catch((err) =>
      console.warn(`【看板】拉活续跑异常(taskId=${toolCallId}):`, err),
    )
  }
}

/**
 * V3.1 拉活三步之三:同工位带种子 spawn 续跑。
 * 识别=板工位索引反查工位 →「已认领未绑任务」条目(assignee=工位 && claimedByTaskId 空 && in_progress,
 * 最早挂起者优先);续跑入口=executeResumeTask(prior_messages 种子,1 任务=1 进程=1 toolCallId 不变);
 * spawn 成功即换绑 claimedByTaskId=新 toolCallId(换绑先例 TeamRuntimeService.resumeMember)。
 * 拉活不新建板条目——它就是被认领那条的执行(boardContinuation 抑制自动 post+claim)。
 */
async function continueIntentWork(settledTaskId: string, originArgs?: Record<string, unknown>): Promise<void> {
  const svc = getSessionBoardService()
  if (!svc) return
  const sessionId = svc.sessionIdOfTask(settledTaskId)
  if (!sessionId) return
  const workstation = svc.workstationOf(sessionId, settledTaskId)
  if (!workstation) return
  const next = svc.findIntentItems(sessionId, workstation)[0]
  if (!next) return
  const newCallId = `intent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const origin = originArgs?.__origin
  const result = await executeResumeTask(
    newCallId,
    {
      toolCallId: settledTaskId,
      message:
        `续跑看板条目 [${next.id}] ${next.title}` +
        (next.description ? `\n\n${next.description}` : '') +
        '\n\n(这是你在看板上已认领的下一条;完成即自动结项,进展用 board update 写 note)',
      ...(origin !== undefined ? { __origin: origin } : {}),
    } as ResumeTaskInput,
    { boardContinuation: { sessionId, itemId: next.id } },
  )
  if (!result.success) {
    console.warn(`【看板】拉活续跑未启动(条目 [${next.id}] 保持在办,可 release/取消清场): ${result.error}`)
  }
}

/** 板条目 title=任务标题/摘要(首行截断 80 字) */
function summarizeBoardTitle(description: string): string {
  const firstLine = (description ?? '').split('\n')[0].trim()
  if (!firstLine) return '(未命名任务)'
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
}

/** 派活挂板的结构化结局（M7 增量 2）：门拒绝/绑定失败走返回值，**不抛异常**——
 *  既有挂项 catch 会把异常降级成 warning，而门拒绝必须响亮（不哑）。 */
export interface BoardAttachOutcome {
  ok: boolean
  /** ok=false 时的拒绝码：需表态（有回流态活但没说明关系）／绑定目标无效 */
  code?: 'BOARD_BINDING_REQUIRED' | 'BOARD_BINDING_INVALID'
  reason?: string
}

/** 派活发起侧的会话归属解析（与 autoPostAndClaim 同源：__origin.sessionId；嵌套委派经 parentTaskId 反查板） */
function originSessionId(svc: SessionBoardService, originArgs?: Record<string, unknown>): string | undefined {
  const origin = originArgs?.__origin as { sessionId?: string; taskId?: string } | undefined
  return origin?.sessionId ?? (origin?.taskId ? svc.sessionIdOfTask(origin.taskId) : undefined)
}

/** 门候选 = 会话板 ∪ 活动团队板里的「待处置失败活」（判据单点在 boardTypes.boardBindingCandidate） */
async function collectBindingCandidates(
  svc: SessionBoardService,
  sessionId: string,
): Promise<Array<{ itemId: string; title: string; state: BoardBindingCandidateState }>> {
  const out: Array<{ itemId: string; title: string; state: BoardBindingCandidateState }> = []
  const push = (items: BoardItem[]): void => {
    for (const item of items) {
      const state = boardBindingCandidate(item)
      if (state) out.push({ itemId: item.id, title: item.title, state })
    }
  }
  push((await svc.readBoard(sessionId)).items)
  const teamItems = getTeamRuntimeService()?.boardList()?.items
  if (teamItems) push(teamItems)
  return out
}

/** 拒绝文案里的两条出路（门与绑定校验共用，措辞一致防模型学歪） */
const BOARD_ITEM_HINT = '若这是看板上那件活的重派/接续：带 board_item_id="<上面的 id>" 重新派活（同一件活只占一行）；'
const NEW_WORK_HINT = '若这是一件新活：带 new_work: true 重新派活。'

/**
 * 派活前的看板绑定裁决（M7 增量 2 条件门；只读、无副作用、可单测）：
 * - **只对 Lead/主会话生效**：`__origin.source==='subagent'` 的嵌套派活直接放行（worker 的子工作单元
 *   不可能知道会话里那条回流活的来历，拦它只是噪声）；
 * - 给了 `board_item_id` → 校验该条存在且可作为本次尝试的目标（容器：会话板 → 活动团队板）；
 * - 没给且未声明 `new_work` → 存在「待处置失败活」时拒绝，点名候选并给两条出路；
 * - 无候选 / 无会话归属 / 未装配看板 → 放行（零摩擦）。
 * @returns null = 放行；否则 = 拒绝文案
 */
export async function boardBindingGate(args: Record<string, unknown>): Promise<string | null> {
  const origin = args.__origin as { source?: string; taskId?: string } | undefined
  if (origin?.source === 'subagent') return null
  const svc = getSessionBoardService()
  if (!svc) return null
  const sessionId = originSessionId(svc, args)
  if (!sessionId) return null
  const boardItemId =
    typeof args.board_item_id === 'string' && args.board_item_id.trim() ? args.board_item_id.trim() : undefined

  if (boardItemId) {
    const inSession = (await svc.readBoard(sessionId)).items.find((i) => i.id === boardItemId)
    const inTeam = inSession ? undefined : getTeamRuntimeService()?.boardGet(boardItemId)
    if (!inSession && !inTeam) {
      return (
        `board_item_id="${boardItemId}" 在看板上找不到（会话板与活动团队板都没有）。` +
        `请核对 id；${NEW_WORK_HINT}`
      )
    }
    const target = inSession ?? inTeam!
    if (target.status === 'failed') {
      return (
        `看板条目 ${boardItemId}「${target.title}」处于待裁决（连续失败 ${target.failCount ?? 2} 次），不能直接复用。` +
        `请先裁决回池（board/team_board 的 adjudicate decision="retry"），再带 board_item_id 派活；不要另起一行。`
      )
    }
    if (target.status === 'completed' || target.status === 'cancelled') {
      return (
        `看板条目 ${boardItemId}「${target.title}」已是${target.status === 'completed' ? '已交付' : '已取消'}终态，不可复用。` +
        NEW_WORK_HINT
      )
    }
    if ((target.status === 'in_progress' || target.status === 'blocked') && target.claimedByTaskId) {
      return (
        `看板条目 ${boardItemId}「${target.title}」正由 ${target.claimedByTaskId} 执行中，不能改派给另一个执行者。` +
        `若它已停/已死，请先 board / team_board 的 release（退回池）或 cancel_item 清场，再带 board_item_id 重派。`
      )
    }
    return null
  }

  if (args.new_work === true) return null
  const candidates = await collectBindingCandidates(svc, sessionId)
  if (candidates.length === 0) return null
  const lines = candidates.map(
    (c) =>
      `- ${c.itemId}「${c.title}」` +
      (c.state === 'reflowed' ? '（上一轮执行失败/中断后回池，待重派）' : '（待裁决：连续失败，先 adjudicate retry）'),
  )
  return (
    `看板上还有 ${candidates.length} 件待处置的失败活，本次派活没有说明它和它们的关系：\n` +
    `${lines.join('\n')}\n${BOARD_ITEM_HINT}\n${NEW_WORK_HINT}`
  )
}

/**
 * 派活挂板（M7 增量 2 唯一入口，替代 V1.5 的无条件 autoPostAndClaim）：
 * 给了 `board_item_id` → 在该工作单元上开始一次尝试（容器：会话板 → 活动团队板）；
 * 否则 → 过条件门后照旧新挂一行（新工作单元）。
 * 安全网：调用方未置 `skipBindingGate` 时先过门（`-p` 无预检，靠这里兜底；交互/batch 已在预检拦下，这里是竞态兜底）；
 * 追问路径置真跳过（追问不产生幽灵，不必被牵连）。
 * 非会话路径与未装配 SessionBoardService 时无操作（不隐式建板，现状）。
 */
async function attachOrCreateBoard(opts: {
  toolCallId: string
  subagentType: string
  description: string
  batchId: string
  originArgs?: Record<string, unknown>
  /** 团队成员名（enroll 后的权威值）；团队板条目绑定时的 assignee 用它 */
  memberName?: string
  skipBindingGate?: boolean
}): Promise<BoardAttachOutcome> {
  const svc = getSessionBoardService()
  if (!svc) return { ok: true }
  const sessionId = originSessionId(svc, opts.originArgs)
  if (!sessionId) return { ok: true }
  const raw = typeof opts.originArgs?.board_item_id === 'string' ? opts.originArgs.board_item_id.trim() : ''
  const boardItemId = raw.length > 0 ? raw : undefined

  if (!boardItemId && opts.skipBindingGate !== true) {
    const denial = await boardBindingGate(opts.originArgs ?? {})
    if (denial) return { ok: false, code: 'BOARD_BINDING_REQUIRED', reason: denial }
  }

  if (boardItemId) {
    try {
      const inSession = (await svc.readBoard(sessionId)).items.find((i) => i.id === boardItemId)
      if (inSession) {
        await svc.attachAttempt(sessionId, boardItemId, {
          claimedByTaskId: opts.toolCallId,
          subagentType: opts.subagentType,
        })
        return { ok: true }
      }
      const teamSvc = getTeamRuntimeService()
      if (teamSvc?.boardGet(boardItemId)) {
        await teamSvc.attachAttempt(boardItemId, opts.toolCallId, opts.memberName ?? opts.subagentType)
        return { ok: true }
      }
      return {
        ok: false,
        code: 'BOARD_BINDING_INVALID',
        reason: `board_item_id="${boardItemId}" 在看板上找不到。请核对 id；${NEW_WORK_HINT}`,
      }
    } catch (err) {
      // 绑定被状态机拒绝（待裁决/终态/并发已被认领）：响亮回绝，绝不静默另起一行
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`【看板】派活绑定失败(条目 ${boardItemId}):`, err)
      return { ok: false, code: 'BOARD_BINDING_INVALID', reason }
    }
  }

  // 直跑自动 post+claim(V1.5:spawn 即认领,永无 pending;工位=subagentType·短序号)——新工作单元路径
  await svc
    .autoPostAndClaim({
      sessionId,
      batchId: opts.batchId,
      taskId: opts.toolCallId,
      subagentType: opts.subagentType,
      title: summarizeBoardTitle(opts.description),
      description: opts.description || undefined,
    })
    .catch((err) => console.warn('【看板】自动挂项失败:', err))
  return { ok: true }
}

/**
 * 后台受理占位（TaskToolOutput 形态，status=RUNNING）：
 * 单 task（builtInToolExecutor case 'task'）与多 task（ChatEngine buildTaskToolMessage）
 * 两处组装沿用现有形态；写回由 notifyTaskSettled 驱动。
 */
function buildPlaceholderOutput(taskId: string): TaskToolOutput {
  return {
    status: TaskExecutionStatus.RUNNING,
    final_output:
      `任务已受理，后台执行中（任务标识: ${taskId}），完成时会收到通知，届时请整合结果答复用户；` +
      '在收到通知前不要假设任务已有结果。',
  }
}

/**
 * 委派执行选项
 */
export interface ExecuteTaskOptions {
  /** 同步执行（chill -p 非交互特判）：不登记后台任务、不返回占位，await 真实执行结果 */
  sync?: boolean
}

/**
 * settle 留存（resume_task 的 transcript 来源）：任务成功且 Worker 带回 conversation 时，
 * 把执行上下文留存进注册表 transcript 区（每次成功执行都刷新，追问链可持续）。
 * 与任务注册解耦——-p 同步路径不注册条目，transcript 照存。
 */
function retainTranscriptFromOutput(toolCall: ToolCall, taskOutput: TaskToolOutput, effectiveRequirePlan?: boolean): void {
  if (taskOutput.status !== TaskExecutionStatus.COMPLETED || !taskOutput.conversation) return
  try {
    const args = JSON.parse(toolCall.function.arguments)
    // 团队成员钉住(本函数在 settle 回写前调用,currentTaskId 仍有效;钉住后团队存续期间成员上下文不经 LRU 蒸发)
    const teamSvc = getTeamRuntimeService()
    const memberName = teamSvc?.getMemberNameByTaskId(toolCall.id)
    getTaskRegistry().retainTranscript(toolCall.id, {
      messages: taskOutput.conversation,
      subagentType: args.subagent_type ?? 'unknown',
      taskDescription: args.task_description ?? '',
      successCriteria: args.success_criteria,
      availableTools: args.available_tools,
      overrideParameters: args.override_parameters,
      requireReview: args.require_review,
      pinned: !!memberName,
      teamId: memberName ? teamSvc?.getActiveTeam()?.runId : undefined,
      memberName,
      // 计划批准门:记录"有效值"而非原始参数——YAML plan_first 驱动的任务原始 args 没有 require_plan,
      // 不写有效值会导致 approve_plan 校验误拒(实测 bug)
      requirePlan: (effectiveRequirePlan ?? args.require_plan === true) ? true : undefined,
      planOriginalTools: (effectiveRequirePlan ?? args.require_plan === true) ? args.available_tools : undefined,
    })
  } catch {
    // 参数解析失败不阻断 settle（注册表终态与事件照常）
  }
}

/**
 * 执行同一轮的多个 task 工具调用（默认非阻塞后台化）：
 * - 交互模式（默认）：先逐 task 做可启动性预检（preflight，登记注册表之前）——
 *   预检不过的 task 同步返回工具错误（不登记、无占位、不发事件、无后续通知），
 *   杜绝"启动即失败"的幽灵通知；通过的 task 登记注册表（同轮多 task 共享一个 batchId，
 *   单个独立成批）后立即返回占位结果，真实执行在后台继续——settle 时落注册表终态、
 *   发 COMPLETED/FAILED 事件、经 DelegationContext.notifyTaskSettled 回调引擎
 *   （回调缺省静默跳过）；
 * - sync（chill -p 特判）：维持旧同步语义，await 真实执行结果，不预检、不登记、不回调。
 * @param toolCalls - 同一轮的 task 工具调用数组
 * @param context - 委派执行上下文（缺省时依次取注册的提供者、空兜底）
 * @param abortController - 可选中断控制器：已进入中断态时不启动执行；
 * 启动后 abort 不再等待/打断后台任务（杀任务走 cancel_task，abort race 等待侧已退役）
 * @param options - 执行选项（sync = -p 非交互特判）
 * @returns 每个 toolCall 对应的结果（交互模式为占位或预检失败错误，sync 为真实结果）
 */
export async function executeTaskToolCalls(
  toolCalls: ToolCall[],
  context?: DelegationContext,
  abortController?: AbortController,
  options?: ExecuteTaskOptions
): Promise<DelegationTaskResult[]> {
  if (abortController?.signal.aborted) {
    throw createAbortError()
  }
  const ctx = context ?? delegationContextProvider?.() ?? { toolMetadata: [], toolDefinitions: [] }

  // 嵌套委派防护：传给 Subagent 的工具集过滤掉 task 等编排工具
  const subagentTools = buildWorkerToolDefinitions(ctx.toolDefinitions)

  // 防御性检测：getTaskExecutor 是"首个调用者定参"单例，
  // 宿主（CLI CliContext / UI main.ts）必须先于 task 执行完成注入式初始化
  if (!isTaskExecutorInitialized()) {
    console.warn(
      '[delegation] TaskExecutor 尚未由宿主注入初始化（getTaskExecutor 首个调用者定参），' +
      '本次将以无适配器配置兜底创建，Subagent 执行可能失败'
    )
  }

  const payloads = toolCalls.map(buildEventPayload)

  // 启动真实执行（两路共用的启动点；executeOne 内部全捕获，promise 不会 reject）：
  // settle 处理按路径分岔——sync 仅发事件（旧语义），后台路径落注册表 + 发事件 + 回调引擎
  const startExecution = (toolCall: ToolCall, index: number, teamMember?: boolean, inboxNote?: string, requirePlan?: boolean, grantedOrchestrationTools?: string[]): Promise<TaskToolOutput> => {
    // 定义层豁免(实测 bug 修复):有豁免时按豁免重建定义列表,否则用基础列表(不含编排工具)
    const toolsForCall = grantedOrchestrationTools && grantedOrchestrationTools.length > 0
      ? buildWorkerToolDefinitions(ctx.toolDefinitions, grantedOrchestrationTools)
      : subagentTools
    const execution = executeOne(toolCall, ctx.toolMetadata, toolsForCall, teamMember, inboxNote, requirePlan, grantedOrchestrationTools)
    execution.then(async (taskOutput) => {
      // transcript 留存（resume_task 来源；sync/交互两路同点，与任务注册解耦）
      // requirePlan 用登记点计算的有效值(YAML plan_first 驱动时原始 args 无此字段)
      retainTranscriptFromOutput(toolCall, taskOutput, requirePlan)
      // settle 咽喉(4 站点共用):花名册回写(团队成员 idle/failed;running 守卫幂等)+ 看板 settle 桥
      await settleTaskSurfaces(toolCall.id, taskOutput.status === TaskExecutionStatus.COMPLETED ? 'completed' : 'failed', {
        taskOutput,
        requirePlan: requirePlan === true,
        originArgs: parseTaskArgsForHooks(toolCall),
        sync: options?.sync === true,
      })
      if (!options?.sync) {
        getTaskRegistry().markSettled(toolCall.id, taskOutput)
      }
      const succeeded = taskOutput.status === TaskExecutionStatus.COMPLETED
      eventBus.emit(
        succeeded ? EVENTS.SUBAGENT_TASK_COMPLETED : EVENTS.SUBAGENT_TASK_FAILED,
        { ...payloads[index], taskOutput }
      )
      // PostDelegation hooks（settle 链注入式挂载点）：先落地再 notifyTaskSettled——
      // 注入确定性（引擎回流轮组装上下文前 additionalContext 已就位）
      await runPostDelegationHooks(toolCall, taskOutput)
      if (!options?.sync) {
        // 主动取消的任务：占位已由 cancel_task 写回"已取消"，
        // destroy 触发的执行失败 settle 不再覆盖占位（事件照发，展示层语义不变）
        if (getTaskRegistry().getByToolCallId(toolCall.id)?.status !== 'cancelled') {
          ctx.notifyTaskSettled?.(toolCall.id, taskOutput)
        }
      }
    })
    return execution
  }

  // sync（chill -p 特判）：维持旧同步语义——先通知全部 task 执行开始，await 全部真实执行结果
  // require_plan 在 -p 下忽略(-p 一次性,阶段 1 出计划后会话即结束,永远没有批准机会)——
  // 不静默保留,输出注明
  if (options?.sync) {
    for (const payload of payloads) {
      eventBus.emit(EVENTS.SUBAGENT_TASK_STARTED, payload)
    }
    const syncBatchId = getTaskRegistry().newBatchId()
    return await Promise.all(
      toolCalls.map(async (toolCall, index) => {
        // 成员身份入队(-p 同步分支历史缺口:只跳过注册表(维持"不登记后台任务"本意),
        // 花名册必须入队——否则 -p 单个 task 的成员永远"不在花名册内",团队工具全灭(实测)。
        // 花名册是进程内状态,进程退出即归档,无孤儿问题)
        const syncSpawnArgs = parseTaskArgsForHooks(toolCall)
        const syncMembership = await enrollWorkerSpawn({
          caller: resolveSpawnCaller(syncSpawnArgs.__origin as { source?: string; taskId?: string } | undefined),
          agent: typeof syncSpawnArgs.subagent_type === 'string' ? syncSpawnArgs.subagent_type : 'unknown',
          memberName: typeof syncSpawnArgs.member_name === 'string' ? syncSpawnArgs.member_name : undefined,
          asTeammate: syncSpawnArgs.as_teammate as boolean | undefined,
          taskId: toolCall.id,
        })
        // 派活挂板（M7 增量 2：绑定既有工作单元 / 过门后新挂一行；-p 无预检，门在此兜底）
        const syncBoard = await attachOrCreateBoard({
          toolCallId: toolCall.id,
          subagentType: typeof syncSpawnArgs.subagent_type === 'string' ? syncSpawnArgs.subagent_type : 'unknown',
          description: typeof syncSpawnArgs.task_description === 'string' ? syncSpawnArgs.task_description : '',
          batchId: syncBatchId,
          originArgs: syncSpawnArgs,
          memberName: syncMembership.memberName,
        })
        if (!syncBoard.ok) {
          // 门拒绝/绑定失败：不执行、不发 STARTED（该 toolCall 的结果即错误文案）
          return {
            toolCall,
            taskOutput: {
              status: TaskExecutionStatus.FAILED,
              final_output: '',
              error_info: {
                code: syncBoard.code ?? 'BOARD_BINDING_INVALID',
                message: syncBoard.reason ?? '看板绑定被拒',
              },
            },
          }
        }
        const result = { toolCall, taskOutput: await startExecution(toolCall, index, syncMembership.joined, formatInboxNote(syncMembership.undelivered), undefined, syncMembership.grantedOrchestrationTools) }
        if (parseTaskArgsForHooks(toolCall).require_plan === true) {
          result.taskOutput = {
            ...result.taskOutput,
            final_output:
              (result.taskOutput.final_output || '') +
              '\n\n(注:chill -p 非交互路径不支持计划批准门——阶段 1 出计划后无人批准,require_plan 已忽略,按普通任务执行)',
          }
        }
        return result
      })
    )
  }

  // 交互模式：登记前逐 task 预检（可启动性），不过的同步返回工具错误——
  // 不登记、无占位、不发 STARTED、无后续通知（防"启动即失败"的幽灵通知）；
  // 通过的登记（同轮共享 batchId）+ 立即返回占位，真实执行后台继续
  const registry = getTaskRegistry()
  const batchId = registry.newBatchId()
  const results: DelegationTaskResult[] = []
  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index]
    // 资源限额（最前置的系统状态判定）：超限与预检失败同形态同步返回——
    // 不登记、无占位、不发 STARTED、无后续通知（防幽灵通知）
    // 准入 precheck(统一协作基板:caller 解析+拉新门,唯一事实点在 collab/admission)
    // 拒绝与预检失败同形态(不登记/无占位/无幽灵通知)
    const spawnGateError = checkSpawnGates(resolveSpawnCaller((parseTaskArgsForHooks(toolCall) as Record<string, unknown>).__origin as { source?: string; taskId?: string } | undefined))
    if (spawnGateError) {
      results.push({
        toolCall,
        taskOutput: {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: { code: 'TEAM_POLICY_DENIED', message: spawnGateError },
        },
      })
      continue
    }
    const quotaError = getDelegationQuotaError()
    if (quotaError) {
      results.push({
        toolCall,
        taskOutput: {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: { code: 'QUOTA_EXCEEDED', message: quotaError },
        },
      })
      continue
    }
    // PreDelegation hooks（preflight 调用点前）：deny 拒绝委派——与预检失败同形态同步返回
    // 工具错误（reason 反馈模型），不登记、无占位、不发 STARTED、无后续通知
    const hookDenyReason = await runPreDelegationHooks(toolCall)
    if (hookDenyReason !== undefined) {
      results.push({
        toolCall,
        taskOutput: {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: { code: 'DELEGATION_DENIED', message: `委派已被拦截: ${hookDenyReason}` },
        },
      })
      continue
    }
    const preflightError = await preflightOne(toolCall)
    if (preflightError) {
      results.push({
        toolCall,
        taskOutput: {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: { code: 'PREFLIGHT_FAILED', message: preflightError },
        },
      })
      continue
    }
    const args = parseTaskArgs(toolCall)
    eventBus.emit(EVENTS.SUBAGENT_TASK_STARTED, payloads[index])
    registry.register({
      taskId: args.taskId,
      toolCallId: toolCall.id,
      subagentType: args.subagentType,
      description: args.description,
      batchId,
      ...(engineHandleOf(toolCall) ? { engineHandle: engineHandleOf(toolCall) } : {}),
    })
    // 身份解析与登记(统一协作基板:enroll 唯一事实点;预检通过后、registry.register 同点)
    const spawnArgs = parseTaskArgsForHooks(toolCall)
    const membership = await enrollWorkerSpawn({
      caller: resolveSpawnCaller(spawnArgs.__origin as { source?: string; taskId?: string } | undefined),
      agent: typeof spawnArgs.subagent_type === 'string' ? spawnArgs.subagent_type : 'unknown',
      memberName: typeof spawnArgs.member_name === 'string' ? spawnArgs.member_name : undefined,
      asTeammate: spawnArgs.as_teammate as boolean | undefined,
      taskId: toolCall.id,
    })
    // 派活挂板（M7 增量 2：绑定既有工作单元 / 过门后新挂一行；预检已拦门，这里只兜竞态）
    const boardOutcome = await attachOrCreateBoard({
      toolCallId: toolCall.id,
      subagentType: args.subagentType,
      description: args.description,
      batchId,
      originArgs: spawnArgs,
      memberName: membership.memberName,
    })
    if (!boardOutcome.ok) {
      results.push({
        toolCall,
        taskOutput: {
          status: TaskExecutionStatus.FAILED,
          final_output: '',
          error_info: {
            code: boardOutcome.code ?? 'BOARD_BINDING_INVALID',
            message: boardOutcome.reason ?? '看板绑定被拒',
          },
        },
      })
      continue
    }
    // 计划批准门:task 参数优先,YAML plan_first 成员默认带
    const requirePlan =
      (parseTaskArgsForHooks(toolCall).require_plan as boolean | undefined) ?? (membership.planFirst === true ? true : undefined)
    startExecution(toolCall, index, membership.joined, formatInboxNote(membership.undelivered), requirePlan, membership.grantedOrchestrationTools)
    const placeholder = buildPlaceholderOutput(args.taskId)
    if (membership.joined) {
      placeholder.final_output +=
        `\n已加入团队${membership.teamLabel}，成员名: ${membership.memberName}` +
        '（成员可用 team_board 认领/结项、team_status 看全局；看板与 create_task_list 私人草稿互不可见）'
    }
    results.push({ toolCall, taskOutput: placeholder })
  }
  return results
}

/**
 * 单个 task 的可启动性预检（登记注册表前调用）：
 * 解析 toolCall 参数后复用 TaskExecutor.preflightDelegation
 * （模板存在 + 模型兜底链 + baseURL + API Key，与执行路径同源）；
 * M7 增量 2 追加**看板绑定裁决**（回流态显式表态门）：拒绝即零痕迹（不登记/不挂行/无占位）。
 * @returns null = 可启动；否则为同步错误文案
 */
async function preflightOne(toolCall: ToolCall): Promise<string | null> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(toolCall.function.arguments)
  } catch {
    return '无法启动委派: task 参数不是合法 JSON'
  }
  if (!args?.subagent_type || typeof args.subagent_type !== 'string') {
    return '无法启动委派: 缺少 subagent_type 参数'
  }
  const bindingDenial = await boardBindingGate(args).catch(() => null)
  if (bindingDenial) return bindingDenial
  try {
    return await getTaskExecutor().preflightDelegation({
      task_id: (args.task_id as string) ?? toolCall.id,
      subagent_type: args.subagent_type,
      task_description: (args.task_description as string) ?? '',
      success_criteria: args.success_criteria as string | undefined,
      require_review: args.require_review as boolean | undefined,
      available_tools: args.available_tools as string[] | undefined,
      override_parameters: args.override_parameters as TaskToolInput['override_parameters'],
    })
  } catch (error) {
    // 预检自身异常（如 TaskExecutor 未注入初始化）按不可启动处理，同步报错
    return `无法启动委派: ${error instanceof Error ? error.message : '预检失败'}`
  }
}

/** 构造中断错误（与协议处理器的 'Request aborted' / AbortError 约定一致） */
function createAbortError(): Error {
  const err = new Error('Request aborted')
  err.name = 'AbortError'
  return err
}

/**
 * 执行单个 task 工具调用（内置工具统一入口 builtInToolExecutor 走这里）
 * @param toolCall - task 工具调用
 * @param context - 委派执行上下文（可选，缺省取注册的提供者或空兜底）
 * @param abortController - 可选中断控制器（T2 ChatEngine 透传）
 * @param options - 执行选项（sync = -p 非交互特判，走旧同步路径）
 * @returns Task 工具输出结果（交互模式为占位，sync 为真实结果）
 */
export async function executeTaskToolCall(
  toolCall: ToolCall,
  context?: DelegationContext,
  abortController?: AbortController,
  options?: ExecuteTaskOptions
): Promise<TaskToolOutput> {
  const results = await executeTaskToolCalls([toolCall], context, abortController, options)
  return results[0].taskOutput
}

// ============================================================
// 任务管理三工具（T3）：query_task_status / cancel_task / batch_task
// 操作对象 = 任务注册表（delegation 层单例），定义与 task 同址。
// 实现返回中立形态（success/content/error），由 builtInToolExecutor 的 case
// 适配为 BuiltInToolResult（避免本模块 → builtInToolExecutor 的反向依赖）。
// ============================================================

/** 三工具实现的中立返回形态 */
export interface TaskManagementResult {
  success: boolean
  content?: string
  error?: string
}

/** query_task_status 工具定义 */
export const queryTaskStatusToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'query_task_status',
    description:
      '查询后台委派任务的状态与结果摘要；完整结果见委派时的工具消息。task_id 或 toolCallId 指定单个任务；都不提供时列出当前全部任务（含进行中与近期落地）。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '任务标识（委派时的 task_id 参数）',
        },
        toolCallId: {
          type: 'string',
          description: '任务的工具调用标识（注册表主键）',
        },
      },
      required: [],
    },
  },
}

/** cancel_task 工具定义 */
export const cancelTaskToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'cancel_task',
    description:
      '取消一个仍在进行中的后台委派任务：销毁其 Worker 进程并把任务标记为已取消。已落地（完成/失败/已取消）的任务不可取消。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '任务标识（委派时的 task_id 参数；与 toolCallId 二选一）',
        },
        toolCallId: {
          type: 'string',
          description: '任务的工具调用标识（注册表主键；与 task_id 二选一）',
        },
      },
      required: [],
    },
  },
}

/** resume_task 工具定义 */
export const resumeTaskToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'resume_task',
    description:
      '对已完成的委派任务发起追问/纠偏：原 Subagent 保留完整执行上下文（读过的文件、运行过的命令、推理过程），从上次结束处继续工作，而不是从零重新委派。结果基本可用但需修正/补充时使用，优于重新 task。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '目标任务标识（委派时的 task_id 参数；与 toolCallId 二选一）',
        },
        toolCallId: {
          type: 'string',
          description: '目标任务的工具调用标识（注册表主键；与 task_id 二选一）',
        },
        message: {
          type: 'string',
          description: '追问/纠偏内容，是给原 Subagent 的直白指令（如"第三点改成 XX"），不要重复描述整个任务',
        },
        override_parameters: {
          type: 'object',
          description: '可选的参数覆盖（仅 timeout/model/max_tokens 生效，其余沿用原任务配置）',
          properties: {
            timeout: {
              type: 'number',
              description: '超时时间（秒）',
            },
            model: {
              type: 'string',
              description: '覆盖默认模型',
            },
            max_tokens: {
              type: 'number',
              description: '最大输出 Token 数（thinking 模型建议 ≥32000）',
            },
          },
        },
        require_review: {
          type: 'boolean',
          description: '本次追问的结果是否要求验证闭环（独立评审 agent 核验证据，最多 2 轮打回）。默认 false，不继承原任务的该标记',
        },
      },
      required: ['message'],
    },
  },
}

/** batch_task 工具定义 */
export const batchTaskToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'batch_task',
    description:
      '批量后台委派：一次把多个任务分别派给 Subagent 并行执行（共享一个批次），全部落地后统一通知整合。任务多且相互独立时使用，优于逐个 task。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '任务列表（每个成员等价于一次 task 委派）',
          items: {
            type: 'object',
            properties: {
              subagent_type: {
                type: 'string',
                description: 'Subagent 类型标识符，对应模板中的 subagent_type',
              },
              task_description: {
                type: 'string',
                description: '任务描述，说明需要 Subagent 完成的具体工作',
              },
              success_criteria: {
                type: 'string',
                description: '任务的可量化成功标准',
              },
              require_review: {
                type: 'boolean',
                description: '是否要求验证闭环（语义同 task 的 require_review）',
              },
              available_tools: {
                type: 'array',
                description: '分配给 Subagent 的工具名称列表（语义同 task：显式名单 = 覆盖模板默认；["none"] = 显式零工具；不指定/空 = 跟随模板默认，模板未声明 tools 则为零工具）',
                items: {
                  type: 'string',
                  description: '工具名称',
                },
              },
              override_parameters: {
                type: 'object',
                description: '可选的参数覆盖（字段与语义同 task 的 override_parameters）',
              },
              as_teammate: {
                type: 'boolean',
                description: '团队身份（语义同 task：无活动团队时 true=组建临时团队；有活动团队时默认入队、false=队外零工）',
              },
              member_name: {
                type: 'string',
                description: '成员名（可选，仅入队时生效；默认取 subagent_type，撞名自动派生后缀）',
              },
              require_plan: {
                type: 'boolean',
                description: '计划批准门（语义同 task 的 require_plan：先出只读计划，approve_plan 批准或打回）',
              },
              board_item_id: {
                type: 'string',
                description:
                  '看板工作单元 id（语义同 task 的 board_item_id）：本成员这次执行的是哪件已在板上的活——在该条目上开始一次尝试，不再新挂一行。不填则视为新活（会过条件门）。',
              },
              new_work: {
                type: 'boolean',
                description: '声明本成员这次是一件新活（语义同 task 的 new_work）：与看板上待处置的失败活无关时置 true。',
              },
            },
            required: ['subagent_type', 'task_description'],
          },
        },
      },
      required: ['tasks'],
    },
  },
}

/** 注册任务状态的中文映射（查询/批次占位输出用） */
const TASK_STATUS_TEXT: Record<RegisteredTaskStatus, string> = {
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 长文本截断（结果摘要用；截断尾巴明示全文去向——防模型看到截断后绕去翻存档文件"抢救"全文） */
function truncateText(text: string, max = 200): string {
  return text.length > max
    ? text.slice(0, max) + '…（摘要已截断；完整结果已写回委派时的工具消息，向上翻看即可，勿需他寻）'
    : text
}

/** 单任务的一行式状态描述（query_task_status 输出） */
function formatTaskLine(task: RegisteredTask): string {
  const elapsedSec = (((task.settledAt ?? Date.now()) - task.startedAt) / 1000).toFixed(1)
  let line =
    `- [${TASK_STATUS_TEXT[task.status]}] ${task.subagentType}` +
    `（task_id=${task.taskId}，toolCallId=${task.toolCallId}，批次=${task.batchId}，耗时=${elapsedSec}s）：${task.description}`
  if (task.status === 'completed' && task.output) {
    line += `\n  结果摘要: ${truncateText(task.output.final_output || '(空)')}`
    // 有 transcript 的已完成任务可追问（resume_task 入口指引）
    if (getTaskRegistry().getTranscript(task.toolCallId)) {
      line += '\n  可追问: 是（用 resume_task 纠偏/补充，原 Subagent 保留执行上下文）'
    }
  }
  if (task.status === 'failed') {
    line += `\n  错误: ${task.output?.error_info?.message ?? '未知错误'}`
  }
  return line
}

/**
 * 查询后台任务状态（query_task_status 实现）
 * @param args - 可选 task_id / toolCallId；空参列出全部
 */
export function executeQueryTaskStatus(args: { task_id?: string; toolCallId?: string }): TaskManagementResult {
  const registry = getTaskRegistry()
  const key = args?.toolCallId ?? args?.task_id
  if (key) {
    const entry = registry.getByToolCallId(key) ?? registry.getByTaskId(key)
    if (!entry) {
      return { success: false, error: `未找到任务（${key}）；不传参数可列出当前全部任务` }
    }
    return { success: true, content: formatTaskLine(entry) }
  }
  const all = registry.list()
  if (all.length === 0) {
    return { success: true, content: '当前没有已登记的后台任务。' }
  }
  return { success: true, content: `当前共 ${all.length} 个任务:\n${all.map(formatTaskLine).join('\n')}` }
}

/**
 * 环境 destroy 通道（UI 跨进程场景）：渲染进程的任务注册表无本地环境绑定
 * （Worker 在 electron 主进程 fork），cancel_task 经此通道转发主进程 destroy；
 * CLI / 主进程不注入，本地注册表 getEnvironment 直达。
 * 宿主注入模式参照渲染进程内置工具的 setNodeToolExecutor。
 */
let taskEnvironmentDestroyer: ((environmentKey: string) => Promise<boolean>) | null = null

export function setTaskEnvironmentDestroyer(
  destroyer: ((environmentKey: string) => Promise<boolean>) | null
): void {
  taskEnvironmentDestroyer = destroyer
}

// ============================================================
// 委派结果兜底：超限落盘 + 引用（结果保真——平台永不截断，超限落盘给路径）
// ============================================================

/** 结果内联上限（字节，对齐 Claude Code tool_result 持久化阈值 40 万字节） */
export const TASK_RESULT_INLINE_LIMIT_BYTES = 400 * 1024

/**
 * 结果持久化器（宿主注入）：全文落盘并返回文件路径。
 * CLI 启动时注册 node fs 实现；渲染进程缺省 null = 直通全文（宁可占上下文，永不丢数据）。
 */
export type TaskResultPersister = (toolCallId: string, text: string) => string
let taskResultPersister: TaskResultPersister | null = null

export function setTaskResultPersister(persister: TaskResultPersister | null): void {
  taskResultPersister = persister
}

/**
 * 结果通道兜底（task/batch_task 写回前统一过此）：
 * 未超限 / 未注册 persister → 原样返回；超限 → 落盘并返回"路径 + 前 2000 字符预览"信封
 * （模型用 read_file 按需取回全文）。persister 抛异常同样直通——
 * 写盘绝不能影响任务执行（与 workerLog 同一约定）。
 */
export function adoptTaskResult(toolCallId: string, text: string): string {
  // TextEncoder 测字节（不用 Buffer——core 会在渲染进程运行）
  const bytes = new TextEncoder().encode(text).length
  if (bytes <= TASK_RESULT_INLINE_LIMIT_BYTES || !taskResultPersister) return text
  try {
    const path = taskResultPersister(toolCallId, text)
    return (
      `【结果全文已保存】体积 ${(bytes / 1024).toFixed(1)} KB 超出内联上限，全文见: ${path}（用 read_file 按需读取）\n` +
      `预览（前 2000 字符）:\n${text.slice(0, 2000)}…`
    )
  } catch {
    return text
  }
}

/**
 * 批次占位输出（batch_task 专用）：进度期 RUNNING（k/N 已落地），
 * 齐后终态汇总（全部完成 COMPLETED，否则 FAILED）。成员 settle/取消时重写同一条批次占位。
 */
function buildBatchOutput(registry: TaskRegistry, batchId: string): TaskToolOutput {
  const members = registry.getBatchTasks(batchId)
  const settledCount = members.filter((m) => m.status !== 'running').length
  const lines = members.map(
    (m) => `- [${TASK_STATUS_TEXT[m.status]}] ${m.subagentType}: ${m.description}`
  )
  if (!registry.isBatchSettled(batchId)) {
    return {
      status: TaskExecutionStatus.RUNNING,
      final_output:
        `批量任务执行中: ${settledCount}/${members.length} 已落地，全部完成后会收到通知；` +
        `在收到通知前不要假设任务已有结果。\n${lines.join('\n')}`,
    }
  }
  const allCompleted = members.every((m) => m.status === 'completed')
  // 终态汇总：成员报告完整回传（平台永不截断；超 400KB 经 adoptTaskResult 落盘+引用）
  const summaries = members.map((m) => {
    if (m.status === 'completed') {
      return `- ${m.subagentType}: ${adoptTaskResult(m.toolCallId, m.output?.final_output || '(空)')}`
    }
    if (m.status === 'cancelled') {
      return `- ${m.subagentType}: 已取消`
    }
    return `- ${m.subagentType}: 失败（${m.output?.error_info?.message ?? '未知错误'}）`
  })
  return {
    status: allCompleted ? TaskExecutionStatus.COMPLETED : TaskExecutionStatus.FAILED,
    final_output:
      `批量任务已全部落地（共 ${members.length} 个），结果如下，请整合后答复用户:\n${summaries.join('\n')}`,
    ...(allCompleted
      ? {}
      : { error_info: { code: 'BATCH_PARTIAL_FAILURE', message: '批次内含失败或已取消的任务' } }),
  }
}

/**
 * 取消后台任务（cancel_task 实现）：
 * 注册表标记取消 → 销毁 Worker 环境（本地绑定直达 / 注入通道转发）→ 占位写回"已取消"。
 * 主动取消不单独进待汇报队列（本工具结果已告知模型），但计入批次齐否判定（注册表语义）。
 * @param args - task_id 或 toolCallId（二选一）
 */
export async function executeCancelTask(args: { task_id?: string; toolCallId?: string }): Promise<TaskManagementResult> {
  if (!args?.toolCallId && !args?.task_id) {
    return { success: false, error: 'cancel_task 需要提供 task_id 或 toolCallId 参数（可用 query_task_status 查看任务清单）' }
  }
  const registry = getTaskRegistry()
  const byCallId = args.toolCallId ? registry.getByToolCallId(args.toolCallId) : undefined
  const entry = byCallId ?? (args.task_id ? registry.getByTaskId(args.task_id) : undefined)
  if (!entry) {
    return {
      success: false,
      error: `未找到任务（toolCallId=${args.toolCallId ?? '-'}，task_id=${args.task_id ?? '-'}），可用 query_task_status 查看当前任务清单`,
    }
  }
  if (entry.status !== 'running') {
    return { success: false, error: `任务已落地（状态: ${TASK_STATUS_TEXT[entry.status]}），无法取消` }
  }

  // 1. 注册表标记取消：计入批次齐否判定（批内其余任务落地后整批仍汇报），
  //    但不单独进待汇报（本工具结果已告知模型；注册表既有语义，勿调整）
  registry.markCancelled(entry.toolCallId)
  // settle 咽喉(4 站点共用;cancel 收敛进同一咽喉):花名册同步取消(团队成员回 idle;
  // running 守卫保证后续 destroy 二次 settle 不误覆写)+ 看板死亡回流(条目回待认领池)
  await settleTaskSurfaces(entry.toolCallId, 'cancelled')

  // 2. 一并拒绝该任务的全部挂起审批（cancel 与审批的一致性）：
  //    防"任务已取消、用户随后批准、executor 照常落盘"；批准落定前的复查钩子在通道侧（approvals.resolve）
  const rejectedApprovals = getApprovalChannel().rejectApprovalsForTask(entry.toolCallId, '任务已取消')
  if (rejectedApprovals > 0) {
    console.log(`[delegation] 已拒绝任务 ${entry.toolCallId} 的 ${rejectedApprovals} 个挂起审批`)
  }

  // 3. 销毁 Worker 环境：本地绑定（CLI / electron 主进程）直接 destroy；
  //    渲染进程无本地绑定（Worker 在主进程 fork），经注入的 destroyer 通道转发
  let destroyed = false
  const environment = registry.getEnvironment(entry.toolCallId)
  if (environment) {
    await environment.destroy().catch(() => {})
    registry.unbindEnvironment(entry.toolCallId)
    destroyed = true
  } else if (taskEnvironmentDestroyer) {
    destroyed = await taskEnvironmentDestroyer(entry.toolCallId).catch(() => false)
  }

  // 4. 占位写回（经当轮 context 的 notifyTaskSettled 通道 → 引擎 writeBack）：
  //    batch_task 成员无独立占位——更新批次占位（进度式重写）；
  //    普通 task 写回自身占位"已取消"。context 缺省（轮外调用）时静默跳过，注册表终态不受影响
  const ctx = delegationContextProvider?.()
  if (entry.batchRootToolCallId) {
    ctx?.notifyTaskSettled?.(entry.batchRootToolCallId, buildBatchOutput(registry, entry.batchId))
  } else {
    ctx?.notifyTaskSettled?.(entry.toolCallId, {
      status: TaskExecutionStatus.FAILED,
      final_output: '任务已被取消。',
      error_info: { code: 'CANCELLED', message: '任务被 cancel_task 主动取消' },
    })
  }

  return {
    success: true,
    content:
      `任务已取消: ${entry.subagentType}（${entry.taskId}）` +
      (destroyed ? '，Worker 环境已销毁' : '；未找到存活的环境（可能已自行结束）'),
  }
}

/**
 * 用户直达全停（Ctrl+K 双击 / UI「全部停止」按钮的 core 通道）：
 * 取消当前全部 running 任务——逐项复用 executeCancelTask（注册表标记/拒挂起审批/
 * 环境销毁/占位写回/批次重写不复制第二份），聚合返回取消数。
 * 单项失败不中断其余（executeCancelTask 内部逐项兜底）。
 */
export async function cancelAllRunningTasks(): Promise<{ cancelled: number }> {
  const running = getTaskRegistry().listRunning()
  let cancelled = 0
  for (const task of running) {
    const result = await executeCancelTask({ toolCallId: task.toolCallId })
    if (result.success) cancelled++
  }
  return { cancelled }
}

/** batch_task 的 tasks 数组成员形态 */
export interface BatchTaskItemInput {
  subagent_type?: string
  task_description?: string
  success_criteria?: string
  require_review?: boolean
  available_tools?: string[]
  override_parameters?: Record<string, unknown>
  as_teammate?: boolean
  member_name?: string
  require_plan?: boolean
}

/** resume_task 的入参形态 */
export interface ResumeTaskInput {
  task_id?: string
  toolCallId?: string
  message?: string
  override_parameters?: { timeout?: number; model?: string; max_tokens?: number }
  require_review?: boolean
  /** 工具集覆盖(可选;提供时替代 transcript 留存值——approve_plan 批准扩容/打回收窄用) */
  available_tools?: string[]
  /** 计划批准门阶段控制(可选;提供时覆盖 transcript 链条携带值——approve_plan 批准轮传 false、打回轮传 true) */
  require_plan?: boolean
}

/**
 * resume 执行选项(V3.1 拉活续跑扩展):
 * boardContinuation=执行"已认领未绑"条目——抑制自动 post+claim(不再新建条目),
 * spawn 后换绑该条目 claimedByTaskId=新 toolCallId(1 任务=1 进程=1 toolCallId 不变)。
 */
export interface ResumeTaskOptions extends ExecuteTaskOptions {
  boardContinuation?: { sessionId: string; itemId: string }
}

/**
 * 追问/纠偏已完成的委派任务（resume_task 实现）：
 * 以原任务的 transcript 为种子起新执行——Worker 带着完整执行上下文续聊，而非从零重派。
 * 复用 task 全通道：preflight → hooks → 注册新条目（记 parentToolCallId，独立成批）→
 * 占位/settle/回流/事件；settle 时 transcript 刷新，追问链可持续。
 * -p 非交互特判（sync）：await 真实执行结果，不登记后台任务。
 * @param toolCallId - resume_task 自身的工具调用 id（新条目的注册表主键）
 * @param args - { task_id?/toolCallId?, message, override_parameters?, require_review? }
 * @param options - 执行选项（sync = -p 非交互特判）
 */
export async function executeResumeTask(
  toolCallId: string,
  args: ResumeTaskInput,
  options?: ResumeTaskOptions
): Promise<TaskManagementResult> {
  const registry = getTaskRegistry()
  const key = args?.toolCallId ?? args?.task_id
  if (!key) {
    return { success: false, error: 'resume_task 需要提供 task_id 或 toolCallId（可用 query_task_status 查看任务清单）' }
  }
  if (!args?.message || typeof args.message !== 'string' || !args.message.trim()) {
    return { success: false, error: 'resume_task 需要非空的 message 参数（追问/纠偏内容）' }
  }

  // ① 执行上下文校验：transcript 是 resume 的载体，无则明确指引重派（不静默降级为新委派）
  const transcript = registry.getTranscript(key)
  if (!transcript) {
    return {
      success: false,
      error:
        `该任务不可追问（无执行上下文）：${key}。` +
        '可能原因：任务未成功完成、上下文已被更新的任务挤占（保留上限 10 条）、或进程已重启。请用 task 重新委派',
    }
  }
  const parentEntry = registry.getByToolCallId(key) ?? registry.getByTaskId(key)

  // ② PreDelegation hooks（resume 等价于委派，用户配置的护栏不得对追问失效）
  const syntheticCall: ToolCall = {
    id: toolCallId,
    type: 'function',
    function: { name: 'resume_task', arguments: JSON.stringify(args) },
  }
  const hookDenyReason = await runPreDelegationHooks(syntheticCall)
  if (hookDenyReason !== undefined) {
    return { success: false, error: `委派已被拦截: ${hookDenyReason}` }
  }

  // ②' 资源限额（追问 = 一次新委派，同款登记前判定）
  const resumeQuotaError = getDelegationQuotaError()
  if (resumeQuotaError) {
    return { success: false, error: resumeQuotaError }
  }

  // ③ preflight（模板仍在 + 模型链可解析；期间模板被删/模型被卸时同步报错，防幽灵通知）
  const mergedOverride = { ...transcript.overrideParameters, ...args.override_parameters }
  try {
    const preflightError = await getTaskExecutor().preflightDelegation({
      task_id: parentEntry?.taskId ?? key,
      subagent_type: transcript.subagentType,
      task_description: args.message,
      success_criteria: transcript.successCriteria,
      available_tools: args.available_tools ?? transcript.availableTools,
      override_parameters: mergedOverride,
    })
    if (preflightError) {
      return { success: false, error: preflightError }
    }
  } catch (error) {
    return { success: false, error: `无法启动追问: ${error instanceof Error ? error.message : '预检失败'}` }
  }

  // ④ 组装追问的 task 形参（prior_messages 为内部载体，经 extras 下行到 Worker 做种子）
  // available_tools 覆盖语义:args 提供时替代 transcript 留存值(approve_plan 批准扩容/打回收窄);
  // require_plan 随链携带——打回轮次全程保持 plan 语义(planPending 不丢、阶段语义不自降级);
  // args 显式提供时覆盖链条值(approve_plan 批准轮传 false=阶段 2 不再只读)
  const effectiveRequirePlan = args.require_plan ?? (transcript.requirePlan === true ? true : undefined)
  const resumeArgs = {
    task_id: parentEntry?.taskId ?? key,
    subagent_type: transcript.subagentType,
    task_description: args.message,
    success_criteria: transcript.successCriteria,
    require_review: args.require_review === true,
    available_tools: args.available_tools ?? transcript.availableTools,
    override_parameters: mergedOverride,
    prior_messages: transcript.messages,
    require_plan: effectiveRequirePlan,
  }
  const resumeCall: ToolCall = {
    id: toolCallId,
    type: 'function',
    function: { name: 'task', arguments: JSON.stringify(resumeArgs) },
  }

  const ctx = delegationContextProvider?.() ?? { toolMetadata: [], toolDefinitions: [] }
  const subagentTools = buildWorkerToolDefinitions(ctx.toolDefinitions)
  const description = `追问: ${args.message}`
  const payload = {
    taskId: parentEntry?.taskId ?? key,
    subagentType: transcript.subagentType,
    description,
    toolCall: syntheticCall,
  }

  // ⑤ 启动执行（settle 处理与 task 同通道：transcript 刷新 → 注册表终态 → 事件 → hooks → 引擎回流）
  // 团队续员(仅交互路径;-p 同步路径不入队):原任务是成员且团队仍在 → 新 Worker 带看板工具定义续跑;
  // 续员登记在启动前完成(种子注入需要信箱未读——统一 drain 形态,成员开工即见全部积压)
  const resumeJoined =
    !options?.sync &&
    !!transcript.teamId &&
    !!transcript.memberName &&
    getTeamRuntimeService()?.getActiveTeam()?.runId === transcript.teamId
  const resumeUndelivered = resumeJoined
    ? (await getTeamRuntimeService()!.resumeMember(transcript.teamId!, transcript.memberName!, toolCallId)).undelivered
    : []
  // 续员的编排豁免(统一协作基板:豁免计算唯一事实点在 collab/admission;
  // 授权含 task 的成员被 resume 后拉新权不丢)
  const resumeGrantedOrch = resumeJoined ? computeGrantedOrchestration(transcript.memberName!, transcript.subagentType) : []
  const resumeToolsForCall = resumeGrantedOrch.length > 0 ? buildWorkerToolDefinitions(ctx.toolDefinitions, resumeGrantedOrch) : subagentTools
  // 挂板（M7 增量 2 三条出路）：
  // ① 显式 boardContinuation（拉活续跑）：换绑意图条目 claimedByTaskId=新键（换绑先例 resumeMember）；
  // ② 目标任务的绑定行**在途**（计划批准轮/打回轮）：同一件活的又一次尝试 → 复用同一行，不新建；
  // ③ 其余（对**已终态**工作的追问）：新工作单元，照旧新挂一行——追问不产生幽灵，跳条件门（不必被牵连）。
  const resumeBatchId = registry.newBatchId()
  if (options?.boardContinuation) {
    await getSessionBoardService()
      ?.rebindClaim(options.boardContinuation.sessionId, options.boardContinuation.itemId, toolCallId)
      .catch((err: unknown) => {
        console.warn(`【看板】拉活换绑失败(条目 ${options.boardContinuation!.itemId}):`, err)
      })
  } else {
    const boardSvc = getSessionBoardService()
    const targetRow = boardSvc?.findItemByTaskId(parentEntry?.toolCallId ?? key)
    const targetItem = targetRow
      ? (await boardSvc!.readBoard(targetRow.sessionId)).items.find((i) => i.id === targetRow.itemId)
      : undefined
    if (boardSvc && targetRow && targetItem && (targetItem.status === 'in_progress' || targetItem.status === 'blocked')) {
      await boardSvc
        .attachAttempt(targetRow.sessionId, targetRow.itemId, {
          claimedByTaskId: toolCallId,
          subagentType: transcript.subagentType,
          takeOverFromTaskId: parentEntry?.toolCallId ?? key,
        })
        .catch((err: unknown) => {
          console.warn(`【看板】在途续跑绑定失败(条目 ${targetRow.itemId}):`, err)
        })
    } else {
      await attachOrCreateBoard({
        toolCallId,
        subagentType: transcript.subagentType,
        description: `追问: ${args.message}`,
        batchId: resumeBatchId,
        originArgs: args as Record<string, unknown>,
        skipBindingGate: true,
      })
    }
  }
  const execution = executeOne(resumeCall, ctx.toolMetadata, resumeToolsForCall, resumeJoined, formatInboxNote(resumeUndelivered), effectiveRequirePlan, resumeGrantedOrch)
  execution.then(async (taskOutput) => {
    retainTranscriptFromOutput(resumeCall, taskOutput, effectiveRequirePlan === true)
    // settle 咽喉(4 站点共用;resume settle → 看板自动结项/死亡回流)
    await settleTaskSurfaces(toolCallId, taskOutput.status === TaskExecutionStatus.COMPLETED ? 'completed' : 'failed', {
      taskOutput,
      requirePlan: effectiveRequirePlan === true,
      originArgs: args as Record<string, unknown>,
      sync: options?.sync === true,
    })
    if (!options?.sync) {
      registry.markSettled(toolCallId, taskOutput)
    }
    const succeeded = taskOutput.status === TaskExecutionStatus.COMPLETED
    eventBus.emit(
      succeeded ? EVENTS.SUBAGENT_TASK_COMPLETED : EVENTS.SUBAGENT_TASK_FAILED,
      { ...payload, taskOutput }
    )
    await runPostDelegationHooks(syntheticCall, taskOutput)
    if (!options?.sync) {
      if (registry.getByToolCallId(toolCallId)?.status !== 'cancelled') {
        ctx.notifyTaskSettled?.(toolCallId, taskOutput)
      }
    }
  })

  // -p 非交互特判：await 真实执行结果，不登记后台任务
  if (options?.sync) {
    eventBus.emit(EVENTS.SUBAGENT_TASK_STARTED, payload)
    const taskOutput = await execution
    return taskOutput.status === TaskExecutionStatus.COMPLETED
      ? { success: true, content: taskOutput.final_output || '(空)' }
      : { success: false, error: taskOutput.error_info?.message || 'resume_task 执行失败' }
  }

  // ⑥ 交互模式：登记新条目（记 parentToolCallId，独立成批）+ 事件 + 返回受理占位
  registry.register({
    taskId: `${payload.taskId}-followup`,
    toolCallId,
    subagentType: transcript.subagentType,
    description,
    batchId: resumeBatchId,
    parentToolCallId: parentEntry?.toolCallId ?? key,
    ...(handleOfOrigin((args as { __origin?: unknown }).__origin)
      ? { engineHandle: handleOfOrigin((args as { __origin?: unknown }).__origin) }
      : {}),
  })
  eventBus.emit(EVENTS.SUBAGENT_TASK_STARTED, payload)
  return {
    success: true,
    content:
      `追问已受理，原 Subagent 带执行上下文后台续跑中（任务标识: ${payload.taskId}-followup），` +
      '完成时会收到通知，届时请整合结果答复用户；在收到通知前不要假设任务已有结果。',
  }
}

/**
 * 批量后台委派（batch_task 实现）：
 * 成员 toolCallId 派生自批次根 id（`根#序号`）——成员无独立占位消息，仅注册表键控与事件载荷用；
 * 占位以批次为单位一条，成员 settle/取消时进度式重写（经 notifyTaskSettled 通道）。
 * -p 非交互特判（sync）：各任务同步并行执行（语义同现有同轮多 task），禁止登记后台任务。
 * @param toolCallId - batch_task 自身的工具调用 id（批次占位根 id）
 * @param args - { tasks: [...] }
 * @param options - 执行选项（sync = -p 非交互特判）
 */
export async function executeBatchTask(
  toolCallId: string,
  args: { tasks?: BatchTaskItemInput[] },
  options?: ExecuteTaskOptions
): Promise<TaskManagementResult> {
  const tasks = args?.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { success: false, error: 'batch_task 参数 tasks 必须是非空数组' }
  }
  for (let i = 0; i < tasks.length; i++) {
    if (!tasks[i]?.subagent_type || !tasks[i]?.task_description) {
      return { success: false, error: `tasks[${i}] 缺少必填字段 subagent_type / task_description` }
    }
  }

  // 准入 precheck(统一协作基板:成员发起的 batch = 拉新,三闸不过原子拒绝整批——
  // 与批次 quota 的"要么全受理要么全拒"语义一致)
  const batchCaller = resolveSpawnCaller((args as Record<string, unknown>).__origin as { source?: string; taskId?: string } | undefined)
  const batchGateError = checkSpawnGates(batchCaller)
  if (batchGateError) {
    return { success: false, error: batchGateError }
  }

  // 资源限额（整批原子判定）：任一成员会超限 → 整批登记前拒绝，不半登记
  // （"一批"语义：要么全受理要么全拒，半受理会让批次占位汇报复杂化）
  const batchQuotaError = getDelegationQuotaError(tasks.length)
  if (batchQuotaError) {
    return { success: false, error: batchQuotaError }
  }

  // 成员 toolCall：每个成员等价于一次 task 委派（task_id 取派生 id，供查询/取消引用）
  const memberCalls: ToolCall[] = tasks.map((task, index) => {
    const memberId = `${toolCallId}#${index}`
    return {
      id: memberId,
      type: 'function',
      function: {
        name: 'task',
        arguments: JSON.stringify({
          task_id: memberId,
          subagent_type: task.subagent_type,
          task_description: task.task_description,
          success_criteria: task.success_criteria,
          require_review: task.require_review,
          available_tools: task.available_tools,
          override_parameters: task.override_parameters,
          as_teammate: task.as_teammate,
          member_name: task.member_name,
          require_plan: task.require_plan,
        }),
      },
    }
  })

  // -p 非交互特判：各任务同步并行执行，await 真实结果，不登记、不回调
  if (options?.sync) {
    const results = await executeTaskToolCalls(memberCalls, undefined, undefined, { sync: true })
    // 同步批量汇总：成员报告完整回传（不截断；超限经 adoptTaskResult 落盘+引用，-p 未注册 persister 时自然直通）
    const lines = results.map((r, index) => {
      const output = r.taskOutput
      return output.status === TaskExecutionStatus.COMPLETED
        ? `- ${tasks[index].subagent_type}: ${adoptTaskResult(r.toolCall.id, output.final_output || '(空)')}`
        : `- ${tasks[index].subagent_type}: 失败（${output.error_info?.message ?? '未知错误'}）`
    })
    const allCompleted = results.every((r) => r.taskOutput.status === TaskExecutionStatus.COMPLETED)
    return allCompleted
      ? { success: true, content: `批量任务同步执行完成:\n${lines.join('\n')}` }
      : { success: false, error: `批量任务含失败:\n${lines.join('\n')}` }
  }

  // 交互模式：登记（共享 batchId + 批次占位根 id）→ 启动后台执行 → 返回一条批次占位
  const ctx = delegationContextProvider?.() ?? { toolMetadata: [], toolDefinitions: [] }
  const subagentTools = buildWorkerToolDefinitions(ctx.toolDefinitions)
  // 防御性检测（同 executeTaskToolCalls）：宿主须先于 task 执行完成注入式初始化
  if (!isTaskExecutorInitialized()) {
    console.warn(
      '[delegation] TaskExecutor 尚未由宿主注入初始化（getTaskExecutor 首个调用者定参），' +
      '本次将以无适配器配置兜底创建，Subagent 执行可能失败'
    )
  }

  const registry = getTaskRegistry()
  const batchId = registry.newBatchId()
  const payloads = memberCalls.map(buildEventPayload)
  for (const payload of payloads) {
    eventBus.emit(EVENTS.SUBAGENT_TASK_STARTED, payload)
  }

  const joinedMembers: string[] = []
  const batchEngineHandle = handleOfOrigin((args as { __origin?: unknown }).__origin)
  memberCalls.forEach(async (call, index) => {
    registry.register({
      taskId: call.id,
      toolCallId: call.id,
      subagentType: tasks[index].subagent_type!,
      description: tasks[index].task_description!,
      batchId,
      batchRootToolCallId: toolCallId,
      ...(batchEngineHandle ? { engineHandle: batchEngineHandle } : {}),
    })
    // 准入对齐(统一协作基板迭代 2,有意语义对齐——需用户知情):与单 task 同款 PreDelegation hooks + preflight;
    // 失败成员登记后立即按失败结清(批次进度可见,无"执行中"幽灵),其余成员照常受理
    const hookDenyReason = await runPreDelegationHooks(call)
    const memberStartError = hookDenyReason !== undefined ? `委派已被拦截: ${hookDenyReason}` : await preflightOne(call)
    if (memberStartError) {
      const failedOutput: TaskToolOutput = {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: { code: hookDenyReason !== undefined ? 'DELEGATION_DENIED' : 'PREFLIGHT_FAILED', message: memberStartError },
      }
      registry.markSettled(call.id, failedOutput)
      eventBus.emit(EVENTS.SUBAGENT_TASK_FAILED, { ...payloads[index], taskOutput: failedOutput })
      ctx.notifyTaskSettled?.(toolCallId, buildBatchOutput(registry, batchId))
      return
    }
    // 身份解析与登记(统一协作基板:enroll 唯一事实点;registry.register 同点)
    const memberArgs = parseTaskArgsForHooks(call)
    const membership = await enrollWorkerSpawn({
      caller: batchCaller,
      agent: typeof memberArgs.subagent_type === 'string' ? memberArgs.subagent_type : 'unknown',
      memberName: typeof memberArgs.member_name === 'string' ? memberArgs.member_name : undefined,
      asTeammate: memberArgs.as_teammate as boolean | undefined,
      taskId: call.id,
    })
    // 派活挂板（M7 增量 2：绑定既有工作单元 / 过门后新挂一行；预检失败成员零痕迹——挂在 enroll 成功侧）
    const batchBoard = await attachOrCreateBoard({
      toolCallId: call.id,
      subagentType: tasks[index].subagent_type!,
      description: tasks[index].task_description!,
      batchId,
      originArgs: args as Record<string, unknown>,
      memberName: membership.memberName,
    })
    if (!batchBoard.ok) {
      // 竞态兜底（预检已拦）：该成员按既有语义"登记后立即按失败结清"，批次进度可见
      const boardFailed: TaskToolOutput = {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: batchBoard.code ?? 'BOARD_BINDING_INVALID',
          message: batchBoard.reason ?? '看板绑定被拒',
        },
      }
      registry.markSettled(call.id, boardFailed)
      eventBus.emit(EVENTS.SUBAGENT_TASK_FAILED, { ...payloads[index], taskOutput: boardFailed })
      ctx.notifyTaskSettled?.(toolCallId, buildBatchOutput(registry, batchId))
      return
    }
    if (membership.joined && membership.memberName) joinedMembers.push(membership.memberName)
    // 计划批准门:成员级有效值(参数优先于 YAML plan_first),settle 留存与回写同值
    const memberRequirePlan =
      (tasks[index].require_plan as boolean | undefined) ?? (membership.planFirst === true ? true : undefined)
    const execution = executeOne(call, ctx.toolMetadata, subagentTools, membership.joined, formatInboxNote(membership.undelivered), memberRequirePlan, membership.grantedOrchestrationTools)
    execution.then(async (taskOutput) => {
      // transcript 留存（成员粒度，与单 task 一致；resume_task 可对成员追问）
      retainTranscriptFromOutput(call, taskOutput, memberRequirePlan)
      // settle 咽喉(4 站点共用):花名册回写(running 守卫幂等)+ 看板 settle 桥(batch 成员 settle)
      await settleTaskSurfaces(call.id, taskOutput.status === TaskExecutionStatus.COMPLETED ? 'completed' : 'failed', {
        taskOutput,
        requirePlan: memberRequirePlan === true,
        originArgs: args as Record<string, unknown>,
      })
      // 已取消成员 destroy 后也会走到这里：markSettled 对非 running 幂等忽略；
      // 批次占位进度式重写反映最新状态（含取消），齐后为终态汇总
      registry.markSettled(call.id, taskOutput)
      const succeeded = taskOutput.status === TaskExecutionStatus.COMPLETED
      eventBus.emit(
        succeeded ? EVENTS.SUBAGENT_TASK_COMPLETED : EVENTS.SUBAGENT_TASK_FAILED,
        { ...payloads[index], taskOutput }
      )
      ctx.notifyTaskSettled?.(toolCallId, buildBatchOutput(registry, batchId))
    })
  })

  return {
    success: true,
    content:
      `批量任务已受理: ${tasks.length} 个任务后台执行中（批次标识: ${batchId}），` +
      '全部完成后会收到通知，届时请整合结果答复用户；在收到通知前不要假设任务已有结果。' +
      (joinedMembers.length > 0
        ? `\n已加入团队，成员名: ${joinedMembers.join(', ')}（成员可用 team_board 认领/结项、team_status 看全局）`
        : ''),
  }
}
