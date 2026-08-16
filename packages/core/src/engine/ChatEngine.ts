/**
 * ChatEngine（T2：统一对话路径）
 *
 * 权威消息历史 + 会话状态（planMode / goalMode / 前台选择）+ 上下文组装 + 模型工具循环
 * （含同轮多 task 真并行）+ 每轮结束落盘 + 首轮自动标题。
 *
 * 引擎本体平台无关（不 import fs）：持久化走注入的 SessionStoreAdapter（Node 实现
 * 复用 persistence/SessionPersistence.ts，UI 经 session:save IPC），媒体走注入的
 * MediaProvider。构造依赖全部注入（见 ChatEngineDeps），Node 侧装配示例在 nodeFactory.ts。
 *
 * 工具循环语义裁定自 baseModelService.sendChatMessage（事件载荷保持一致）：
 * - 每轮 API 调用前现组上下文（注入项每轮现读）；
 * - assistant 工具调用消息 + 真实 TOOL 结果消息直接并入权威历史；
 * - 同轮多个 task toolCall 走 executeTaskToolCalls 真并行；单个经 builtInToolExecutor 统一入口；
 * - TOOL_CALL_STATUS_CHANGED / TOOL_MESSAGE_CREATED / ASSISTANT_MESSAGE_CREATED 事件照常发出。
 *
 * 中断语义：abort() 透传 abortController 到模型调用与 task 执行；中断（或异常）后
 * 本轮完整回滚（user 消息与半截 tool 循环产出一并移除），历史恢复到本轮之前、与盘一致。
 */

import {
  MessageRole,
  ToolCallStatus,
  ModelModality,
  type ContentPart,
  type Message,
  type ModelResponse,
  type ToolCall,
  type ToolDefinition,
} from '../types/models'
import { TaskExecutionStatus, type ToolMetadata, type AvailableSubagent, type TaskToolOutput } from '../orchestrator/types'
import type { ExecutableResource } from '../types/workflow'
import type { SessionRecord, SaveMode, CompactionCheckpoint } from '../persistence/SessionPersistence'
import { eventBus as globalEventBus, EVENTS } from '../utils/eventBus'
import { getBuiltInTools, isBuiltInTool, ASYNC_BUILTIN_TOOLS, PLAN_MODE_BLOCKED_TOOLS, DESKTOP_TOOLS, TOOL_CATEGORY, CORE_TOOLS } from '../services/builtInTools'
import { ToolRegistry } from '../services/toolExecutorRegistry'
import { capToolResult } from '../services/toolResultGuard'
import { evaluateContextPressure, DEFAULT_COMPACT_THRESHOLD } from '../services/contextPressure'
import { pruneStaleToolResults } from '../services/staleToolPruner'
import { isContextWindowExceeded } from '../services/contextWindowError'
import { ToolExecutorFactory } from '../services/toolExecutorFactory'
import type { BuiltInToolExecutor } from '../services/builtInToolExecutor'
import { convertResourcesToOpenAITools, sanitizeName } from '../services/resourceToolAdapter'
import {
  executeTaskToolCalls,
  setDelegationContextProvider,
  setDelegationHookDispatcher,
  adoptTaskResult,
  type DelegationContext,
  type DelegationTaskResult,
} from '../services/delegation/delegationTools'
import { getTaskRegistry, type RegisteredTask } from '../services/delegation/taskRegistry'
import { memoryStore } from '../services/memory/memoryStore'
import { setAgentMemoryDir, clearAgentMemoryDir } from '../services/memory/agentMemoryContext'
import { getApprovalChannel } from '../services/approvals'
import type { HookDispatchContext, HookDispatchResult } from '../services/hooks/HookRunner'
import type { HookEvent } from '../services/hooks/types'
import { attachHookNotificationBridge } from '../services/hooks/notificationBridge'
import { setWorkerMcpHookDispatcher, type WorkerMcpHookOutcome } from '../services/hooks/workerMcpHooks'
import { generateSessionTitle, smartTruncateTitle } from '../services/sessionTitleService'
import { deriveModelKind } from '../services/models/deriveModelKind'
import { filterFrontAgentCandidates } from '../orchestrator/rolePrompt'
import { ContextAssembler, createCommonInjectors } from './ContextAssembler'
import { filterInputContentParts } from './media'
import { GoalEvaluator } from './GoalEvaluator'
import {
  buildCatalogEntries,
  buildSearchResultText,
  computeVisibleNames,
  filterVisibleTools,
  parseActivatedNames,
  searchToolCorpus,
  shouldEnableProgressiveTools,
  type ToolCatalogEntry,
} from './toolDiscovery'
import {
  compactMessages,
  computeTranscriptBudgetChars,
  buildThinkingOffOverrides,
  formatTranscript,
  formatHHMM,
  formatMMDDHHMM,
  messageText,
} from '../services/compaction/compactionService'
import {
  INJECTOR_ORDER,
  type AssembleContext,
  type ChatEngineCallbacks,
  type ChatEngineDeps,
  type ChatEngineInput,
  type ChatEngineSessionState,
  type ChatEngineTurnResult,
  type ContextInjector,
  type EventBusLike,
  type GoalState,
  type ModelMediaCapabilities,
  type RecallArchivedContextParams,
} from './types'

/** 一轮构建出的工具集 */
interface BuiltToolset {
  tools: ToolDefinition[]
  registry: ToolRegistry
  toolMetadata: ToolMetadata[]
  /** MCP 工具名 → serverName（事件载荷用，语义同 baseModelService 的 toolNameToServerMap） */
  mcpServerNames: Map<string, string>
  /** 工具目录（渐进发现的检索语料 / 索引注入 / 委派清单数据源；随当轮 toolset 已过 desktop 开关与前台白名单） */
  toolCatalog: ToolCatalogEntry[]
  /** deferrable（非核心集）工具定义序列化字符数粗算（渐进发现阈值判定用；~3 字符/token 换算，不跑 tokenizer） */
  deferrableChars: number
}

/** 中断错误（与协议处理器的 'Request aborted' / AbortError 约定一致） */
function createAbortError(): Error {
  const err = new Error('Request aborted')
  err.name = 'AbortError'
  return err
}

/** Stop hook 无 goal 时连续强制继续的上限（防死循环；goal 激活时由 goal 的 maxRounds/noProgress 熔断计数兜底） */
const MAX_STOP_HOOK_BLOCKS = 5

/** SessionEnd hooks 的共享超时预算（ms）：endSession 等待全部完成或预算耗尽 */
const SESSION_END_HOOKS_BUDGET_MS = 1500

function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null
  return e?.name === 'AbortError' || e?.message === 'Request aborted'
}

/** 提取 user 消息的纯文本（content 为 ContentPart[] 时拼接其中 text 部分） */
function extractUserText(msg: Message | undefined): string {
  if (!msg) return ''
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join(' ')
}

/** 默认标题：首条 user 消息经标点/空白边界感知智能截断 */
function extractTitle(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === MessageRole.USER)
  if (!firstUser) return '新会话'
  return smartTruncateTitle(extractUserText(firstUser))
}

export class ChatEngine {
  private readonly deps: ChatEngineDeps
  private readonly bus: EventBusLike
  private readonly contextAssembler: ContextAssembler

  /** 权威消息历史（唯一事实源；壳只读渲染，改写只能经引擎 API） */
  private history: Message[] = []

  // ---- 会话记录状态（随 SessionRecord 持久化） ----
  private sessionId: string | null = null
  private title = ''
  private titleSource: 'default' | 'auto' | 'manual' = 'default'
  private createdAt: string | null = null
  /** UI 任务列表（无损往返，引擎本身不产生） */
  private tasks: unknown[] | undefined
  private frontAgent: string | undefined
  /** 压缩 checkpoint 数组（随 SessionRecord.compactions 持久化；messages 全量保留，永不删除） */
  private compactions: CompactionCheckpoint[] = []

  // ---- 运行状态 ----
  private planMode = false
  /** 目标模式状态（一等状态，随会话生命周期；切换/新建会话时清除） */
  private goalState: GoalState | null = null
  /** 目标推进循环防重入标记（与 reportDraining 同模式） */
  private goalDraining = false
  /** 独立评估器（判定与执行分离；无工具单次调用，模型选定见 resolveEvaluatorModelName） */
  private readonly goalEvaluator: GoalEvaluator
  /** 本轮显式点名的 agent（@提及；sendMessage 存入、runTurn finally 清空，explicit-agent 注入器的数据源） */
  private currentExplicitAgent?: string
  private running = false
  private abortController: AbortController | null = null
  /** 回流轮防重入标记（多个任务同时 settle 时只开一个 drain 循环） */
  private reportDraining = false
  /** 外部发起轮（后台任务回流）的常驻输出回调：CLI REPL 无 sendMessage callback，经此注册流式打印（T4 消费）；TUI/UI 经 onMessagesChanged 呈现，无需注册 */
  private externalStreamHandler: ChatEngineCallbacks['streamCallback'] | undefined
  /** 本会话是否为本次运行新建（loadSession 恢复的会话不触发自动标题） */
  private createdThisRun = false
  /** 自动标题只尝试一次（含失败），避免每轮对话重复调用模型 */
  private autoTitleAttempted = false
  /** 最近一次 API 调用的实测 token 用量（会话级；getContextStatus 的数据源，会话切换时重置） */
  private lastUsage: ModelResponse['usage'] | undefined
  /** 轮次进行中排队的合成留痕消息（toolMessages 入史后 flush——不插进 assistant(toolCalls) 与 tool 结果之间） */
  private pendingSynthetic: Message[] = []

  // ---- hooks 状态 ----
  /** SessionStart hooks 的挂起派发（startNewSession/loadSession 登记；hook-context 注入器首轮组装时 await 注入——两方法保持同步签名不动） */
  private pendingSessionStart: Promise<HookDispatchResult | null> | null = null
  /** 本轮 hooks 收集的附加上下文（PreToolUse/PostToolUse/UserPromptSubmit 的 additionalContext；runTurn finally 清空，不跨轮滞留） */
  private turnHookContext: string[] = []
  /** SessionEnd hooks 的触发 Promise（幂等：多次 endSession 共享同一 Promise；startNewSession/loadSession 重置以允许新会话再次触发） */
  private sessionEndPromise: Promise<void> | null = null

  // ---- 工具渐进发现状态 ----
  /** 已激活工具集（search_tools 命中即加入，只增不改；随会话生命周期，loadSession 时从 history 扫描 [activated] 行重建） */
  private activatedTools: Set<string> = new Set()
  /** 当轮 toolset 暂存（search_tools 回调的检索语料；runTurn finally 清理，不跨轮滞留） */
  private currentToolset: BuiltToolset | null = null
  /** 最近一次 buildToolset 的概览（getToolsStatus 空闲期数据源——/tools status 通常在轮次外调用） */
  private toolsStatusSnapshot: { total: number; coreCount: number; deferrableChars: number } | null = null

  /** 权威历史每次变化后调用（壳侧重渲染/自动保存接线处；异常被吞，不影响对话） */
  onMessagesChanged: (() => void) | null = null

  private readonly handlePlanModeEntered: () => void
  private readonly handlePlanApproved: () => void
  private readonly handleGoalProposalAccepted: (payload: any) => void
  private readonly handleGoalUpdated: (payload: any) => void

  constructor(deps: ChatEngineDeps) {
    this.deps = deps
    this.bus = deps.eventBus ?? globalEventBus
    this.goalEvaluator = new GoalEvaluator({ modelCaller: deps.modelCaller })
    this.contextAssembler = new ContextAssembler({
      mediaProvider: deps.mediaProvider,
      injectors: createCommonInjectors({
        memoryStore: deps.memoryStore,
        agentInstructions: deps.agentInstructions,
        skillRegistry: deps.skillRegistry,
        getSubagents: deps.getSubagents,
        getAvailableModels: deps.getAvailableModels,
        getSubagentTemplate: deps.getSubagentTemplate,
        isNonInteractive: () => deps.builtInToolExecutor.getNonInteractiveMode() !== null,
      }),
    })

    // 显式点名 agent 的委派指令（@提及；order 紧随委派指南——可用清单在前、点名指令在后）。
    this.registerContextInjector({
      id: 'explicit-agent',
      order: INJECTOR_ORDER.EXPLICIT_AGENT,
      inject: () => {
        const explicitAgent = this.currentExplicitAgent
        if (!explicitAgent) return null
        return {
          role: MessageRole.SYSTEM,
          content: `用户已显式指定由 Subagent \`${explicitAgent}\` 执行本条任务：你必须使用 task 工具、subagent_type=\`${explicitAgent}\` 委派，不得改用其他 agent 或自行执行；若该类型不存在，明确告知用户而不是静默换 agent；若该委派已完成，直接整合其结果答复，不要重复委派。`,
          timestamp: new Date(),
        }
      },
    })

    // hooks 装配（deps.hookRunner 存在时）：
    // ① Worker 咽喉在 executor——runner 与会话上下文闭包（sessionId/cwd 数据源）透传过去；
    // ② hook-context 注入器——SessionStart 首轮注入（await 挂起派发）+ 本轮 additionalContext 每轮现读
    if (this.deps.hookRunner) {
      this.deps.builtInToolExecutor.setHookRunner?.(this.deps.hookRunner)
      this.deps.builtInToolExecutor.setHookContextProvider?.(() => ({
        sessionId: this.sessionId ?? '',
        cwd: this.deps.workDir ?? '',
      }))
      this.registerContextInjector({
        id: 'hook-context',
        order: INJECTOR_ORDER.HOST_DEFAULT,
        inject: async () => {
          const parts: string[] = []
          // SessionStart 首轮注入：注入确定性由组装点保证（首轮 API 调用前 await 挂起的 hooks）
          const pending = this.pendingSessionStart
          if (pending) {
            this.pendingSessionStart = null
            try {
              const result = await pending
              if (result) {
                this.emitHookMessages('SessionStart', result.systemMessages)
                parts.push(...result.additionalContext)
              }
            } catch {
              /* hook 失败不阻断会话（HookRunner 内部已 fail-open，此处双保险） */
            }
          }
          parts.push(...this.turnHookContext)
          if (parts.length === 0) return null
          return { role: MessageRole.SYSTEM, content: parts.join('\n'), timestamp: new Date() }
        },
      })

      // ③ 通知轨：eventBus → Notification/GoalTransition 映射表统一订阅（新增通知事件只改映射表）
      attachHookNotificationBridge(this.deps.hookRunner, this.bus, () => ({
        sessionId: this.sessionId ?? '',
        cwd: this.deps.workDir ?? '',
      }))

      // ④ 委派 hooks（PreDelegation/PostDelegation）：delegationTools 的挂载点经此派发器过宿主管线
      setDelegationHookDispatcher({
        preDelegation: async ({ args }) => {
          const result = await this.safeDispatchHooks('PreDelegation', {
            sessionId: this.sessionId ?? '',
            cwd: this.deps.workDir ?? '',
            toolName: 'task',
            toolInput: args,
            matcherValue: typeof args.subagent_type === 'string' ? args.subagent_type : undefined,
          })
          if (!result) return undefined
          this.emitHookMessages('PreDelegation', result.systemMessages)
          this.turnHookContext.push(...result.additionalContext)
          return result.verdict.type === 'deny' ? result.verdict.reason : undefined
        },
        postDelegation: async ({ args, output }) => {
          const result = await this.safeDispatchHooks('PostDelegation', {
            sessionId: this.sessionId ?? '',
            cwd: this.deps.workDir ?? '',
            toolName: 'task',
            toolInput: args,
            matcherValue: typeof args.subagent_type === 'string' ? args.subagent_type : undefined,
            extra: {
              task_status: output.status,
              // 结果摘要截断回传（完整结果在任务 TOOL 消息里，hook 只需摘要）
              result_summary: (output.final_output || output.error_info?.message || '').slice(0, 2000),
            },
          })
          if (!result) return
          this.emitHookMessages('PostDelegation', result.systemMessages)
          this.turnHookContext.push(...result.additionalContext)
        },
      })

      // ⑤ Worker MCP 工具的 hooks 派发通道（网关来源互斥挂点的引擎侧；ask 在此升级为人工审批，
      // 网关只消费 allow/deny/transform 三态——审批通道在引擎所在进程才可用）
      setWorkerMcpHookDispatcher(async (event, call): Promise<WorkerMcpHookOutcome | null> => {
        const result = await this.safeDispatchHooks(event, {
          sessionId: this.sessionId ?? '',
          cwd: this.deps.workDir ?? '',
          toolName: call.toolName,
          toolInput: call.toolInput,
          toolResponse: call.toolResponse,
          extra: { __origin: call.origin },
        })
        if (!result) return null
        this.emitHookMessages(event, result.systemMessages)
        const outcome: WorkerMcpHookOutcome = { notes: result.additionalContext }
        if (result.verdict.type === 'deny') {
          outcome.deny = result.verdict.reason
          return outcome
        }
        if (result.verdict.type === 'ask') {
          // 非交互模式无人可批，降级放行并警告（对齐 chill -p 审批型 hook 的既定口径）
          if (this.deps.builtInToolExecutor.getNonInteractiveMode() !== null) {
            this.emitHookMessages(event, [`[hooks] ${call.toolName} 的 ask 决策在非交互模式下无法呈现，已放行`])
            return outcome
          }
          const resolution = await getApprovalChannel().request({
            toolCallId: call.toolCallId ?? `worker-mcp-${Date.now()}`,
            kind: 'command',
            command: `${call.toolName} ${JSON.stringify(call.toolInput ?? {}).slice(0, 200)}`,
            detail: result.verdict.reason,
            origin: call.origin,
          })
          if (!resolution.approved) {
            outcome.deny = resolution.reason ? `hook 升级审批被拒绝: ${resolution.reason}` : 'hook 升级审批被拒绝'
          }
          return outcome
        }
        if (result.verdict.type === 'transform') {
          if (event === 'PreToolUse') outcome.updatedInput = result.verdict.updatedInput
          else outcome.updatedResponse = result.verdict.updatedInput
        }
        return outcome
      })
    }

    // 模型经 enter_plan_mode / submit_plan 改变 planMode 时（executor 发事件），
    // 引擎作为状态源同步内部状态；用户经 setPlanMode() 改变时由引擎发事件。
    this.handlePlanModeEntered = () => this.applyPlanMode(true)
    this.handlePlanApproved = () => this.applyPlanMode(false)
    this.bus.on(EVENTS.PLAN_MODE_ENTERED, this.handlePlanModeEntered)
    this.bus.on(EVENTS.PLAN_APPROVED, this.handlePlanApproved)

    // goal 工具的状态回写通道（executor 发事件，引擎作为状态源应用；与 plan 双通道防回环同模式）：
    // GOAL_PROPOSAL_ACCEPTED = 用户批准 propose_goal（模型无任何自行进入的通道）；
    // GOAL_UPDATED = write_goal 修订目标/判据（引擎更新状态并落盘，轮次计数保持不变）
    this.handleGoalProposalAccepted = (payload: any) => {
      const objective = String(payload?.objective ?? '').trim()
      if (!objective || this.goalState) return
      const criteria = String(payload?.successCriteria ?? '').trim()
      this.startGoal(objective, criteria || objective)
    }
    this.handleGoalUpdated = (payload: any) => {
      const goal = this.goalState
      if (!goal) return
      const objective = String(payload?.objective ?? '').trim()
      const criteria = String(payload?.successCriteria ?? '').trim()
      if (objective) goal.objective = objective
      if (criteria) goal.successCriteria = criteria
      if (objective || criteria) this.persistGoalFile()
    }
    this.bus.on(EVENTS.GOAL_PROPOSAL_ACCEPTED, this.handleGoalProposalAccepted)
    this.bus.on(EVENTS.GOAL_UPDATED, this.handleGoalUpdated)

    // recall_archived_context 工具取数回调：只读引擎内存全量历史，零 IO（工具语义随引擎实例隔离）
    this.deps.builtInToolExecutor.setArchivedContextProvider?.((params) =>
      this.recallArchivedContext(params)
    )

    // search_tools 工具检索回调：闭包读当轮暂存的 toolset 做 BM25-lite 检索，命中名写入激活集（只增不改）；
    // 无当轮 toolset 或未启用渐进时返回明确提示文本，不抛异常（同步工具，语义随引擎实例隔离）
    this.deps.builtInToolExecutor.setSearchToolsProvider?.((params) => this.searchTools(params))

    // request_goal_review 评估回调：模型交卷 → 立即经独立评估器判定；
    // 达成则归档退出（GOAL_ACHIEVED + clearGoal），未达成把评估理由返回给模型继续干活
    this.deps.builtInToolExecutor.setGoalReviewProvider?.(async () => {
      const goal = this.goalState
      if (!goal) return { achieved: false, message: '当前不在目标模式，无需交卷。' }
      const modelName = await this.resolveModelName()
      if (!modelName) return { achieved: false, message: '无可用模型，无法评估；请继续推进。' }
      const verdict = await this.goalEvaluator.evaluate({
        modelName: this.resolveEvaluatorModelName(modelName),
        goal,
        recentMessages: this.history,
      })
      if (verdict.verdict === 'achieved') {
        this.bus.emit(EVENTS.GOAL_ACHIEVED, { reason: verdict.reason, roundCount: goal.roundCount })
        this.archiveGoalFile()
        this.clearGoal()
        return { achieved: true, message: `评估通过：${verdict.reason}。目标已归档并自动退出目标模式。` }
      }
      return {
        achieved: false,
        message: `评估未通过：${verdict.reason}。请继续推进；判据已被证据满足后再交卷，确实无法推进时调用 report_goal_blocked。`,
      }
    })

    // report_goal_blocked 熔断请示回调：模型判定无法推进 → 走与预算耗尽同一请示通道
    this.deps.builtInToolExecutor.setGoalBlockedHandler?.(async (reason: string) => {
      if (!this.goalState) return '当前不在目标模式。'
      const action = await this.handleGoalCircuitBreak(`模型报告无法推进：${reason}`)
      if (action === 'extend') return '用户批准追加 10 轮预算，目标已恢复推进。请换个思路继续。'
      if (!this.goalState) return '用户放弃了目标，目标模式已退出。请恢复正常对话。'
      return '目标已暂停，等待用户修改目标（/goal 重新设定后再 /goal resume）。请停止自行推进。'
    })
  }

  /** 卸载事件监听（引擎废弃前调用）；兜底触发 SessionEnd hooks（壳层退出口应显式 await endSession()） */
  dispose(): void {
    this.bus.off(EVENTS.PLAN_MODE_ENTERED, this.handlePlanModeEntered)
    this.bus.off(EVENTS.PLAN_APPROVED, this.handlePlanApproved)
    this.bus.off(EVENTS.GOAL_PROPOSAL_ACCEPTED, this.handleGoalProposalAccepted)
    this.bus.off(EVENTS.GOAL_UPDATED, this.handleGoalUpdated)
    // 模块级 hook 派发通道随引擎废弃解绑（防 stale 闭包；引擎按进程单例使用，与 setDelegationContextProvider 同前提）
    if (this.deps.hookRunner) {
      setDelegationHookDispatcher(null)
      setWorkerMcpHookDispatcher(null)
    }
    void this.endSession()
  }

  /**
   * 会话结束（CLI 各退出口 / electron before-quit / UI 会话销毁的统一调用点）：
   * 触发 SessionEnd 通知式 hooks——并行 fire-and-forget 但可等待：等待全部完成或共享
   * 1.5s 超时预算耗尽（单 handler 超时同步压缩进预算，进程由执行通道按超时兜底终止）。
   * 幂等：多次调用只触发一次（并发调用共享同一 Promise）；startNewSession/loadSession 后重置，
   * 新会话可再次触发。无 hookRunner 时立即返回。
   */
  async endSession(): Promise<void> {
    if (!this.sessionEndPromise) {
      this.sessionEndPromise = this.runSessionEndHooks()
    }
    return this.sessionEndPromise
  }

  /** SessionEnd hooks 派发（通知式；共享预算竞速兜底——dispatch 内部异常已 fail-open，此处只竞速超时） */
  private async runSessionEndHooks(): Promise<void> {
    if (!this.deps.hookRunner) return
    await Promise.race([
      this.safeDispatchHooks('SessionEnd', {
        sessionId: this.sessionId ?? '',
        cwd: this.deps.workDir ?? '',
        timeoutOverrideMs: SESSION_END_HOOKS_BUDGET_MS,
      }),
      new Promise<void>((resolve) => setTimeout(resolve, SESSION_END_HOOKS_BUDGET_MS)),
    ])
  }

  // ==================== 会话状态 ====================

  getHistory(): Message[] {
    return [...this.history]
  }

  /** 追加合成留痕消息（synthetic 为显示层标记；内容照常进模型上下文）。
      轮次进行中先入队、toolMessages 入史后 flush——保证不插进 assistant(toolCalls)
      与 tool 结果之间（OpenAI/Anthropic 邻接格式约束）。落盘失败不影响对话 */
  appendSyntheticMessage(content: string, kind: NonNullable<Message['synthetic']>): void {
    const msg: Message = { role: MessageRole.USER, content, timestamp: new Date(), synthetic: kind }
    if (this.running) { this.pendingSynthetic.push(msg); return }
    this.flushPendingSynthetic()
    this.history.push(msg)
    this.notifyMessagesChanged()
    void this.persist()
  }

  getSessionState(): ChatEngineSessionState {
    return {
      sessionId: this.sessionId,
      title: this.title,
      titleSource: this.titleSource,
      planMode: this.planMode,
      goalMode: this.goalState
        ? {
            active: this.goalState.status === 'active',
            objective: this.goalState.objective,
            roundCount: this.goalState.roundCount,
            maxRounds: this.goalState.maxRounds,
          }
        : undefined,
      frontAgent: this.frontAgent,
      isRunning: this.running,
      messageCount: this.history.length,
      compactions: [...this.compactions],
    }
  }

  /**
   * 上下文余量状态：占用 = 最近一次 API 调用的实测 promptTokens + completionTokens
   * （每次调用均为全量组装上下文，最后一次已含全部历史与工具输出，是实测而非估算）；
   * 分母取当前模型 maxContextTokens（渲染时现取，切模型自动跟随）。
   * 无实测用量（新会话/服务未返回 usage）返回 null——显示层应隐藏该段，不显示错误数字。
   */
  getContextStatus(): { usedTokens: number; maxContextTokens?: number } | null {
    if (!this.lastUsage) return null
    const modelName = this.deps.selectedModels.getCurrentModelName()
    const info = modelName ? this.deps.modelInfo.getModelInfoByName(modelName) : undefined
    return {
      usedTokens: this.lastUsage.promptTokens + this.lastUsage.completionTokens,
      maxContextTokens: info?.maxContextTokens,
    }
  }

  /**
   * 工具渐进发现状态（CLI /tools status 的数据源）：
   * mode = 最近一次 buildToolset 是否达分层条件（开关 × 阈值；尚未跑过轮次时按开关报告）；
   * coreCount 常驻核心数 / activatedCount 已激活数（非核心）/ deferredCount 未下发数。
   * 轮次外调用也可报告——数据源为最近一次 buildToolset 留存的概览快照。
   */
  getToolsStatus(): {
    mode: 'progressive' | 'full'
    coreCount: number
    activatedCount: number
    deferredCount: number
    activatedNames: string[]
  } {
    const activatedNames = [...this.activatedTools]
    const switchOn = this.deps.progressiveToolsEnabled?.() ?? true
    const snapshot = this.toolsStatusSnapshot
    const active =
      switchOn && (!snapshot || shouldEnableProgressiveTools(snapshot.deferrableChars))
    if (!active || !snapshot) {
      return { mode: active ? 'progressive' : 'full', coreCount: 0, activatedCount: 0, deferredCount: 0, activatedNames }
    }
    const coreSet = new Set<string>(CORE_TOOLS)
    const nonCoreActivated = activatedNames.filter((n) => !coreSet.has(n)).length
    return {
      mode: 'progressive',
      coreCount: snapshot.coreCount,
      activatedCount: nonCoreActivated,
      deferredCount: Math.max(0, snapshot.total - snapshot.coreCount - nonCoreActivated),
      activatedNames,
    }
  }

  /** 加载既有会话（/session load 与 UI 会话恢复）；找不到记录返回 false */
  async loadSession(id: string): Promise<boolean> {
    if (this.running) throw new Error('生成进行中，请先 abort()')
    this.assertNoRunningBackgroundTasks()
    const result = await this.deps.sessionStore.load(id)
    if (!result.success || !result.record) return false
    const record = result.record
    this.sessionId = record.id
    this.title = record.title
    this.titleSource = record.titleSource ?? 'default'
    this.createdAt = record.createdAt
    this.tasks = record.tasks
    this.frontAgent = record.frontAgent
    this.refreshAgentMemoryDir(record.frontAgent) // 恢复会话同步登记 agent 记忆写路由
    this.compactions = record.compactions ?? []
    this.pendingSynthetic = [] // 防陈旧留痕注入恢复的会话（abort 等路径可能残留队列）
    this.clearGoalOnSessionSwitch()
    // JSON 往返后 timestamp 是字符串，恢复为 Date
    this.history = (record.messages ?? []).map((m) => ({
      ...m,
      timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp),
    }))
    // 孤儿占位清扫：历史里遗留的 RUNNING task 占位（进程退出时的在途任务）标记为已中断
    this.sweepOrphanTaskPlaceholders()
    // 渐进发现激活集重建：扫描权威历史中 search_tools 的 TOOL 结果消息（[activated] 名单行）
    this.rebuildActivatedToolsFromHistory()
    // load 恢复的会话不触发自动标题
    this.createdThisRun = false
    this.autoTitleAttempted = true
    // 恢复随会话持久化的实测用量（状态栏占比立即显示，与 live 会话同精度同口径）；
    // 记录无此字段（旧记录/从未实测）则为 undefined——状态栏隐藏该段，与既往行为一致
    this.lastUsage = record.lastUsage
    // SessionStart hooks（resume）：登记派发，首轮组装上下文时 await 注入（不动本方法流程）
    this.pendingSessionStart = this.dispatchSessionStartHooks('resume')
    // SessionEnd 重新武装：加载的会话视为新会话生命周期，结束时可再次触发
    this.sessionEndPromise = null
    this.notifyMessagesChanged()
    return true
  }

  /** 开始新会话：清空历史与记录状态，下次落盘生成新会话 id */
  startNewSession(): void {
    if (this.running) throw new Error('生成进行中，请先 abort()')
    this.assertNoRunningBackgroundTasks()
    this.sessionId = null
    this.title = ''
    this.titleSource = 'default'
    this.createdAt = null
    this.tasks = undefined
    this.frontAgent = undefined
    this.compactions = []
    this.history = []
    this.pendingSynthetic = [] // 防陈旧留痕注入新会话
    this.activatedTools = new Set() // 渐进发现激活集随会话生命周期
    this.currentToolset = null
    clearAgentMemoryDir()
    this.clearGoalOnSessionSwitch()
    this.createdThisRun = false
    this.autoTitleAttempted = false
    // 新会话：旧会话用量作废
    this.lastUsage = undefined
    // SessionStart hooks（startup）：同步方法只登记派发，首轮组装上下文时 await 注入（签名不动）
    this.pendingSessionStart = this.dispatchSessionStartHooks('startup')
    // SessionEnd 重新武装：新会话生命周期开始，结束时可再次触发
    this.sessionEndPromise = null
    this.notifyMessagesChanged()
  }

  /**
   * 脱离当前会话记录（清 sessionId/title/frontAgent 等记录状态，但保留历史）：
   * 用于"删除当前会话记录但继续对话"场景——下次落盘将生成新会话 id，
   * 不会用同 id 复活刚删的记录。历史清空请用 startNewSession()。
   */
  detachSession(): void {
    if (this.running) throw new Error('生成进行中，请先 abort()')
    this.assertNoRunningBackgroundTasks()
    this.sessionId = null
    this.title = ''
    this.titleSource = 'default'
    this.createdAt = null
    this.tasks = undefined
    this.frontAgent = undefined
    this.compactions = []
    this.clearGoalOnSessionSwitch()
    this.activatedTools = new Set() // 渐进发现激活集随会话生命周期（脱离记录后按新会话计）
    this.currentToolset = null
    clearAgentMemoryDir()
    this.createdThisRun = false
    this.autoTitleAttempted = false
    this.notifyMessagesChanged()
  }

  // ==================== planMode（状态源唯一归引擎） ====================

  /**
   * 规划模式开关：状态源在引擎；同步到 builtInToolExecutor.setPlanMode（拦截生效的前提），
   * 并发 PLAN_MODE_ENTERED / PLAN_APPROVED 事件。
   * （PLAN_APPROVED 现与 executor 的 submit_plan 批准路径共用，壳侧统一按"planMode 已变化"消费。）
   */
  setPlanMode(on: boolean): void {
    if (this.planMode === on) return
    this.applyPlanMode(on)
    this.bus.emit(on ? EVENTS.PLAN_MODE_ENTERED : EVENTS.PLAN_APPROVED, {})
  }

  /** 应用 planMode 状态（不重复发事件；enter_plan_mode/submit_plan 事件路径与用户 API 路径共用） */
  private applyPlanMode(on: boolean): void {
    this.planMode = on
    this.deps.builtInToolExecutor.setPlanMode(on)
  }

  isPlanMode(): boolean {
    return this.planMode
  }

  // ==================== goalMode（状态源唯一归引擎） ====================

  /**
   * 设定目标并进入目标模式：状态源在引擎；并发 GOAL_STARTED 事件。
   * 目标模式不拦截任何修改性工具（与 plan 模式相反：plan 限制行为，goal 限制"停止条件"）。
   * 已有激活目标时不静默覆盖——由壳侧提示用户先 /goal clear。
   * successCriteria 缺省时与 objective 同文（/goal 单行输入同时承载目标与判据）。
   */
  setGoal(objective: string, successCriteria?: string, maxRounds?: number): void {
    const text = objective.trim()
    if (!text) throw new Error('目标不能为空')
    this.startGoal(text, successCriteria?.trim() || text, maxRounds)
  }

  /** 开启目标的共用收尾（/goal 与 propose_goal 批准事件两路共用）：建状态、落盘、发事件 */
  private startGoal(objective: string, successCriteria: string, maxRounds?: number): void {
    this.applyGoalState({
      objective,
      successCriteria,
      status: 'active',
      roundCount: 0,
      noProgressCount: 0,
      maxRounds: maxRounds && maxRounds > 0 ? Math.floor(maxRounds) : 20,
      createdAt: new Date().toISOString(),
    })
    this.persistGoalFile()
    this.bus.emit(EVENTS.GOAL_STARTED, { objective, maxRounds: this.goalState!.maxRounds })
  }

  /** 清除目标并退出目标模式（删工作文档、发 GOAL_CLEARED；无目标时为空操作不发事件） */
  clearGoal(): void {
    if (!this.goalState) return
    this.applyGoalState(null)
    this.clearGoalFile()
    this.bus.emit(EVENTS.GOAL_CLEARED, {})
  }

  /** 暂停目标推进（/goal pause 与熔断请示共用；仅 active 时有效） */
  pauseGoal(): void {
    const goal = this.goalState
    if (!goal || goal.status !== 'active') return
    goal.status = 'paused'
    this.persistGoalFile()
    this.bus.emit(EVENTS.GOAL_PAUSED, { objective: goal.objective, roundCount: goal.roundCount })
  }

  /** 恢复目标推进（/goal resume）：置 active 后引擎空闲即触发一次推进循环（调用方可 await 等循环跑完） */
  async resumeGoal(): Promise<void> {
    const goal = this.goalState
    if (!goal || goal.status !== 'paused') return
    goal.status = 'active'
    this.persistGoalFile()
    this.bus.emit(EVENTS.GOAL_RESUMED, { objective: goal.objective, roundCount: goal.roundCount, maxRounds: goal.maxRounds })
    if (!this.running) {
      await this.maybeContinueGoal()
    }
  }

  /** 应用目标状态（不重复发事件；同步 executor 的 goalMode 门——goal 五工具的"仅目标模式"判定） */
  private applyGoalState(state: GoalState | null): void {
    this.goalState = state
    this.deps.builtInToolExecutor.setGoalMode?.(state !== null)
  }

  isGoalMode(): boolean {
    return this.goalState !== null
  }

  /** 当前目标状态（只读副本；无目标返回 null） */
  getGoalState(): GoalState | null {
    return this.goalState ? { ...this.goalState } : null
  }

  /** 目标随会话：切换/新建/脱离会话时清除（MVP 不做跨会话附着，防目标幽灵附着到新会话） */
  private clearGoalOnSessionSwitch(): void {
    if (!this.goalState) return
    this.applyGoalState(null)
    this.clearGoalFile()
    this.bus.emit(EVENTS.GOAL_CLEARED, { reason: '会话切换' })
  }

  /** 目标文档落盘（goalStore 缺省=非 Node 环境时跳过，目标仅存内存）；落盘失败不影响对话 */
  private persistGoalFile(): void {
    if (!this.goalState) return
    try {
      this.deps.goalStore?.save(this.goalState)
    } catch (err) {
      console.error('[ChatEngine] 目标文档落盘失败:', err)
    }
  }

  private clearGoalFile(): void {
    try {
      this.deps.goalStore?.clear()
    } catch (err) {
      console.error('[ChatEngine] 目标文档清除失败:', err)
    }
  }

  /** 达成归档：goal-<时间戳>.md + 清除工作文档（归档失败不影响达成语义） */
  private archiveGoalFile(): void {
    if (!this.goalState) return
    try {
      this.deps.goalStore?.archive(this.goalState)
    } catch (err) {
      console.error('[ChatEngine] 目标文档归档失败:', err)
    }
  }

  /**
   * 熔断请示（轮次到顶/连续无进展/模型报告受阻共用通道）：
   * 先自动暂停（状态落盘）并发 GOAL_BUDGET_EXHAUSTED 通知，再经 userInputProvider.ask 请示——
   * 追加预算（+10 轮、无进展计数清零、恢复 active，返回 'extend' 由调用方续跑）/
   * 修改目标（保持 paused，等用户 /goal 重新设定）/ 放弃（clearGoal）。
   * 无应答通道（缺省或 -p 非交互）时退回迭代 1 行为：发事件 + clearGoal。
   */
  private async handleGoalCircuitBreak(reason: string): Promise<'extend' | 'stop'> {
    const goal = this.goalState
    if (!goal) return 'stop'
    const provider =
      this.deps.builtInToolExecutor.getNonInteractiveMode() === null
        ? this.deps.getUserInputProvider?.() ?? null
        : null
    if (!provider) {
      this.bus.emit(EVENTS.GOAL_BUDGET_EXHAUSTED, { reason, roundCount: goal.roundCount })
      this.clearGoal()
      return 'stop'
    }
    goal.status = 'paused'
    this.persistGoalFile()
    this.bus.emit(EVENTS.GOAL_BUDGET_EXHAUSTED, { reason, roundCount: goal.roundCount, paused: true })
    // goal 熔断请示同步发 Notification hooks（通知式 fire-and-forget；桌面可接原生通知）
    if (this.deps.hookRunner) {
      void this.safeDispatchHooks('Notification', {
        sessionId: this.sessionId ?? '',
        cwd: this.deps.workDir ?? '',
        matcherValue: 'goal_circuit_break',
        extra: { reason, objective: goal.objective, roundCount: goal.roundCount, maxRounds: goal.maxRounds },
      })
    }
    let answer = ''
    try {
      answer = await provider.ask(
        `目标模式已自动暂停：${reason}\n\n【目标】${goal.objective}\n已推进 ${goal.roundCount}/${goal.maxRounds} 轮。请选择走向：`,
        [
          { label: '追加预算继续', description: '轮次上限 +10，立即恢复推进' },
          { label: '修改目标', description: '保持暂停，用 /goal 重新设定后再 /goal resume' },
          { label: '放弃目标', description: '退出目标模式，恢复正常对话' },
        ]
      )
    } catch {
      answer = '' // 问答通道异常按"保持暂停"处理（不丢目标、不烧轮次）
    }
    // 问答期间用户可能已 /goal clear：状态现读，不沿用过期引用
    if (this.goalState !== goal) return 'stop'
    const a = String(answer ?? '').trim()
    if (a === '1' || a === '追加预算继续' || a.toLowerCase() === 'y') {
      goal.maxRounds += 10
      goal.noProgressCount = 0
      goal.status = 'active'
      this.persistGoalFile()
      this.bus.emit(EVENTS.GOAL_RESUMED, { objective: goal.objective, roundCount: goal.roundCount, maxRounds: goal.maxRounds })
      return 'extend'
    }
    if (a === '3' || a === '放弃目标' || a === '放弃') {
      this.clearGoal()
      return 'stop'
    }
    // '2'/修改目标/空/Esc：保持暂停（默认最安全：不丢目标、不消耗轮次）
    return 'stop'
  }

  // ==================== 前台选择（T2 只做状态存取；T3 角色包装经注入器生效） ====================

  /**
   * 设置前台 Agent（模板 subagent_type；不传/空串 = 裸模型）。
   * 随 SessionRecord.frontAgent 持久化：已有会话记录时立即落盘，否则并入下次每轮结束落盘。
   * 角色包装（"直接面对用户的 Agent"）在下一轮上下文组装时经 front-agent-role 注入器生效。
   */
  setFrontAgent(type?: string): void {
    const next = type || undefined
    if (next === this.frontAgent) return // 同型防抖：不落标记、不重复落盘
    const from = this.frontAgent ? `「${this.frontAgentName(this.frontAgent)}」` : '裸模型'
    this.frontAgent = next
    // 人格边界标记：agent 切换 = 指令集变更，后续模型须知"此前回复出自另一角色"；
    // 一条切换一条、零逐条噪声（模型切换不标——指令集未变）。随会话持久化，切换轨迹兼作记录
    const to = next ? `「${this.frontAgentName(next)}」` : '裸模型'
    this.appendSyntheticMessage(`（前台已切换为${to}，此前回复由${from}产出）`, 'frontSwitch')
    // per-agent 记忆写路由：切换时一次解析登记（模板无 memory 字段/切回裸模型 → null）；
    // 解析含 project 作用域向上递归（异步），落地时校验前台未再变，防快速连切串台
    this.refreshAgentMemoryDir(next)
  }

  /** 解析并登记当前前台 agent 的记忆目录（fire-and-forget；失败/无声明 → 清空持有者） */
  private refreshAgentMemoryDir(type: string | undefined): void {
    if (!type) {
      clearAgentMemoryDir()
      return
    }
    let scope: 'user' | 'project' | 'local' | undefined
    try {
      scope = this.deps.getSubagentTemplate?.(type)?.memory
    } catch {
      scope = undefined
    }
    if (!scope) {
      clearAgentMemoryDir()
      return
    }
    memoryStore
      .resolveAgentMemoryDir(scope, type, this.deps.workDir)
      .then((dir) => {
        if (this.frontAgent === type) setAgentMemoryDir(dir)
      })
      .catch(() => {
        if (this.frontAgent === type) clearAgentMemoryDir()
      })
  }

  /** 前台显示名（边界标记用）：模板 name，查不到回退 type 本身 */
  private frontAgentName(type: string): string {
    try {
      return this.deps.getSubagentTemplate?.(type)?.name ?? type
    } catch {
      return type
    }
  }

  getFrontAgent(): string | undefined {
    return this.frontAgent
  }

  /**
   * 前台候选列表（T3）：仅本地模板（builtin/custom）；远程模板（remote-mcp/remote-api）
   * 没有本地连续对话能力，只能被 task 委派。数据源 deps.getSubagents（未注入时为空）。
   */
  getFrontAgentCandidates(): AvailableSubagent[] {
    if (!this.deps.getSubagents) return []
    try {
      return filterFrontAgentCandidates(this.deps.getSubagents())
    } catch {
      return []
    }
  }

  // ==================== 宿主注入器注册（T4/T5 壳侧条件注入的框架） ====================

  registerContextInjector(injector: ContextInjector): void {
    this.contextAssembler.registerInjector(injector)
  }

  unregisterContextInjector(id: string): boolean {
    return this.contextAssembler.unregisterInjector(id)
  }

  // ==================== 主入口 ====================

  /**
   * 发送用户消息并运行模型工具循环。
   * 流式输出经 callbacks.streamCallback 透传；每轮结束落盘；首轮完成后触发自动标题。
   */
  async sendMessage(
    input: ChatEngineInput,
    callbacks: ChatEngineCallbacks = {}
  ): Promise<ChatEngineTurnResult> {
    if (this.running) throw new Error('上一轮生成尚未结束，请先 abort() 或等待完成')
    const modelName = await this.resolveModelName()
    if (!modelName) throw new Error('未检测到已配置 API Key 的模型，请先配置 API Key')
    // UserPromptSubmit hooks（挂在 sendMessage 而非 runTurn，避免 regenerate/goalTick/后台回流轮误触发）：
    // deny 丢弃消息并告知用户；additionalContext 注入本轮上下文（hook-context 注入器现读）
    if (this.deps.hookRunner) {
      const hookResult = await this.safeDispatchHooks('UserPromptSubmit', {
        sessionId: this.sessionId ?? '',
        cwd: this.deps.workDir ?? '',
        extra: { prompt: input.text },
      })
      if (hookResult) {
        this.emitHookMessages('UserPromptSubmit', hookResult.systemMessages)
        if (hookResult.verdict.type === 'deny') {
          this.emitHookMessages('UserPromptSubmit', [`已拦截该消息：${hookResult.verdict.reason}`])
          return { producedMessages: [], content: '', aborted: false }
        }
        this.turnHookContext.push(...hookResult.additionalContext)
      }
    }
    // 本轮显式点名的 agent（@提及）：存入供 explicit-agent 注入器每轮现读，runTurn finally 清空
    this.currentExplicitAgent = input.explicitAgent
    const userMessage = this.buildUserMessage(input, modelName)
    const result = await this.runTurn(userMessage, modelName, callbacks, 'merge')
    // 正常收尾是自然触发点：drain 待汇报批次（abort 收尾不立即 drain，留到下一个触发点）
    if (!result.aborted) {
      await this.drainPendingReports()
      // 目标推进排在委派回流之后（评估器要看回流写回 transcript 的 Subagent 证据）；
      // abort 收尾不续跑——中断就是人在说"停"
      await this.maybeContinueGoal()
      // R2 自动压缩评估排最后：此刻 goal/reflow 轮的实测已入 lastUsage、running 已复位
      await this.maybeAutoCompact()
    }
    return result
  }

  /**
   * 重新生成：删除最后一轮 assistant 响应（最近一条 user 消息之后的全部消息）并重跑。
   * 重跑被 abort 时恢复被删除的末轮（历史与盘一致，不留缺口）。
   */
  async regenerate(callbacks: ChatEngineCallbacks = {}): Promise<ChatEngineTurnResult> {
    if (this.running) throw new Error('上一轮生成尚未结束，请先 abort() 或等待完成')
    let lastUserIndex = -1
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === MessageRole.USER) {
        lastUserIndex = i
        break
      }
    }
    if (lastUserIndex === -1) throw new Error('没有可重新生成的用户消息')
    const modelName = await this.resolveModelName()
    if (!modelName) throw new Error('未检测到已配置 API Key 的模型，请先配置 API Key')

    // 复用原 user 消息对象（保留原 timestamp，消息身份键不变）
    const userMessage = this.history[lastUserIndex]
    const truncatedTail = this.history.slice(lastUserIndex)
    this.history.length = lastUserIndex
    this.notifyMessagesChanged()

    try {
      // 删消息后的落盘必须 replace 整盘覆写（merge 会按消息键复活已删消息）
      const result = await this.runTurn(userMessage, modelName, callbacks, 'replace')
      if (result.aborted) {
        // 中断的重新生成：恢复被删除的末轮（与盘上已持久化的历史一致）
        this.history.push(...truncatedTail)
        this.notifyMessagesChanged()
      } else {
        // 正常收尾是自然触发点：drain 待汇报批次（abort 收尾不立即 drain）
        await this.drainPendingReports()
        // 目标推进排在委派回流之后（同 sendMessage 触发点语义）
        await this.maybeContinueGoal()
        // R2 自动压缩评估（同 sendMessage：排在最后，实测已入 lastUsage）
        await this.maybeAutoCompact()
      }
      return result
    } catch (err) {
      this.history.push(...truncatedTail)
      this.notifyMessagesChanged()
      throw err
    }
  }

  /** 中断当前生成（透传 abortController 到模型调用与 task 执行） */
  abort(): void {
    this.abortController?.abort()
  }

  /**
   * 事后改写历史中 TOOL 消息（确认流归宿）：确认/拒绝的最终结果按 toolCallId 写回，
   * 模型下轮可见；消息在权威历史中只有一份。命中返回 true 并落盘。
   */
  async writeBackToolResult(
    toolCallId: string,
    result: string,
    status: ToolCallStatus
  ): Promise<boolean> {
    let found = false
    for (const msg of this.history) {
      if (msg.role === MessageRole.TOOL && msg.toolCallId === toolCallId) {
        msg.content = capToolResult(result)
        msg.toolCallStatus = status
        found = true
      }
    }
    if (!found) return false
    this.notifyMessagesChanged()
    await this.persist()
    return true
  }

  // ==================== 上下文压缩（/compact，追加式 checkpoint） ====================

  /**
   * 压缩上下文（手动 /compact 与 R2 压力触发共用入口）：总结切点之前的对话为 checkpoint
   * 追加到 compactions（messages 全量保留）。
   * 护栏：生成进行中 / 有 running 后台任务（进行中状态会写失真总结）/ user 消息不足 3 条
   * （最近 2 轮原文保留为 tail，不足 3 条无可压缩内容）。
   * 失败（模型调用降级链耗尽）抛错且记录完全不动——纯内存操作，零副作用。
   * trigger：manual=用户 /compact；auto=压力触发（PreCompact/PostCompact matcher 子类型跟随）。
   */
  async compactHistory(
    guidance?: string,
    opts?: { trigger?: 'manual' | 'auto' }
  ): Promise<{ checkpoint: CompactionCheckpoint; previousUsage?: ModelResponse['usage'] }> {
    if (this.running) throw new Error('生成进行中，请先 abort()')
    this.assertNoRunningBackgroundTasks()
    const modelName = await this.resolveModelName()
    if (!modelName) throw new Error('未检测到已配置 API Key 的模型，请先配置 API Key')
    return this.compactCore(modelName, guidance, { trigger: opts?.trigger ?? 'manual', keepRounds: 2 })
  }

  /**
   * 压缩内核（无护栏；U-A 提取）：切点计算 → 转录 → PreCompact hooks → 模型总结 →
   * checkpoint 落盘 → PostCompact hooks。调用方两类：
   * - 公共 compactHistory（手动 / R2）：护栏在外（running/后台任务/模型解析），本方法不再检查；
   * - R3 溢出恢复（recoverFromContextOverflow）：引擎内部路径，**有意绕过** running/后台任务护栏
   *   （DSH context-overflow 先例：溢出时刻宁要失真总结，不要直接崩溃），保最小尾 keepRounds=1。
   * keepRounds：保留尾轮数（manual/auto=2，与媒体保留窗口同口径；溢出恢复=1）。
   */
  private async compactCore(
    modelName: string,
    guidance: string | undefined,
    opts: { trigger: 'manual' | 'auto' | 'overflow'; keepRounds: number }
  ): Promise<{ checkpoint: CompactionCheckpoint; previousUsage?: ModelResponse['usage'] }> {
    // 切点：以 user 消息为轮边界，保留最近 keepRounds 轮原文。
    // upToTimestamp 取倒数第 keepRounds 条 user 消息的前一条——切点落在轮边界，toolCalls/TOOL 配对天然完整
    const userIndexes: number[] = []
    this.history.forEach((m, i) => {
      if (m.role === MessageRole.USER) userIndexes.push(i)
    })
    if (userIndexes.length < opts.keepRounds + 1) {
      throw new Error(`历史太短，无需压缩（最近 ${opts.keepRounds} 轮对话会原文保留）`)
    }
    const cutIndex = userIndexes[userIndexes.length - opts.keepRounds] - 1
    const upToTimestamp = new Date(msgTime(this.history[cutIndex])).toISOString()

    // 转录 = 旧总结（若有）+ 增量消息（上一 upToTimestamp 之后、新切点之前）——二次压缩承接不嵌套
    const prev = this.compactions[this.compactions.length - 1]
    const prevUpTo = prev ? new Date(prev.upToTimestamp).getTime() : 0
    const upTo = msgTime(this.history[cutIndex])
    const incremental = this.history.filter((m) => msgTime(m) > prevUpTo && msgTime(m) <= upTo)
    if (incremental.length === 0) throw new Error('没有可压缩的新对话内容')

    // PreCompact hooks（护栏通过后、模型调用前）：deny 中止压缩——此时尚未产生任何副作用
    //（纯内存操作，抛错后记录完全不动）；matcher 子类型 manual=手动 /compact、auto=压力触发、overflow=溢出恢复
    if (this.deps.hookRunner) {
      const pre = await this.safeDispatchHooks('PreCompact', {
        sessionId: this.sessionId ?? '',
        cwd: this.deps.workDir ?? '',
        matcherValue: opts.trigger,
        ...(guidance?.trim() ? { extra: { custom_instructions: guidance.trim() } } : {}),
      })
      if (pre) {
        this.emitHookMessages('PreCompact', pre.systemMessages)
        if (pre.verdict.type === 'deny') {
          throw new Error(`上下文压缩已被拦截：${pre.verdict.reason}`)
        }
      }
    }

    const modelInfo = this.deps.modelInfo.getModelInfoByName(modelName)
    // 压缩是提取+结构化任务：显式关闭思考模式（思考链不进总结，纯成本）；不带工具、温度不动
    const parameterOverrides = buildThinkingOffOverrides(modelInfo)
    const budgetChars = computeTranscriptBudgetChars(modelInfo?.maxContextTokens)
    const callModel = async (messages: Message[]): Promise<string> => {
      const resp = await this.deps.modelCaller.callOnce({ modelName, messages, parameterOverrides })
      return typeof resp?.content === 'string' ? resp.content : ''
    }
    const summary = await compactMessages(prev?.summary, incremental, callModel, guidance, budgetChars)
    if (!summary) throw new Error('压缩失败：模型调用未产生有效总结（已按降级链重试），会话记录未改动')

    const checkpoint: CompactionCheckpoint = {
      id: `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`,
      createdAt: new Date().toISOString(),
      upToTimestamp,
      summary,
    }
    if (guidance?.trim()) checkpoint.guidance = guidance.trim()
    this.compactions.push(checkpoint)
    // 压缩后重置实测用量：否则 TUI 余量虚高至下一轮（loadSession 有同款先例）
    const previousUsage = this.lastUsage
    this.lastUsage = undefined
    await this.persist('merge')
    // PostCompact hooks（checkpoint 落盘后，注入式）：additionalContext 进入下一轮上下文
    //（hook-context 注入器现读 turnHookContext）
    if (this.deps.hookRunner) {
      const post = await this.safeDispatchHooks('PostCompact', {
        sessionId: this.sessionId ?? '',
        cwd: this.deps.workDir ?? '',
        matcherValue: opts.trigger,
        extra: { checkpoint_id: checkpoint.id },
      })
      if (post) {
        this.emitHookMessages('PostCompact', post.systemMessages)
        this.turnHookContext.push(...post.additionalContext)
      }
    }
    this.notifyMessagesChanged()
    return { checkpoint, previousUsage }
  }

  /**
   * R3 溢出恢复：provider 报窗口超限后的强制压缩（保最小尾 keepRounds=1）。
   * 调用点：callWithOverflowRecovery（runToolLoop 的 callOnce 失败路径，此刻 running=true——
   * 本方法经 compactCore 有意绕过 running/后台任务护栏，见 compactCore 注释）。
   * 压缩转录自带预算收口（computeTranscriptBudgetChars），二次溢出风险低。
   * 成功发 CONTEXT_OVERFLOW_RECOVERED 事件（壳层渲染"已自动恢复"）。
   */
  private async recoverFromContextOverflow(modelName: string): Promise<void> {
    const { checkpoint } = await this.compactCore(modelName, undefined, { trigger: 'overflow', keepRounds: 1 })
    this.bus.emit(EVENTS.CONTEXT_OVERFLOW_RECOVERED, { checkpoint })
  }

  /**
   * R3 包装：模型调用 + 窗口超限自动恢复重试（一次）。
   * thunk 每次调用都重新组装发送视图——恢复产生的 checkpoint 会让切片变小，重试才真正变短。
   * 恢复失败保留**原始溢出错误**上抛（不把压缩失败错暴露给用户）；重试再失败自然上抛。
   */
  private async callWithOverflowRecovery<T>(modelName: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      if (!isContextWindowExceeded(err)) throw err
      try {
        await this.recoverFromContextOverflow(modelName)
      } catch {
        throw err
      }
      return await call()
    }
  }

  /**
   * R2 压力触发的自动压缩：轮正常结束后评估（此刻 running 已复位、goal/reflow 轮的实测已入 lastUsage）。
   * 判定全在 contextPressure 纯函数（SSOT：usage 权威，无实测不判定；窗口未登记不判定——宁可不压不可盲压）。
   * 本地不触发条件：非交互模式（-p 单轮执行，进程即将退出）；abort 轮（调用方控制，打断后不追压缩）。
   * 任何失败（护栏不满足/模型调用失败/历史太短）静默降级——下一轮结束再评估；
   * 压缩后 lastUsage 重置 → 下一次评估要等新一轮实测回报（盲区自纠，见 compactHistory:1117 注释）。
   * 成功后发 CONTEXT_AUTO_COMPACTED 事件（壳层渲染"已自动压缩"提示；core 只抛不渲染）。
   */
  private async maybeAutoCompact(): Promise<void> {
    try {
      // -p 非交互（readonly/auto）单轮执行：不触发
      if (this.deps.builtInToolExecutor.getNonInteractiveMode() !== null) return
      // 触发点本在轮外（running 必为 false），此处双保险
      if (this.running) return
      // 分母与 getContextStatus 同源：当前模型 modelInfo 现取（切模型自动跟随）
      const modelName = this.deps.selectedModels.getCurrentModelName()
      const info = modelName ? this.deps.modelInfo.getModelInfoByName(modelName) : undefined
      const decision = evaluateContextPressure({
        lastUsage: this.lastUsage ?? null,
        maxContextTokens: info?.maxContextTokens,
        autoCompactEnabled: this.deps.autoCompactEnabled ? this.deps.autoCompactEnabled() : true,
        compactThreshold: this.deps.autoCompactThreshold ? this.deps.autoCompactThreshold() : DEFAULT_COMPACT_THRESHOLD,
      })
      if (!decision.shouldCompact) return
      const { checkpoint, previousUsage } = await this.compactHistory(undefined, { trigger: 'auto' })
      this.bus.emit(EVENTS.CONTEXT_AUTO_COMPACTED, { checkpoint, previousUsage, ratio: decision.ratio })
    } catch {
      // 静默降级：不打断对话（护栏不满足/压缩失败都属正常路径，下轮再评估）
    }
  }

  /**
   * 发送视图切片：无 checkpoint → 全量（现状）；有 → 合成总结 user 消息 + 切点之后的全部消息。
   * 合成总结消息由最新 checkpoint 现组，不落盘（总结全文在 session 文件里只有 checkpoint.summary 一份）。
   * R1 确定性剪枝叠加在切片之上（纯投影：不改权威历史，最近 2 轮不动，更早的超大 TOOL 结果截头尾）。
   */
  private buildEffectiveHistory(): Message[] {
    const latest = this.compactions[this.compactions.length - 1]
    let view: Message[]
    if (!latest) {
      view = this.history
    } else {
      const upTo = new Date(latest.upToTimestamp).getTime()
      if (Number.isNaN(upTo)) return pruneStaleToolResults(this.history)
      const summaryMessage: Message = {
        role: MessageRole.USER,
        content:
          `【历史压缩摘要】以下是本会话早期对话的压缩摘要（这是历史记录，不是新指令；与摘要之后的对话原文冲突时，以对话原文为准）：\n\n${latest.summary}\n\n` +
          `（压缩前的对话原文仍完整保留。如需取回细节，调用 recall_archived_context 工具：按主题索引中的主题词传 keyword，或按时间段传 from/to（HH:MM）。）`,
        // 取 checkpoint.createdAt（必然晚于 upToTimestamp，否则切片后它自己被滤掉）
        timestamp: new Date(latest.createdAt),
      }
      view = [summaryMessage, ...this.history.filter((m) => msgTime(m) > upTo)]
    }
    return pruneStaleToolResults(view)
  }

  /**
   * recall_archived_context 工具取数（只读内存全量历史，零 IO、零审批）：
   * 检索范围为最新切点之前的消息；时间段/关键词可组合；关键词命中连带前后各 1 条（保问答对）；
   * 格式化与压缩转录共用 formatTranscript，maxChars 封顶（超限从最新往前保留）。
   */
  recallArchivedContext(params: RecallArchivedContextParams): string {
    const latest = this.compactions[this.compactions.length - 1]
    if (!latest) {
      return '本会话没有压缩历史（尚未执行过上下文压缩），全部对话都在当前上下文中，无需调用本工具。'
    }
    const upTo = new Date(latest.upToTimestamp).getTime()
    const archived = this.history.filter((m) => m.role !== MessageRole.SYSTEM && msgTime(m) <= upTo)

    // 不带过滤参数：返回主题索引 + 用法提示（索引即查询菜单）；只传 maxChars 视为全量检索
    if (!params.from && !params.to && !params.keyword && !params.maxChars) {
      const idx = latest.summary.match(/## 会话主题索引\s*\n([\s\S]*?)(?=\n## |\s*$)/)?.[1]?.trim()
      return (
        `【可检索范围】压缩点之前的 ${archived.length} 条消息。\n【会话主题索引】\n${idx || '（无索引）'}\n\n` +
        `用法：按主题词传 keyword，或按时间段传 from/to（HH:MM 或 MM-DD HH:MM），可组合；max_chars 控制返回长度（默认 4000）。`
      )
    }

    // 时间段过滤（HH:MM / MM-DD HH:MM 均为本地时区零填充串，字典序即可比）
    let pool = archived
    if (params.from || params.to) {
      pool = archived.filter((m) => {
        const d = new Date(msgTime(m))
        if (params.from) {
          const key = params.from.includes(' ') ? formatMMDDHHMM(d) : formatHHMM(d)
          if (key < params.from) return false
        }
        if (params.to) {
          const key = params.to.includes(' ') ? formatMMDDHHMM(d) : formatHHMM(d)
          if (key > params.to) return false
        }
        return true
      })
    }

    // 关键词过滤：命中连带前后各 1 条（保住问答对上下文）
    let selected = pool
    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      const keep = new Set<number>()
      pool.forEach((m, i) => {
        if (messageText(m).toLowerCase().includes(kw)) {
          keep.add(i)
          if (i > 0) keep.add(i - 1)
          if (i < pool.length - 1) keep.add(i + 1)
        }
      })
      selected = pool.filter((_, i) => keep.has(i))
    }
    if (selected.length === 0) {
      return '未命中：压缩前的消息中没有符合该条件的内容（可换关键词或放宽时间段重查）。'
    }

    const maxChars = params.maxChars && params.maxChars > 0 ? params.maxChars : 4000
    const formatted = formatTranscript(selected, { maxMsgChars: 1500, maxToolChars: 1500 })
    if (formatted.length <= maxChars) return formatted
    // 超总量：从最新往前保留（单条截断 + 总量截断双保险，防一次 recall 把省下的 token 灌回去）
    const lines = formatted.split('\n')
    const kept: string[] = []
    let total = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      if (total + lines[i].length + 1 > maxChars) break
      kept.unshift(lines[i])
      total += lines[i].length + 1
    }
    return `${kept.join('\n')}\n（结果已按 max_chars=${maxChars} 截断，仅保留最新部分；可缩小时间段或关键词范围重查）`
  }

  // ==================== 后台任务回流（T2：委派异步化） ====================

  /**
   * 后台任务落地回调（delegation 层 settle 时经 DelegationContext.notifyTaskSettled 触发）：
   * ① writeBackToolResult 改写占位（结果/错误 + SUCCESS/FAILED，自带通知+落盘；
   *    batch_task 以批次根 id 进度式重写共享占位）；
   * ② SUBAGENT_TASK_* 事件已由 delegation 层发，此处不重复；
   * ③ 批次齐否判定已在注册表 markSettled 内完成（齐才整批入待汇报队列）；
   * ④ 引擎空闲则启动回流轮；running 则留在队列（runTurn 正常收尾时 drain）。
   */
  async notifyTaskSettled(toolCallId: string, output: TaskToolOutput): Promise<void> {
    const task = getTaskRegistry().getByToolCallId(toolCallId)
    // 取消通知(cancel_task 先 markCancelled 再经本通道回流):写回"已取消" + REJECTED,不进 drain
    if (output.error_info?.code === 'CANCELLED') {
      await this.writeBackToolResult(
        toolCallId,
        output.final_output || '任务已被取消。',
        ToolCallStatus.REJECTED
      )
      return
    }
    if (!task) {
      // batch_task 批次占位根：根 id 不登记为任务（成员以派生 id 登记、根 id 存于 batchRootToolCallId），
      // 成员 settle/取消时经此进度式重写批次占位；批次齐（注册表已入队）后空闲引擎立即回流。
      // 内容统一 { content } JSON：终态 final_output 已含逐成员汇总（比单任务失败文本信息更全）；
      // 状态按 output 映射——进度 RUNNING / 全成 SUCCESS / 含失败或取消 FAILED
      if (getTaskRegistry().isBatchRoot(toolCallId)) {
        await this.writeBackToolResult(
          toolCallId,
          JSON.stringify({ content: output.final_output }),
          output.status === TaskExecutionStatus.COMPLETED
            ? ToolCallStatus.SUCCESS
            : output.status === TaskExecutionStatus.RUNNING
              ? ToolCallStatus.RUNNING
              : ToolCallStatus.FAILED
        )
        if (!this.running) {
          await this.drainPendingReports()
        }
      }
      // 其余无登记记录（sync 路径不回调）防御跳过
      return
    }
    // 已取消任务：占位已由 CANCELLED 分支写回"已取消"，destroy 引发的迟到 settle 不再覆盖
    if (task.status === 'cancelled') return
    // 内容形态与 buildTaskToolMessage 终态分支一致（成功 { content } JSON / 失败文本）；
    // 成功结果完整写回（平台永不截断），超 400KB 经 adoptTaskResult 落盘+引用（与批次对称）
    const succeeded = output.status === TaskExecutionStatus.COMPLETED
    await this.writeBackToolResult(
      toolCallId,
      succeeded
        ? JSON.stringify({ content: adoptTaskResult(toolCallId, output.final_output) })
        : `工具调用失败: ${output.error_info?.message || 'task 执行失败'}`,
      succeeded ? ToolCallStatus.SUCCESS : ToolCallStatus.FAILED
    )
    if (!this.running) {
      await this.drainPendingReports()
    }
  }

  /**
   * 待汇报批次 drain（回流轮）：一次性 drain 当前全部已齐批次、合并为一条合成 user 通知
   * 走 runTurn 同脚手架（user 不用 system——权威历史从未含 system 消息，system 入史对
   * Anthropic 系有适配风险；Claude Code 的完成通知同为合成 user 消息）；
   * await 返回后 while 串行继续（sendMessage 的 running 检查会挡递归重入；
   * 回流轮进行中新齐的批次下一轮再报）。abort/失败收尾的轮不立即 drain——
   * 批次放回队列，留到下一个自然触发点（下一任务落地或下一轮正常结束）。
   */
  private async drainPendingReports(): Promise<void> {
    if (this.reportDraining || this.running) return
    this.reportDraining = true
    try {
      while (!this.running) {
        const batches = getTaskRegistry().drainPendingReports()
        if (batches.length === 0) break
        const batchIds = batches.map((b) => b[0]?.batchId).filter((id): id is string => !!id)
        const modelName = await this.resolveModelName()
        if (!modelName) {
          // 无可用模型：批次放回，留到下一个自然触发点
          getTaskRegistry().requeueReportBatches(batchIds)
          break
        }
        const notice: Message = {
          role: MessageRole.USER,
          content: buildSettledNoticeText(batches),
          timestamp: new Date(),
          // 内部编排消息（对模型必需、对用户冗余）：显示层据 synthetic 折叠弱化为系统提示行
          synthetic: 'settledNotice',
        }
        try {
          const result = await this.runTurn(notice, modelName, { streamCallback: this.externalStreamHandler }, 'merge')
          if (result.aborted) {
            getTaskRegistry().requeueReportBatches(batchIds)
            break
          }
        } catch (err) {
          // 回流轮失败不影响主对话：批次放回，留到下一个自然触发点
          console.error('[ChatEngine] 后台任务回流轮失败:', err)
          getTaskRegistry().requeueReportBatches(batchIds)
          break
        }
      }
    } finally {
      this.reportDraining = false
    }
  }

  /**
   * 回合结束决策点（统一挂载：sendMessage / regenerate 正常收尾、resumeGoal 恢复、goalTick 轮结束
   * 都经此——不双触发）。两个决策源，任一判继续则继续：
   *
   * ① goal 评估器（goal 激活时，语义不变）：
   *    - achieved → 发 GOAL_ACHIEVED、归档目标文档、clearGoal、停；
   *    - blocked / 连续无进展 ≥3 / 轮次到顶 → 熔断请示（handleGoalCircuitBreak；追加预算则续跑）；
   *    - continue 且预算未尽 → 合成 goalTick 推进消息 → runTurn；
   * ② Stop hooks（Claude 对齐事件，deny = 强制继续）：
   *    - 无 goal：复用 goalTick 式合成续跑机制（合成 user 消息 → runTurn，hook reason 作为消息内容），
   *      连续阻断上限 5 次（MAX_STOP_HOOK_BLOCKS），stdin 带 stop_hook_active（第 2 次起 true）；
   *    - goal 激活：hook 强制的续跑计入 goal 的 maxRounds/noProgress 熔断计数
   *     （roundCount 与正常 goalTick 同样自增——防止与熔断器无限对抗）；
   *    - 熔断请示路径不问 hook——用户仲裁为最终裁定；plan 模式只挂起 goal 路径
   *     （只读模式下的完成校验仍然有效），不拦无 goal 的 Stop hooks。
   *
   * 循环骨架沿用回流轮验证过的结构（合成 user 消息 + runTurn + running/goalDraining 防重入）：
   * - 续跑轮被 abort → 立即停（中断是最高优先级停止信号），不计熔断、等用户下一句话；
   * - 续跑轮抛异常 → goal 路径按无进展计（绝不静默重试）；无 goal 路径记录后停止；
   * - 每个续跑轮收尾后先 drain 委派回流再进入下一轮评估（评估必须拿到 Subagent 回流的证据）。
   */
  private async maybeContinueGoal(): Promise<void> {
    if (this.goalDraining || this.running) return
    this.goalDraining = true
    try {
      // Stop hook 连续阻断计数（本次决策点调用内有效；新用户消息 = 新决策点，计数重置）
      let stopHookBlockCount = 0
      while (!this.running) {
        const goal = this.goalState

        // —— 无激活目标：Stop hooks 独立生效（强制验收场景）——
        if (!goal || goal.status !== 'active') {
          const denyReason = await this.checkStopHooks(stopHookBlockCount > 0)
          if (denyReason === undefined) break
          stopHookBlockCount++
          if (stopHookBlockCount > MAX_STOP_HOOK_BLOCKS) {
            this.emitHookMessages('Stop', [
              `Stop hook 已连续强制继续 ${MAX_STOP_HOOK_BLOCKS} 次，达到防死循环上限，本轮不再续跑`,
            ])
            break
          }
          const stopModelName = await this.resolveModelName()
          if (!stopModelName) break // 无可用模型：留到下一个自然触发点
          // goalTick 式合成续跑：hook reason 作为消息内容（内部编排消息，显示层按 synthetic 折叠）
          const forced: Message = {
            role: MessageRole.USER,
            content: `【完成校验未通过】${denyReason}\n请根据以上校验反馈继续处理，确认满足后再收尾。`,
            timestamp: new Date(),
            synthetic: 'goalTick',
          }
          try {
            const result = await this.runTurn(forced, stopModelName, { streamCallback: this.externalStreamHandler }, 'merge')
            if (result.aborted) break // 用户中断即停：不计熔断、不自动续跑
            await this.drainPendingReports()
          } catch (err) {
            // 失败轮不静默重试（与 goalTick 失败同口径）
            console.error('[ChatEngine] Stop hook 强制续跑轮失败:', err)
            break
          }
          continue
        }

        // —— goal 激活：评估器与 Stop hooks 同为决策源 ——
        if (this.planMode) break
        const modelName = await this.resolveModelName()
        if (!modelName) break // 无可用模型：目标保留，留到下一个自然触发点

        const verdict = await this.goalEvaluator.evaluate({
          modelName: this.resolveEvaluatorModelName(modelName),
          goal,
          recentMessages: this.history,
        })
        // 评估期间用户可能已清除目标（/goal clear）：状态现读，不沿用过期判定
        if (this.goalState !== goal) break

        // Stop hooks 决策源（blocked 走熔断请示，不问 hook——用户仲裁为最终裁定）
        const stopDeny = verdict.verdict === 'blocked' ? undefined : await this.checkStopHooks(stopHookBlockCount > 0)

        if (verdict.verdict === 'achieved' && stopDeny === undefined) {
          this.bus.emit(EVENTS.GOAL_ACHIEVED, { reason: verdict.reason, roundCount: goal.roundCount })
          this.archiveGoalFile()
          this.clearGoal()
          break
        }
        if (verdict.verdict === 'blocked') {
          if ((await this.handleGoalCircuitBreak(`目标受阻：${verdict.reason}`)) === 'extend') continue
          break
        }
        if (!verdict.progress) goal.noProgressCount++
        if (goal.noProgressCount >= 3) {
          const action = await this.handleGoalCircuitBreak(
            `连续 ${goal.noProgressCount} 轮无实质进展（最近判定：${verdict.reason}）`
          )
          if (action === 'extend') continue
          break
        }
        if (goal.roundCount >= goal.maxRounds) {
          const action = await this.handleGoalCircuitBreak(
            `已达到轮次上限 ${goal.maxRounds} 轮（最近判定：${verdict.reason}）`
          )
          if (action === 'extend') continue
          break
        }

        // hook 强制的续跑计入 goal 熔断计数（roundCount 与正常 goalTick 同样自增）
        if (stopDeny !== undefined) stopHookBlockCount++
        goal.roundCount++
        this.persistGoalFile() // 每轮 goalTick 后更新工作文档计数
        const tick: Message = {
          role: MessageRole.USER,
          content: this.buildGoalTickText(goal, verdict.reason, stopDeny),
          timestamp: new Date(),
          // 内部编排消息（对模型必需、对用户冗余）：显示层据 synthetic 折叠弱化为系统提示行
          synthetic: 'goalTick',
        }
        try {
          const result = await this.runTurn(tick, modelName, { streamCallback: this.externalStreamHandler }, 'merge')
          if (result.aborted) break // 用户中断即停：不计熔断、不自动续跑
          // 下一轮评估前先 drain 委派回流（Subagent 证据写回 transcript 后评估器才能看到）
          await this.drainPendingReports()
        } catch (err) {
          // 失败轮计熔断：按无进展计，本轮循环停止，绝不静默重试
          console.error('[ChatEngine] 目标推进轮失败:', err)
          goal.noProgressCount++
          this.persistGoalFile()
          if (goal.noProgressCount >= 3) {
            await this.handleGoalCircuitBreak(`连续 ${goal.noProgressCount} 轮无实质进展（含失败轮）`)
          }
          break
        }
      }
    } finally {
      this.goalDraining = false
    }
  }

  /**
   * Stop hooks 决策源（回合结束决策点的 hook 侧；无 runner 零开销短路）：
   * 返回 deny 原因 = 强制继续；undefined = 允许停止。stopHookActive 随 stdin 透传（防死循环标志）。
   */
  private async checkStopHooks(stopHookActive: boolean): Promise<string | undefined> {
    if (!this.deps.hookRunner) return undefined
    const result = await this.safeDispatchHooks('Stop', {
      sessionId: this.sessionId ?? '',
      cwd: this.deps.workDir ?? '',
      stopHookActive,
    })
    if (!result) return undefined
    this.emitHookMessages('Stop', result.systemMessages)
    return result.verdict.type === 'deny' ? result.verdict.reason : undefined
  }

  /** 评估器模型选定：配置的 defaultEvaluatorModel（已注册才生效）→ 回退当前会话模型 */
  private resolveEvaluatorModelName(sessionModel: string): string {
    const configured = this.deps.getEvaluatorModelName?.()?.trim()
    if (configured && this.deps.modelInfo.getModelInfoByName(configured)) return configured
    return sessionModel
  }

  /** goalTick 推进消息文本：评估理由 + 轮次预算余量 + 任务清单摘要（past_steps 等价物，每轮"记得"做过什么）；hookReason = Stop hook 强制续跑的拦截原因 */
  private buildGoalTickText(goal: GoalState, evalReason: string, hookReason?: string): string {
    const parts = [
      `【目标推进 · 第 ${goal.roundCount}/${goal.maxRounds} 轮】目标尚未达成，请继续推进。`,
      `【目标】${goal.objective}`,
      `【完成判据】${goal.successCriteria}`,
      `【评估意见】${evalReason}`,
      `【轮次预算】剩余 ${goal.maxRounds - goal.roundCount} 轮；连续无进展 ${goal.noProgressCount}/3 次（达到 3 次自动停止）。`,
    ]
    if (hookReason) parts.push(`【完成校验拦截】${hookReason}`)
    let taskSummary = ''
    try {
      taskSummary = this.deps.getTaskStatusSummary?.() ?? ''
    } catch {
      // 清单读取失败不阻断推进
    }
    if (taskSummary) parts.push(taskSummary)
    parts.push('请基于以上进展继续行动，不要重复已完成的步骤；若判据已被证据满足，直接陈述证据收尾。')
    return parts.join('\n')
  }

  /**
   * 注册外部发起轮（回流轮）的输出通道：回流轮由引擎发起、无 sendMessage callback，
   * CLI 经此打印回流输出；TUI 注册自有 handler 经 inflight 流式呈现（读取用 getter 保存/恢复）。
   */
  setExternalOutputHandler(handler: ChatEngineCallbacks['streamCallback'] | undefined): void {
    this.externalStreamHandler = handler
  }

  /** 读取当前外部输出通道（TUI 进入时保存旧值、退出时恢复的对称 getter） */
  getExternalOutputHandler(): ChatEngineCallbacks['streamCallback'] | undefined {
    return this.externalStreamHandler
  }

  /** 会话护栏：有 running 后台任务时禁止切换/新建/脱离会话（结构性保证"running 任务必属当前会话"） */
  private assertNoRunningBackgroundTasks(): void {
    const count = getTaskRegistry().listRunning().length
    if (count > 0) {
      throw new Error(`有 ${count} 个后台任务进行中，请等待完成或先取消`)
    }
  }

  /**
   * 孤儿占位清扫：注册表是进程内的，而占位 TOOL 已随会话落盘——进程退出/重启后历史里
   * 遗留的 RUNNING 占位成了"幽灵任务"（永远等不到写回）。会话加载时统一改写为
   * "已中断（进程退出）"；注册表仍在 running 的（本进程在途任务）不扫。
   */
  private sweepOrphanTaskPlaceholders(): void {
    const registry = getTaskRegistry()
    let swept = false
    for (const msg of this.history) {
      if (msg.role !== MessageRole.TOOL || msg.toolCallStatus !== ToolCallStatus.RUNNING || !msg.toolCallId) {
        continue
      }
      const task = registry.getByToolCallId(msg.toolCallId)
      if (task && task.status === 'running') continue
      // 批次占位（batch_task 根 id 不登记为任务）：任一成员仍在途则不扫
      // （有 running 任务时禁止切会话，此分支仅防御）
      if (
        !task &&
        registry.isBatchRoot(msg.toolCallId) &&
        registry.listRunning().some((t) => t.batchRootToolCallId === msg.toolCallId)
      ) {
        continue
      }
      msg.content = '该后台任务已中断（进程退出），未获得执行结果。'
      msg.toolCallStatus = ToolCallStatus.FAILED
      swept = true
    }
    if (swept) {
      this.notifyMessagesChanged()
      void this.persist()
    }
  }

  /**
   * 当轮委派上下文（单 task 经 provider 取、多 task 并行显式传入，两处同一形态）：
   * 工具集供 Subagent 分配；notifyTaskSettled 绑定引擎回流通道（回调缺省/异常静默，不反向影响执行）。
   */
  private buildDelegationContext(toolset: BuiltToolset): DelegationContext {
    let tools = toolset.tools
    let toolMetadata = toolset.toolMetadata
    // Plan mode：Subagent 只获得只读工具，修改性工具由 PLAN_MODE_BLOCKED_TOOLS 过滤
    if (this.planMode) {
      const blocked = new Set(PLAN_MODE_BLOCKED_TOOLS)
      tools = tools.filter(t => !blocked.has(t.function?.name ?? ''))
      toolMetadata = toolMetadata.filter(t => !blocked.has(t.name))
    }
    return {
      toolMetadata,
      toolDefinitions: tools,
      workDir: this.deps.workDir,
      notifyTaskSettled: (toolCallId, output) => {
        this.notifyTaskSettled(toolCallId, output).catch((err) =>
          console.error('[ChatEngine] notifyTaskSettled 处理失败:', err)
        )
      },
    }
  }

  // ==================== 内部：一轮对话 ====================

  /**
   * 运行一轮对话（sendMessage / regenerate 共用）。
   * 中断时回滚到最近安全点：userMessage 始终保留，已完成的工具循环步骤保留，
   * 仅丢弃当前不完整的 API 调用产出。符合 Vercel AI SDK steps 语义。
   */
  private async runTurn(
    userMessage: Message,
    modelName: string,
    callbacks: ChatEngineCallbacks,
    persistMode: SaveMode
  ): Promise<ChatEngineTurnResult> {
    const isFirstTurn = !this.history.some((m) => m.role === MessageRole.ASSISTANT)
    const producedMessages: Message[] = []

    this.running = true
    this.abortController = new AbortController()
    this.history.push(userMessage)
    // 会话 id 生成提前到轮次开始：本轮工具事件载荷即可携带 sessionId（落盘时机不变）
    this.ensureSessionId()
    this.notifyMessagesChanged()

    // 安全回滚点（可变引用，runToolLoop 每次 API 调用前更新）：
    // 初始值 = push userMessage 之后；工具循环每轮开始前更新为上一轮完整结果之后。
    // abort 时回滚到最近的安全点，确保已完成的 tool 步骤不丢失（符合 Vercel AI SDK steps 语义）。
    const safePoint = { length: this.history.length }

    try {
      const toolset = await this.buildToolset()
      // 当轮 toolset 暂存：search_tools 回调的检索语料（finally 清理，不跨轮滞留）
      this.currentToolset = toolset
      // T1 钩子：注册当轮全量工具集，task 执行时经 filterSubagentTools 过滤后传给 Subagent；
      // T2：上下文内绑定 notifyTaskSettled，后台任务 settle 时回流引擎（写回占位 + 批次汇报）
      setDelegationContextProvider(() => this.buildDelegationContext(toolset))

      const content = await this.runToolLoop(modelName, toolset, callbacks, producedMessages, safePoint)

      // 每轮结束落盘
      await this.persist(persistMode)
      // 首轮完成后自动标题（失败静默回退截断标题；标题生成用当前模型）
      if (isFirstTurn) {
        await this.tryAutoTitle(modelName)
      }
      return { producedMessages, content, aborted: false }
    } catch (err) {
      // 中断与其他异常统一处理：回滚到最近的安全点（最近一次 API 调用前 + userMessage），
      // 保留已完成的工具循环步骤；不完整的当前轮产出被丢弃。
      this.history.length = safePoint.length
      this.notifyMessagesChanged()
      if (isAbortError(err) || this.abortController.signal.aborted) {
        return { producedMessages: [], content: '', aborted: true }
      }
      throw err
    } finally {
      this.running = false
      this.abortController = null
      // per-turn 状态复位：显式点名的 agent 不串轮（abort/异常同样清空）
      this.currentExplicitAgent = undefined
      // 当轮 toolset 暂存清理（search_tools 语料不跨轮滞留）
      this.currentToolset = null
      // 本轮 hooks 附加上下文不跨轮滞留
      this.turnHookContext = []
    }
  }

  /** 模型工具循环（语义裁定自 baseModelService.sendChatMessage，事件载荷保持一致） */
  private async runToolLoop(
    modelName: string,
    toolset: BuiltToolset,
    callbacks: ChatEngineCallbacks,
    producedMessages: Message[],
    safePoint: { length: number }
  ): Promise<string> {
    const abortController = this.abortController!
    const taskToolAvailable = toolset.tools.some((t) => t.function?.name === 'task')
    // 渐进发现当轮是否分层生效（每轮现算：开关即时生效；阈值不达标/关闭则全量下发，与现状一致）
    const progressiveActive = this.isProgressiveActive(toolset)
    let iteration = 0

    while (true) {
      iteration++
      if (this.deps.maxToolIterations && iteration > this.deps.maxToolIterations) {
        throw new Error(`超出最大工具循环迭代次数限制: ${this.deps.maxToolIterations}`)
      }
      if (abortController.signal.aborted) throw createAbortError()

      // 每次 API 调用前标记安全回滚点：此时上一轮的 assistant + tool 完整结果已在 history 中。
      // abort 后回滚到此，确保已完成的 tool 步骤不丢失（符合 Vercel AI SDK steps 语义）。
      safePoint.length = this.history.length

      // R3 包装：每次调用都重新组装发送视图 + callOnce；窗口超限时强制压缩（保最小尾）后重试一次。
      // 组装放 thunk 内是关键——恢复产生的 checkpoint 让 buildEffectiveHistory 切片变小，重试才真正变短。
      const response = await this.callWithOverflowRecovery(modelName, async () => {
        // 每轮 API 调用前现组上下文（注入项每轮现读，改完即生效）；
        // 发送视图经 buildEffectiveHistory 切片：有压缩 checkpoint 时 = 合成总结消息 + 切点后消息（权威历史不动）
        const messagesForSend = await this.contextAssembler.assemble(
          this.buildEffectiveHistory(),
          this.buildAssembleContext(modelName, taskToolAvailable, toolset, progressiveActive)
        )

        // 渐进发现唯一裁剪点：分层生效时每次 callOnce 前现滤可见集（核心集 ∪ 当前模式集 ∪ 已激活集）；
        // 每次现滤使轮内模式切换（enter_plan_mode 等）与轮内激活自然生效；toolset 本体不裁
        //（执行 registry / 委派上下文 / toolMetadata 共用全量）。activated 追加在末尾，前缀稳定保缓存。
        const toolsForCall = progressiveActive
          ? filterVisibleTools(
              toolset.tools,
              computeVisibleNames({ mode: this.progressiveMode(), activated: this.activatedTools, desktopEnabled: this.deps.desktopToolsEnabled?.() ?? false }),
              this.activatedTools
            )
          : toolset.tools

        return await this.raceAbort(
          this.deps.modelCaller.callOnce({
            modelName,
            messages: messagesForSend,
            tools: toolsForCall,
            streamCallback: callbacks.streamCallback,
            abortController,
          })
        )
      })
      if (abortController.signal.aborted) throw createAbortError()
      // 记录实测 token 用量（getContextStatus 数据源；服务未返回 usage 时保留上一次）
      if (response.usage) this.lastUsage = response.usage

      const toolCalls = response.toolCalls ?? []

      // 末轮：无工具调用，并入最终 assistant 消息后结束
      if (toolCalls.length === 0) {
        const finalMessage: Message = {
          role: MessageRole.ASSISTANT,
          content: response.content || '',
          timestamp: new Date(),
        }
        if (response.reasoningContent) {
          finalMessage.reasoningContent = response.reasoningContent
        }
        if (response.thinkingDurationMs !== undefined) {
          finalMessage.thinkingDurationMs = response.thinkingDurationMs
        }
        this.history.push(finalMessage)
        producedMessages.push(finalMessage)
        this.notifyMessagesChanged()
        return typeof finalMessage.content === 'string' ? finalMessage.content : ''
      }

      // assistant 工具调用消息（含 reasoningContent）直接并入历史
      const assistantMessage: Message = {
        role: MessageRole.ASSISTANT,
        content: response.content || '',
        toolCalls,
        timestamp: new Date(),
      }
      if (response.reasoningContent) {
        assistantMessage.reasoningContent = response.reasoningContent
      }
      if (response.thinkingDurationMs !== undefined) {
        assistantMessage.thinkingDurationMs = response.thinkingDurationMs
      }
      this.history.push(assistantMessage)
      producedMessages.push(assistantMessage)
      this.notifyMessagesChanged()

      for (const toolCall of toolCalls) {
        this.emitToolCallRunning(toolCall, toolset)
      }

      const toolMessages = await this.executeToolCalls(toolCalls, toolset)

      // 批量冲刷：autoApply 或非交互 auto 档下，insert/replace/delete_content 的批量操作在此落盘
      await this.flushAutoApplyBatch(toolMessages)

      this.history.push(...toolMessages)
      producedMessages.push(...toolMessages)
      // 轮次中排队的合成留痕（任务清单落地等）随本轮 tool 结果之后落史并即时重建显示
      this.flushPendingSynthetic()
      this.notifyMessagesChanged()

      this.bus.emit(EVENTS.ASSISTANT_MESSAGE_CREATED, {
        module: 'chat',
        message: {
          role: MessageRole.ASSISTANT,
          content: '',
          timestamp: new Date(),
          isSubResponse: true,
        },
      })
    }
  }

  /**
   * 执行一轮工具调用：同轮多个 task → executeTaskToolCalls 真并行；
   * 其余（含单个 task）经统一入口顺序执行。返回与 toolCalls 同序的 TOOL 消息列表。
   */
  private async executeToolCalls(toolCalls: ToolCall[], toolset: BuiltToolset): Promise<Message[]> {
    const taskCalls = toolCalls.filter((tc) => tc.function?.name === 'task')

    // 同轮多 task 真并行
    if (taskCalls.length >= 2) {
      const resultsById = new Map<string, Message>()
      const others = toolCalls.filter((tc) => tc.function?.name !== 'task')
      const taskPromise = executeTaskToolCalls(
        taskCalls,
        this.buildDelegationContext(toolset),
        this.abortController ?? undefined
      )
      // 混合轮：非 task 调用顺序执行，与并行的 task 同时推进
      for (const toolCall of others) {
        resultsById.set(toolCall.id, await this.executeOneToolCall(toolCall, toolset))
      }
      const taskResults = await taskPromise
      for (const result of taskResults) {
        resultsById.set(result.toolCall.id, this.buildTaskToolMessage(result))
      }
      return toolCalls.map((tc) => resultsById.get(tc.id)!)
    }

    const messages: Message[] = []
    for (const toolCall of toolCalls) {
      messages.push(await this.executeOneToolCall(toolCall, toolset))
    }
    return messages
  }

  /** 单个工具调用（语义同 baseModelService 的工具执行分支，含事件与 TOOL 消息组装） */
  private async executeOneToolCall(toolCall: ToolCall, toolset: BuiltToolset): Promise<Message> {
    const toolName = toolCall.function.name
    // PreToolUse hooks（主会话挂载点：分叉前，此处会话/轮次上下文最全；
    // Worker 来源的调用不经过这里——其 hooks 在 builtInToolExecutor 咽喉处理，来源互斥不重复触发）。
    // 无 runner 时不引入 await——保持既有执行时序与零开销基线
    const pre = this.deps.hookRunner
      ? await this.applyPreToolUseHooks(toolCall)
      : { toolCall, denyReason: undefined }
    toolCall = pre.toolCall
    try {
      // hook deny：工具不执行，原因经工具结果 error 反馈模型（走下方统一 catch 组装失败 TOOL 消息）
      if (pre.denyReason !== undefined) throw new Error(pre.denyReason)
      let toolResult: any
      if (isBuiltInTool(toolName) && ASYNC_BUILTIN_TOOLS.includes(toolName)) {
        // 异步内置工具（含 task 单个调用）：经 builtInToolExecutor 统一入口（plan 门对 task/batch_task 豁免）
        const result = await this.deps.builtInToolExecutor.executeAsync(
          toolName,
          toolCall.function.arguments || '{}',
          toolCall.id
        )
        if (result.success) {
          // 携带媒体块的工具结果（如 capture_screen 截图）需透传 mediaParts（镜像 baseModelService 的解包语义）
          toolResult = result.mediaParts ? { data: result.data, mediaParts: result.mediaParts } : result.data
        } else {
          throw new Error(result.error || `${toolName} 执行失败`)
        }
      } else {
        // 同步内置工具（经 registry 的 BuiltInTool 包装）与 MCP / agent 资源工具
        let args: Record<string, any> = {}
        try {
          args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}
        } catch (e) {
          console.warn('解析工具参数失败:', e)
        }
        const result = await toolset.registry.execute(toolName, args)
        if (result.success) {
          toolResult = result.data
        } else {
          throw new Error(result.error || 'Tool execution failed')
        }
      }

      // PostToolUse hooks（主会话：结果组装后、TOOL_MESSAGE_CREATED 前）：
      // 可改写回传结果、additionalContext 注入本轮上下文；无 runner 时不引入 await
      if (this.deps.hookRunner) {
        toolResult = await this.applyPostToolUseHooks(toolCall, toolResult)
      }

      const mcpServerName =
        (typeof toolResult === 'object' && toolResult !== null && 'mcpServerName' in toolResult
          ? (toolResult as any).mcpServerName
          : undefined) ?? toolset.mcpServerNames.get(toolName)

      // task / batch_task 后台受理占位（T1 非阻塞化）：注册表仍 running = 占位而非终态（builtInToolExecutor
      // 把占位当 success 透传，此处按注册表甄别；batch_task 根 id 不登记为任务，按 isBatchRoot 识别），
      // 标 RUNNING 供孤儿清扫识别，写回由 notifyTaskSettled 驱动
      const isTaskPlaceholder =
        (toolName === 'task' &&
          getTaskRegistry().getByToolCallId(toolCall.id)?.status === 'running') ||
        (toolName === 'batch_task' && getTaskRegistry().isBatchRoot(toolCall.id))
      const resultStatus = isTaskPlaceholder ? ToolCallStatus.RUNNING : ToolCallStatus.SUCCESS

      // 携带媒体块的工具结果（capture_screen 截图）：mediaParts 提取后事件载荷只带文本摘要
      //（避免 MB 级 base64 在事件总线/IPC 里流动），TOOL 消息 content 构造为 ContentPart[]
      //（镜像 baseModelService.sendChatMessage 的组装语义）
      const toolMediaParts: ContentPart[] | undefined =
        (typeof toolResult === 'object' && toolResult !== null && Array.isArray(toolResult.mediaParts))
          ? toolResult.mediaParts
          : undefined

      this.bus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
        module: 'chat',
        sessionId: this.sessionId,
        toolCallStatus: resultStatus,
        mcpServerName,
        toolParameters: parseToolParameters(toolCall),
        toolResult: toolMediaParts
          ? (typeof toolResult.data === 'object' && toolResult.data !== null ? toolResult.data : { content: String(toolResult.data) })
          : (typeof toolResult === 'object' ? toolResult : { content: String(toolResult) }),
        toolCallId: toolCall.id,
        toolCall,
      })

      const rawToolMessage: Message = {
        role: MessageRole.TOOL,
        content: toolMediaParts
          ? [
              { type: 'text', text: typeof toolResult.data === 'string' ? toolResult.data : JSON.stringify(toolResult.data) } as ContentPart,
              ...toolMediaParts,
            ]
          : (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)),
        toolCallId: toolCall.id,
        toolCallStatus: resultStatus,
        timestamp: new Date(),
      }
      this.bus.emit(EVENTS.TOOL_MESSAGE_CREATED, { module: 'chat', message: rawToolMessage })
      // 入史对象套大小闸门（事件已用完整对象发出；capToolResult 纯函数，mediaParts 数组不 cap）
      return {
        ...rawToolMessage,
        content: typeof rawToolMessage.content === 'string' ? capToolResult(rawToolMessage.content) : rawToolMessage.content
      }
    } catch (toolError) {
      const errorMessage = toolError instanceof Error ? toolError.message : '未知错误'
      this.bus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
        module: 'chat',
        sessionId: this.sessionId,
        toolCallStatus: ToolCallStatus.FAILED,
        mcpServerName: undefined,
        toolParameters: parseToolParameters(toolCall),
        toolResult: errorMessage,
        toolCallId: toolCall.id,
        toolCall,
      })
      const toolMessage: Message = {
        role: MessageRole.TOOL,
        content: `工具调用失败: ${errorMessage}`,
        toolCallId: toolCall.id,
        toolCallStatus: ToolCallStatus.FAILED,
        timestamp: new Date(),
      }
      this.bus.emit(EVENTS.TOOL_MESSAGE_CREATED, { module: 'chat', message: toolMessage })
      return toolMessage
    }
  }

  /** 并行 task 结果的 TOOL 消息组装（与统一入口的输出形态一致：{ content } JSON / 失败文本） */
  private buildTaskToolMessage(result: DelegationTaskResult): Message {
    // RUNNING = 后台受理占位（T1 非阻塞化）：受理文案原文入史、标 RUNNING（非失败）；
    // 写回由 notifyTaskSettled 驱动，进程退出遗留的占位由孤儿清扫标记中断
    if (result.taskOutput.status === TaskExecutionStatus.RUNNING) {
      const toolMessage: Message = {
        role: MessageRole.TOOL,
        content: JSON.stringify({ content: result.taskOutput.final_output }),
        toolCallId: result.toolCall.id,
        toolCallStatus: ToolCallStatus.RUNNING,
        timestamp: new Date(),
      }
      this.bus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
        module: 'chat',
        sessionId: this.sessionId,
        toolCallStatus: ToolCallStatus.RUNNING,
        mcpServerName: undefined,
        toolParameters: parseToolParameters(result.toolCall),
        toolResult: { content: result.taskOutput.final_output },
        toolCallId: result.toolCall.id,
        toolCall: result.toolCall,
      })
      this.bus.emit(EVENTS.TOOL_MESSAGE_CREATED, { module: 'chat', message: toolMessage })
      return toolMessage
    }
    const succeeded = result.taskOutput.status === TaskExecutionStatus.COMPLETED
    this.bus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
      module: 'chat',
      sessionId: this.sessionId,
      toolCallStatus: succeeded ? ToolCallStatus.SUCCESS : ToolCallStatus.FAILED,
      mcpServerName: undefined,
      toolParameters: parseToolParameters(result.toolCall),
      toolResult: succeeded
        ? { content: result.taskOutput.final_output }
        : result.taskOutput.error_info?.message || 'task 执行失败',
      toolCallId: result.toolCall.id,
      toolCall: result.toolCall,
    })
    const toolMessage: Message = succeeded
      ? {
          role: MessageRole.TOOL,
          content: JSON.stringify({ content: result.taskOutput.final_output }),
          toolCallId: result.toolCall.id,
          toolCallStatus: ToolCallStatus.SUCCESS,
          timestamp: new Date(),
        }
      : {
          role: MessageRole.TOOL,
          content: `工具调用失败: ${result.taskOutput.error_info?.message || 'task 执行失败'}`,
          toolCallId: result.toolCall.id,
          toolCallStatus: ToolCallStatus.FAILED,
          timestamp: new Date(),
        }
    // SUCCESS 分支的 final_output 是长报告高风险源——事件载荷先发完整对象，入史返回值套闸门
    this.bus.emit(EVENTS.TOOL_MESSAGE_CREATED, { module: 'chat', message: toolMessage })
    return succeeded && typeof toolMessage.content === 'string'
      ? { ...toolMessage, content: capToolResult(toolMessage.content) }
      : toolMessage
  }

  /** 工具调用开始的 running/pending 事件（execute_powershell 预 pending，语义同 baseModelService） */
  private emitToolCallRunning(toolCall: ToolCall, toolset: BuiltToolset): void {
    const needPrePending = ['execute_powershell']
    this.bus.emit(EVENTS.TOOL_CALL_STATUS_CHANGED, {
      module: 'chat',
      sessionId: this.sessionId,
      toolCallStatus: needPrePending.includes(toolCall.function.name)
        ? ToolCallStatus.PENDING
        : ToolCallStatus.RUNNING,
      mcpServerName: toolset.mcpServerNames.get(toolCall.function.name),
      toolParameters: parseToolParameters(toolCall),
      toolResult: undefined,
      toolCallId: toolCall.id,
      toolCall,
    })
  }

  // ==================== hooks（生命周期挂载点的引擎侧部分；Worker 咽喉在 builtInToolExecutor） ====================

  /** hook 面向用户信息的抛出通道（core 不含显示代码；壳层订阅 HOOK_MESSAGE 渲染） */
  private emitHookMessages(event: string, messages: string[]): void {
    if (messages.length === 0) return
    this.bus.emit(EVENTS.HOOK_MESSAGE, { event, messages })
  }

  /** hook 派发（fail-open 双保险：HookRunner 内部已兜底，此处再兜一层，hooks 故障永不阻断对话） */
  private async safeDispatchHooks(
    event: HookEvent,
    ctx: HookDispatchContext,
  ): Promise<HookDispatchResult | null> {
    try {
      return await this.deps.hookRunner!.dispatch(event, ctx)
    } catch {
      return null
    }
  }

  /** SessionStart 事件登记派发（fire-later：promise 由 hook-context 注入器在首轮组装时 await；matcher: startup/resume） */
  private dispatchSessionStartHooks(source: 'startup' | 'resume'): Promise<HookDispatchResult | null> | null {
    if (!this.deps.hookRunner) return null
    return this.safeDispatchHooks('SessionStart', {
      sessionId: this.sessionId ?? '',
      cwd: this.deps.workDir ?? '',
      matcherValue: source,
    })
  }

  /** 工具入参解析（hooks 挂载点共用；解析失败返回空对象，执行路径自行报 Invalid JSON） */
  private parseToolInputForHooks(toolCall: ToolCall): Record<string, unknown> {
    try {
      const parsed: unknown = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  /**
   * PreToolUse hooks（主会话挂载点，executeOneToolCall 分叉前）：
   * transform 改写入参；deny 进工具结果 error 反馈模型；ask 升级人工审批
   * （非交互模式无人可批，降级放行并警告——对齐 chill -p 审批型 hook 的既定口径）；
   * additionalContext 注入本轮上下文（hook-context 注入器现读）。
   */
  private async applyPreToolUseHooks(toolCall: ToolCall): Promise<{ toolCall: ToolCall; denyReason?: string }> {
    if (!this.deps.hookRunner) return { toolCall }
    const toolName = toolCall.function.name
    const toolInput = this.parseToolInputForHooks(toolCall)
    const result = await this.safeDispatchHooks('PreToolUse', {
      sessionId: this.sessionId ?? '',
      cwd: this.deps.workDir ?? '',
      toolName,
      toolInput,
    })
    if (!result) return { toolCall }
    this.emitHookMessages('PreToolUse', result.systemMessages)
    this.turnHookContext.push(...result.additionalContext)

    if (result.verdict.type === 'deny') {
      return { toolCall, denyReason: result.verdict.reason }
    }
    if (result.verdict.type === 'ask') {
      if (this.deps.builtInToolExecutor.getNonInteractiveMode() !== null) {
        this.emitHookMessages('PreToolUse', [`[hooks] ${toolName} 的 ask 决策在非交互模式下无法呈现，已放行`])
        return { toolCall }
      }
      const resolution = await getApprovalChannel().request({
        toolCallId: toolCall.id,
        kind: 'command',
        command: `${toolName} ${JSON.stringify(toolInput).slice(0, 200)}`,
        detail: result.verdict.reason,
        origin: { source: 'main' },
      })
      if (!resolution.approved) {
        return { toolCall, denyReason: resolution.reason ? `审批被拒绝: ${resolution.reason}` : '审批被拒绝' }
      }
      return { toolCall }
    }
    if (result.verdict.type === 'transform') {
      return {
        toolCall: {
          ...toolCall,
          function: { ...toolCall.function, arguments: JSON.stringify(result.verdict.updatedInput) },
        },
      }
    }
    return { toolCall }
  }

  /**
   * PostToolUse hooks（主会话：结果组装后、TOOL_MESSAGE_CREATED 前）：
   * transform 的 updatedInput 作为改写后的回传结果；additionalContext 注入本轮上下文。
   */
  private async applyPostToolUseHooks(toolCall: ToolCall, toolResult: any): Promise<any> {
    if (!this.deps.hookRunner) return toolResult
    const result = await this.safeDispatchHooks('PostToolUse', {
      sessionId: this.sessionId ?? '',
      cwd: this.deps.workDir ?? '',
      toolName: toolCall.function.name,
      toolInput: this.parseToolInputForHooks(toolCall),
      toolResponse: toolResult,
    })
    if (!result) return toolResult
    this.emitHookMessages('PostToolUse', result.systemMessages)
    this.turnHookContext.push(...result.additionalContext)
    if (result.verdict.type === 'transform') return result.verdict.updatedInput
    return toolResult
  }

  /** autoApply / 非交互 auto 档的批量冲刷（语义同 baseModelService:364-378） */
  private async flushAutoApplyBatch(toolMessages: Message[]): Promise<void> {
    const executor = this.deps.builtInToolExecutor
    if (executor.getAutoApply() || executor.getNonInteractiveMode() === 'auto') {
      const batchResults = await executor.applyAutoApplyBatch()
      for (const message of toolMessages) {
        if (!message.toolCallId) continue
        const batchResult = batchResults.get(message.toolCallId)
        if (batchResult) {
          message.content =
            batchResult.success && batchResult.data
              ? batchResult.data.content
              : `操作失败: ${batchResult.error || '未知错误'}`
        }
      }
    }
  }

  // ==================== 内部：工具集构建 ====================

  /** 工具集构建统一：内置（含 task）+ MCP（单例聚合）+ agent 资源；executor messages 统一为引擎历史 */
  private async buildToolset(): Promise<BuiltToolset> {
    let builtInTools = getBuiltInTools()

    // 桌面工具功能开关（Layer 1 注册过滤，opt-in）：回调缺省或返回 false 时模型根本看不见
    // 这两个工具（零 schema token 占用、零模块加载）；执行侧另有 executeAsync 的 Layer 2 开关门兜底
    if (!this.deps.desktopToolsEnabled?.()) {
      builtInTools = builtInTools.filter((t) => !DESKTOP_TOOLS.includes(t.function.name))
    }

    let mcpTools: ToolDefinition[] = []
    try {
      mcpTools = await this.deps.mcpService.getAggregatedOpenAITools()
    } catch {
      mcpTools = []
    }


    // 加载宿主提供的本地 Agent 资源（UI 保存的工作流 Agent），注册为可调用工具
    let agentResources: ExecutableResource[] = []
    let agentTools: ToolDefinition[] = []
    if (this.deps.localAgentResources) {
      try {
        agentResources = await this.deps.localAgentResources()
        agentTools = convertResourcesToOpenAITools(agentResources)
      } catch {
        agentResources = []
        agentTools = []
      }
    }

    // 前台 Agent 的工具白名单（模板 tools 字段）：直聊路径同样遵守模板权限意图
    //（委派路径由 available_tools 约束）；模板未设 tools → 全量（现状）。
    // 过滤在组装源头完成，下游自动一致（taskToolAvailable 闸门、工具定义、注册表同一份）
    const frontWhitelist = this.frontAgentToolWhitelist()
    if (frontWhitelist) {
      builtInTools = builtInTools.filter((t) => frontWhitelist.has(t.function.name))
      mcpTools = mcpTools.filter((t) => frontWhitelist.has(t.function.name))
      // 资源工具名是派生的（execute_local/remote_agent_<sanitize>），按派生名过滤注册源后重算定义
      //（convertResourcesToOpenAITools 内部有 enabled 过滤，索引不对齐，不能 zip）
      agentResources = agentResources.filter((r) =>
        frontWhitelist.has(
          `${r.type === 'remote_agent' ? 'execute_remote_agent_' : 'execute_local_agent_'}${sanitizeName(r.name, r.id)}`
        )
      )
      agentTools = convertResourcesToOpenAITools(agentResources)
    }

    const tools = [...builtInTools, ...mcpTools, ...agentTools]

    const registry = new ToolRegistry()
    for (const t of builtInTools) {
      registry.register(
        ToolExecutorFactory.createByName(
          t.function.name,
          'builtin',
          this.history,
          this.deps.builtInToolExecutor as unknown as BuiltInToolExecutor
        )
      )
    }
    for (const t of mcpTools) {
      registry.register(ToolExecutorFactory.createByName(t.function.name, 'mcp', this.history))
    }
    for (const resource of agentResources) {
      try {
        if (resource.type === 'local_agent' && !this.deps.localAgentExecutor) continue
        if (resource.type === 'remote_agent' && !this.deps.secureStorage) continue
        registry.register(
          ToolExecutorFactory.create(resource, undefined, this.deps.localAgentExecutor, this.deps.secureStorage)
        )
      } catch (error) {
        console.warn('[ChatEngine] 注册 agent 资源工具失败，已跳过:', error)
      }
    }

    const toolMetadata: ToolMetadata[] = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
    }))

    const mcpServerNames = new Map<string, string>()
    for (const t of mcpTools) {
      const serverName = (t as any).serverName
      if (serverName) mcpServerNames.set(t.function.name, serverName)
    }

    // 工具目录（渐进发现的检索语料 / 索引注入 / 委派清单数据源）：
    // 内置经 TOOL_CATEGORY 归簇；MCP 按 serverName 归 mcp:<server> 类；agent 资源归「Agent 资源」类
    const toolCatalog: ToolCatalogEntry[] = [
      ...buildCatalogEntries(builtInTools, TOOL_CATEGORY),
      ...mcpTools.map((t) => ({
        name: t.function.name,
        description: t.function.description || '',
        category: `mcp:${mcpServerNames.get(t.function.name) ?? 'unknown'}`,
      })),
      ...agentTools.map((t) => ({
        name: t.function.name,
        description: t.function.description || '',
        category: 'Agent 资源',
      })),
    ]

    // deferrable（非核心集）定义字符数粗算：分层阈值判定数据源（~3 字符/token 换算，不跑 tokenizer）
    const coreSet = new Set<string>(CORE_TOOLS)
    const deferrableChars = tools
      .filter((t) => !coreSet.has(t.function.name))
      .reduce((sum, t) => sum + JSON.stringify(t).length, 0)
    // getToolsStatus 空闲期数据源（/tools status 通常在轮次外调用，currentToolset 已清理）
    this.toolsStatusSnapshot = {
      total: tools.length,
      coreCount: tools.filter((t) => coreSet.has(t.function.name)).length,
      deferrableChars,
    }

    return { tools, registry, toolMetadata, mcpServerNames, toolCatalog, deferrableChars }
  }

  // ==================== 内部：工具渐进发现 ====================

  /** 渐进发现当轮是否分层生效（每轮现算，开关即时生效）：opt-out 开关 × deferrable 定义字符数绝对阈值 */
  private isProgressiveActive(toolset: BuiltToolset): boolean {
    if (!(this.deps.progressiveToolsEnabled?.() ?? true)) return false
    return shouldEnableProgressiveTools(toolset.deferrableChars)
  }

  /** 渐进发现的当前模式键（MODE_TOOLS 的键）：plan 优先（plan 激活期间 goal 推进本就挂起），其次 goal */
  private progressiveMode(): string | undefined {
    if (this.planMode) return 'plan'
    if (this.goalState) return 'goal'
    return undefined
  }

  /**
   * search_tools 检索回调（executor 经 provider 转调；同步、纯内存、不抛异常）：
   * 语料 = 当轮暂存的 toolset（已过 desktop 开关与前台白名单，检索不放大权限）；
   * 命中名写入 activatedTools（只增不改，下一次 callOnce 起可见、追加在 tools 末尾）；
   * 零命中/异常经 buildSearchResultText 降级为按类别名单。
   */
  private searchTools(params: { query?: string; limit?: number; category?: string }): string {
    const toolset = this.currentToolset
    if (!toolset) {
      return 'search_tools 当前不可用：没有当轮工具集（仅在对话轮次中可检索）。'
    }
    if (!this.isProgressiveActive(toolset)) {
      return '当前为全量工具模式（工具渐进发现未开启或工具量未达分层阈值），全部工具已直接可用，无需检索激活。'
    }
    try {
      // 类别映射现取自当轮目录（内置 8 类 + mcp:<server> + Agent 资源；比 TOOL_CATEGORY 覆盖面全）
      const categories = Object.fromEntries(toolset.toolCatalog.map((e) => [e.name, e.category]))
      const hits = searchToolCorpus(toolset.tools, {
        query: params.query ?? '',
        limit: params.limit,
        category: params.category,
        categories,
      })
      for (const hit of hits) this.activatedTools.add(hit.entry.name)
      return buildSearchResultText(hits, toolset.toolCatalog)
    } catch (err) {
      console.warn('[ChatEngine] search_tools 检索失败，降级为类别名单:', err)
      return buildSearchResultText([], toolset.toolCatalog)
    }
  }

  /**
   * 从权威历史重建渐进发现激活集（loadSession 调用）：
   * 扫描 search_tools 的 TOOL 结果消息、解析 [activated] 名单行取并集——
   * TOOL 结果随会话全量落盘（compaction 不删消息），/compact 与 /session load 两场景通吃。
   */
  private rebuildActivatedToolsFromHistory(): void {
    const toolNames = new Map<string, string>()
    for (const msg of this.history) {
      if (msg.role === MessageRole.ASSISTANT && msg.toolCalls) {
        for (const tc of msg.toolCalls) toolNames.set(tc.id, tc.function?.name ?? '')
      }
    }
    const activated = new Set<string>()
    for (const msg of this.history) {
      if (msg.role !== MessageRole.TOOL || !msg.toolCallId) continue
      if (toolNames.get(msg.toolCallId) !== 'search_tools') continue
      if (typeof msg.content !== 'string') continue
      for (const name of parseActivatedNames(msg.content)) activated.add(name)
    }
    this.activatedTools = activated
  }

  // ==================== 内部：模型与用户消息 ====================

  /** 当前模型名：前台 Agent 的模板 model 优先（已注册才生效）；否则用户选定；未选定时自动选择首个有 key 的 chat 模型（生成模型经 generate_* 工具使用） */
  private async resolveModelName(): Promise<string | null> {
    const frontModel = this.resolveFrontTemplateModel()
    if (frontModel) return frontModel
    const current = this.deps.selectedModels.getCurrentModelName()
    if (current) return current
    try {
      const modelsWithKeys = (await this.deps.modelInfo.getModelsWithApiKeys()).filter(
        (m) => deriveModelKind(m.adapterConfig?.protocol) === 'chat'
      )
      if (modelsWithKeys.length > 0) {
        const first = modelsWithKeys[0]
        this.deps.selectedModels.saveCurrentModelName?.(first.name)
        return first.name
      }
    } catch {
      // 模型信息读取失败按无模型处理
    }
    return null
  }

  /** 前台模板的 model（已注册才生效；执行 resolveModelName 与显示 getFrontAgentDisplay 共用同一判定） */
  private resolveFrontTemplateModel(): string | undefined {
    if (!this.frontAgent || !this.deps.getSubagentTemplate) return undefined
    const model = this.deps.getSubagentTemplate(this.frontAgent)?.model?.trim()
    if (!model) return undefined
    return this.deps.modelInfo.getModelInfoByName(model) ? model : undefined
  }

  /** 前台 Agent 的工具白名单（模板 tools 字段；未设/无模板 → null = 不限制） */
  private frontAgentToolWhitelist(): Set<string> | null {
    if (!this.frontAgent || !this.deps.getSubagentTemplate) return null
    const tools = this.deps.getSubagentTemplate(this.frontAgent)?.tools
    return Array.isArray(tools) && tools.length > 0 ? new Set(tools) : null
  }

  /**
   * 前台直聊的显示信息（三端状态区共用）：模板显示名 + 生效模型 + 模型来源。
   * 生效模型与 resolveModelName 同一判定——显示与执行单一事实源。
   */
  getFrontAgentDisplay():
    | { name: string; model: string | undefined; modelSource: 'template' | 'current' }
    | undefined {
    if (!this.frontAgent || !this.deps.getSubagentTemplate) return undefined
    const template = this.deps.getSubagentTemplate(this.frontAgent)
    if (!template) return undefined
    const templateModel = this.resolveFrontTemplateModel()
    return {
      name: template.name,
      model: templateModel ?? this.deps.selectedModels.getCurrentModelName() ?? undefined,
      modelSource: templateModel ? 'template' : 'current',
    }
  }

  /** 当前模型媒体能力（未知返回 undefined：跳过全部媒体变换，与 CLI 无模型信息时的现状一致） */
  private getMediaCapabilities(modelName: string): ModelMediaCapabilities | undefined {
    const info = this.deps.modelInfo.getModelInfoByName(modelName)
    if (!info?.supportedModalities) return undefined
    return {
      supportsImage: info.supportedModalities.includes(ModelModality.IMAGE),
      supportsVideo: info.supportedModalities.includes(ModelModality.VIDEO),
    }
  }

  /** 构建 user 消息（输入侧能力过滤：模型不支持的媒体在并入历史前替换为占位符） */
  private buildUserMessage(input: ChatEngineInput, modelName: string): Message {
    let content: string | ContentPart[]
    if (input.contentParts?.length) {
      let parts = input.contentParts
      const capabilities = this.getMediaCapabilities(modelName)
      let filtered = false
      if (capabilities) {
        const result = filterInputContentParts(parts, capabilities)
        parts = result.parts
        filtered = result.filtered
      }
      content = filtered ? parts : parts.some((p) => p.type !== 'text') ? parts : input.text
    } else {
      content = input.text
    }
    return { role: MessageRole.USER, content, timestamp: new Date() }
  }

  private buildAssembleContext(modelName: string, taskToolAvailable: boolean, toolset: BuiltToolset, progressiveActive: boolean): AssembleContext {
    return {
      planMode: this.planMode,
      goalMode: this.goalState
        ? {
            objective: this.goalState.objective,
            successCriteria: this.goalState.successCriteria,
            roundCount: this.goalState.roundCount,
            maxRounds: this.goalState.maxRounds,
          }
        : undefined,
      frontAgent: this.frontAgent,
      modelName,
      mediaCapabilities: this.getMediaCapabilities(modelName),
      desktopEnabled: this.deps.desktopToolsEnabled?.() ?? false,
      workDir: this.deps.workDir,
      taskToolAvailable,
      toolMetadata: toolset.toolMetadata,
      toolCatalog: toolset.toolCatalog,
      toolCatalogActive: progressiveActive,
    }
  }

  /** abort 竞速：promise 未决时 abort 立即 reject AbortError（模型调用与 task 执行的透传通道） */
  private raceAbort<T>(promise: Promise<T>): Promise<T> {
    const signal = this.abortController?.signal
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(createAbortError())
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(createAbortError())
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
    })
  }

  // ==================== 内部：持久化与标题 ====================

  private notifyMessagesChanged(): void {
    if (this.onMessagesChanged) {
      try {
        this.onMessagesChanged()
      } catch {
        // 钩子失败不影响对话
      }
    }
  }

  /** 延迟落史队列冲刷：轮次中排队的合成留痕按序并入历史（调用点保证此时 tool 结果已入史，
      留痕落在其后，满足 tool_calls→tool 结果邻接约束）；空队列零开销 */
  private flushPendingSynthetic(): void {
    if (this.pendingSynthetic.length === 0) return
    this.history.push(...this.pendingSynthetic)
    this.pendingSynthetic = []
    this.notifyMessagesChanged()
  }

  /** 每轮结束落盘（merge）；regenerate 删消息后传 replace 整盘覆写。落盘失败不影响对话 */
  private async persist(mode: SaveMode = 'merge'): Promise<void> {
    if (this.history.length === 0) return
    try {
      await this.deps.sessionStore.save(this.buildRecord(), mode)
    } catch (error) {
      console.error('[ChatEngine] 会话落盘失败:', error)
    }
  }

  /** 会话 id 确保存在（轮次开始即调用，供本轮事件载荷携带；标题在 buildRecord 按历史现取） */
  private ensureSessionId(): string {
    if (this.sessionId === null) {
      // `${Date.now()}-${随机6位}`，随机后缀防多窗口同毫秒首消息撞 id（与 CliSessionService 同规则）
      this.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`
      this.createdAt = new Date().toISOString()
      this.createdThisRun = true
    }
    return this.sessionId
  }

  private buildRecord(): SessionRecord {
    const now = new Date().toISOString()
    if (this.titleSource === 'default' && !this.title) {
      this.title = extractTitle(this.history)
    }
    const record: SessionRecord = {
      id: this.ensureSessionId(),
      title: this.title,
      titleSource: this.titleSource,
      messages: [...this.history],
      createdAt: this.createdAt ?? now,
      updatedAt: now,
    }
    if (this.tasks !== undefined) {
      record.tasks = this.tasks
    }
    if (this.frontAgent !== undefined) {
      record.frontAgent = this.frontAgent
    }
    if (this.compactions.length > 0) {
      record.compactions = [...this.compactions]
    }
    // 实测用量随会话持久化（/session load 后立即恢复状态栏占比；provider 测量事实，本地不可推导）
    if (this.lastUsage !== undefined) {
      record.lastUsage = this.lastUsage
    }
    return record
  }

  /**
   * 首轮完成后尝试 LLM 自动标题（语义同 CliSessionService.tryAutoTitle）：
   * 仅本次运行新建、titleSource 为 default、且首次出现 assistant 消息时触发一次；
   * 成功后只 patch 最新记录的 title/titleSource 两个字段；任何失败静默回退截断标题。
   */
  private async tryAutoTitle(modelName: string): Promise<void> {
    if (!this.sessionId || !this.createdThisRun || this.autoTitleAttempted || this.titleSource !== 'default') {
      return
    }
    if (!this.history.some((m) => m.role === MessageRole.ASSISTANT)) return
    this.autoTitleAttempted = true
    try {
      const firstUser = this.history.find((m) => m.role === MessageRole.USER)
      const callModel = async (prompt: string): Promise<string> => {
        const resp = await this.deps.modelCaller.callOnce({
          modelName,
          messages: [{ role: MessageRole.USER, content: prompt, timestamp: new Date() }],
        })
        return typeof resp?.content === 'string' ? resp.content : ''
      }
      const title = await generateSessionTitle(extractUserText(firstUser), callModel)
      if (!title) return
      this.title = title
      this.titleSource = 'auto'
      const loaded = await this.deps.sessionStore.load(this.sessionId)
      if (loaded.success && loaded.record) {
        await this.deps.sessionStore.save({ ...loaded.record, title, titleSource: 'auto' })
      }
    } catch {
      // 静默回退截断标题
    }
  }
}

/** 消息的毫秒时间戳（timestamp 可能是 Date 或 JSON 往返后的字符串） */
function msgTime(m: Message): number {
  const t = m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** 解析工具参数（事件载荷用；解析失败为空对象，不阻断执行） */
function parseToolParameters(toolCall: ToolCall): Record<string, any> {
  try {
    return toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {}
  } catch {
    return {}
  }
}

/**
 * 回流轮合成通知消息文本（user 角色）：一次 drain 的全部已齐批次合并为一条；
 * 结果已写回对应工具消息，模型只需整合答复；"无新工作不要重复派活"防循环委派失控。
 */
function buildSettledNoticeText(batches: RegisteredTask[][]): string {
  const lines: string[] = [
    '【后台任务完成通知】以下后台任务已完成/失败，结果已更新到对应工具消息，请整合并答复用户；无新工作不要重复派活：',
  ]
  for (const batch of batches) {
    for (const task of batch) {
      const state =
        task.status === 'completed' ? '已完成' : task.status === 'failed' ? '已失败' : '已取消'
      // 条目带 toolCallId（与 query_task_status 输出格式一致），同名 task_id 的任务可区分
      lines.push(`- [${state}] ${task.subagentType}（任务标识: ${task.taskId}，toolCallId=${task.toolCallId}）${task.description ? `: ${task.description}` : ''}`)
    }
  }
  return lines.join('\n')
}
