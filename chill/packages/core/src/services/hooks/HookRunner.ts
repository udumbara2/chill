import type { IKeyValueStore } from '../../interfaces/IKeyValueStore'
import type { HookConfigLoader } from './HookConfigLoader'
import type { IHookProcessRunner, HookProcessResult } from './IHookProcessRunner'
import type {
  HookEvent,
  HookHandlerConfig,
  HookInput,
  HookInvocation,
  HookMatcherGroup,
  HookOutput,
  HookTrustApprovalRequest,
  PolicyVerdict,
} from './types'

/** handler 超时默认值（秒） */
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 30

/** 触发记录环形缓冲容量 */
export const MAX_HOOK_INVOCATIONS = 50

/** 启用/禁用状态的 KV 键（仿 skill 的 skills.disabled 先例，状态不写回 hooks.json） */
const DISABLED_KEY = 'hooks.disabled'

/** 决策事件（审批式）：串行执行、deny 熔断、updatedInput waterfall */
const DECISION_EVENTS: ReadonlySet<HookEvent> = new Set([
  'PreToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
  'PreCompact',
  'Stop',
  'PreDelegation',
])

/**
 * 注入事件（PostToolUse/PostCompact/SessionStart/PostDelegation）：
 * 与决策事件同走串行轨收集 additionalContext / 改写，但无阻断语义（阻断输出降级为警告）。
 * 不在 DECISION_EVENTS 也不在下表 NOTIFY_EVENTS 中的事件即注入事件，无需单独集合。
 */

/** 通知事件：并行 fire-and-forget，输出忽略 */
const NOTIFY_EVENTS: ReadonlySet<HookEvent> = new Set(['SessionEnd', 'Notification', 'GoalTransition'])

/** 工具名正则 matcher 的事件；其余事件的 matcher 与 matcher_value 精确相等（子类型枚举） */
const TOOL_MATCHER_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse'])

/** 一次派发的调用上下文 */
export interface HookDispatchContext {
  sessionId: string
  cwd: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResponse?: unknown
  /** 子类型事件的匹配值（SessionStart: startup/resume；GoalTransition: started/...；PreCompact: manual/auto） */
  matcherValue?: string
  stopHookActive?: boolean
  /** 单 handler 超时上限覆盖（ms，取与 handler 配置的较小值）：SessionEnd 的共享 1.5s 预算由此压到执行通道 */
  timeoutOverrideMs?: number
  /** 事件特有附加字段（原样并入 stdin JSON，标准字段优先不被覆盖；如 UserPromptSubmit 的 prompt） */
  extra?: Record<string, unknown>
}

/** 决策/注入事件的聚合返回 */
export interface HookDispatchResult {
  verdict: PolicyVerdict
  /** 全部命中 hook 的 additionalContext 拼接（保持执行顺序） */
  additionalContext: string[]
  /** 展示给用户的信息（hook 警告、systemMessage），不注入模型上下文 */
  systemMessages: string[]
  /**
   * 确有 hook 显式返回 permissionDecision:'allow'（PermissionRequest 减码槽的依据：
   * 无 hook 命中 / hook 无意见时 verdict 也是 allow，必须靠本字段区分，否则会把"无意见"误判为"自动批准"）
   */
  explicitAllow: boolean
}

export interface HookRunnerDeps {
  loader: HookConfigLoader
  processRunner: IHookProcessRunner
  /** 可选 KV（存启用/禁用状态）；不注入时禁用状态仅内存态 */
  kv?: IKeyValueStore
  /**
   * 项目级不可信 handler 的信任询问（加载后首次即将执行时当场调用；返回 true =
   * 写信任记录（loader.markTrusted）并执行）。缺省（如 -p 非交互无应答通道）时
   * 不可信 handler 一律跳过并警告。注意：本进程内被拒绝过的 handler 不再重复询问
   */
  trustApprover?: (req: HookTrustApprovalRequest) => Promise<boolean>
}

interface MatchedHandler {
  matcher?: string
  handler: HookHandlerConfig
}

/** 单个 handler 的执行结果（内部结构） */
interface HandlerOutcome {
  exitCode: number | null
  decisionLabel: string
  deny?: string
  ask?: string
  /** 显式 permissionDecision:'allow'（PermissionRequest 减码依据；与"无意见"区分） */
  allowDecision?: boolean
  updatedInput?: Record<string, unknown>
  additionalContext: string[]
  systemMessages: string[]
  error?: string
}

/**
 * hooks 核心运行器：决策链（串行 + bail + waterfall）与通知总线（并行、忽略输出）双轨。
 *
 * - 每次派发前调 loader.checkReload()（mtime 惰性重载，配置改动下一轮即生效）
 * - 零开销基线：matcher 前置过滤，无匹配 handler 时不 spawn 任何进程
 * - 项目级信任闸：不可信（首见/已变更）handler 一律不执行——有 trustApprover 当场询问、
 *   批准写信任记录；无询问通道或被拒绝则跳过并记触发记录 skipped-untrusted
 * - exit code 语义：0=放行（解析 stdout JSON）；2=阻断（stderr 为 reason）；其他=非阻断警告
 * - 超时 / 进程异常默认 fail-open，handler 配 failClosed:true 时按 deny 处理
 * - 可观测性：内存环形缓冲记录最近 50 次 HookInvocation
 */
export class HookRunner {
  private loader: HookConfigLoader
  private processRunner: IHookProcessRunner
  private kv?: IKeyValueStore
  private trustApprover?: (req: HookTrustApprovalRequest) => Promise<boolean>
  private disabledIds: Set<string> = new Set()
  /** 本进程内已被拒绝信任的项目级 handler（trustKey）：不再反复询问，直接跳过 */
  private deniedTrustKeys: Set<string> = new Set()
  private invocations: HookInvocation[] = []

  constructor(deps: HookRunnerDeps) {
    this.loader = deps.loader
    this.processRunner = deps.processRunner
    this.kv = deps.kv
    this.trustApprover = deps.trustApprover
    this.loadDisabled()
  }

  /**
   * 派发一个生命周期事件。
   * 决策/注入事件返回聚合结果；通知事件返回 null（fire-and-forget 已等待落地，输出忽略）。
   */
  async dispatch(event: HookEvent, ctx: HookDispatchContext): Promise<HookDispatchResult | null> {
    const config = await this.loader.checkReload()
    const groups = config[event]
    if (!groups || groups.length === 0) return this.emptyResult(event)

    const systemMessages: string[] = []
    const matched = await this.collectMatched(event, groups, ctx, systemMessages)
    if (matched.length === 0) {
      const empty = this.emptyResult(event)
      if (empty) empty.systemMessages.push(...systemMessages)
      return empty
    }

    if (NOTIFY_EVENTS.has(event)) {
      await this.runNotify(event, matched, ctx)
      return null
    }
    const isDecision = DECISION_EVENTS.has(event)
    return this.runSerial(event, matched, ctx, isDecision, systemMessages)
  }

  /** 最近触发记录（最新在前），供 /hooks log 展示 */
  getRecentInvocations(): HookInvocation[] {
    return [...this.invocations].reverse()
  }

  // ---------- 启用/禁用（仿 SkillRegistry，KV 键 hooks.disabled） ----------

  /** handler 的稳定标识：事件名 + name（缺省 command） */
  handlerId(event: HookEvent, handler: HookHandlerConfig): string {
    return `${event}:${handler.name ?? handler.command}`
  }

  isEnabled(id: string): boolean {
    return !this.disabledIds.has(id)
  }

  disable(id: string): void {
    this.disabledIds.add(id)
    this.persistDisabled()
  }

  enable(id: string): void {
    this.disabledIds.delete(id)
    this.persistDisabled()
  }

  getDisabledIds(): string[] {
    return [...this.disabledIds]
  }

  private loadDisabled(): void {
    if (!this.kv) return
    const raw = this.kv.getItem(DISABLED_KEY)
    if (!raw) return
    try {
      const names: unknown = JSON.parse(raw)
      if (Array.isArray(names)) {
        this.disabledIds = new Set(names.filter((n): n is string => typeof n === 'string'))
      }
    } catch {
      /* 解析失败则忽略，保持空 Set */
    }
  }

  private persistDisabled(): void {
    if (!this.kv) return
    this.kv.setItem(DISABLED_KEY, JSON.stringify([...this.disabledIds]))
  }

  // ---------- 内部实现 ----------

  private emptyResult(event: HookEvent): HookDispatchResult | null {
    if (NOTIFY_EVENTS.has(event)) return null
    return { verdict: { type: 'allow' }, additionalContext: [], systemMessages: [], explicitAllow: false }
  }

  /** matcher 前置过滤 + 禁用过滤 + 未实现类型过滤 + 项目级信任闸；返回保持配置顺序的命中列表 */
  private async collectMatched(
    event: HookEvent,
    groups: HookMatcherGroup[],
    ctx: HookDispatchContext,
    systemMessages: string[]
  ): Promise<MatchedHandler[]> {
    const matched: MatchedHandler[] = []
    for (const group of groups) {
      if (!this.matchGroup(event, group.matcher, ctx, systemMessages)) continue
      for (const handler of group.hooks) {
        if (handler.type !== 'command') {
          systemMessages.push(
            `[hooks] 事件 ${event} 的 handler "${handler.name ?? handler.command}" 类型为 ${handler.type}，首版未实现，已跳过`
          )
          continue
        }
        if (!this.isEnabled(this.handlerId(event, handler))) continue
        if (!(await this.ensureTrusted(event, group.matcher, handler, systemMessages))) continue
        matched.push({ matcher: group.matcher, handler })
      }
    }
    return matched
  }

  /**
   * 项目级信任闸（安全模型核心）：不可信 handler 一律不执行。
   * - 用户级默认可信；项目级 trusted 直接放行
   * - new/changed：有 trustApprover 时当场询问——批准则写信任记录并执行；
   *   拒绝（或询问通道自身抛异常，安全侧失败）记入本进程拒绝集，后续直接跳过不再反复询问
   * - 无 trustApprover（如 -p 非交互）：跳过并警告
   * 被跳过的 handler 记触发记录 decision='skipped-untrusted'（/hooks log 可查）
   */
  private async ensureTrusted(
    event: HookEvent,
    matcher: string | undefined,
    handler: HookHandlerConfig,
    systemMessages: string[]
  ): Promise<boolean> {
    if (handler.source?.kind !== 'project' || handler.trust === 'trusted') return true
    const label = handler.name ?? handler.command
    const sourcePath = handler.source.path
    const reasonLabel = handler.trust === 'changed' ? '已变更' : '首见'
    const trustKey = handler.trustKey ?? `${sourcePath}\n${this.handlerId(event, handler)}`

    if (this.deniedTrustKeys.has(trustKey)) {
      this.recordSkipped(event, matcher, handler)
      return false
    }
    if (!this.trustApprover) {
      systemMessages.push(
        `[hooks] 项目级 hook "${label}"（${sourcePath}）${reasonLabel}、未获信任，且当前无交互询问通道，已跳过执行`
      )
      this.recordSkipped(event, matcher, handler)
      return false
    }
    let approved = false
    try {
      approved = await this.trustApprover({
        handlerId: this.handlerId(event, handler),
        event,
        command: handler.command,
        sourcePath,
        reason: handler.trust === 'changed' ? 'changed' : 'new',
      })
    } catch {
      approved = false // 询问通道异常：视同拒绝（安全侧失败）
    }
    if (approved) {
      this.loader.markTrusted(handler)
      return true
    }
    this.deniedTrustKeys.add(trustKey)
    systemMessages.push(
      `[hooks] 项目级 hook "${label}"（${sourcePath}，${reasonLabel}）未获信任批准，已跳过执行`
    )
    this.recordSkipped(event, matcher, handler)
    return false
  }

  /** 不可信跳过的触发记录（durationMs 0、exitCode null，decision='skipped-untrusted'） */
  private recordSkipped(event: HookEvent, matcher: string | undefined, handler: HookHandlerConfig): void {
    this.invocations.push({
      event,
      matcher,
      handlerName: handler.name ?? handler.command,
      command: handler.command,
      durationMs: 0,
      exitCode: null,
      decision: 'skipped-untrusted',
      at: new Date().toISOString(),
    })
    if (this.invocations.length > MAX_HOOK_INVOCATIONS) {
      this.invocations.shift()
    }
  }

  /**
   * matcher 匹配：工具事件按工具名正则；其余事件与 matcher_value 精确相等。
   * 空/省略 = 全匹配。正则非法时 fail-open（该组视为不匹配、不干扰正常流程）并记录警告。
   */
  private matchGroup(
    event: HookEvent,
    matcher: string | undefined,
    ctx: HookDispatchContext,
    systemMessages: string[]
  ): boolean {
    if (matcher === undefined || matcher === '') return true
    if (TOOL_MATCHER_EVENTS.has(event)) {
      try {
        return new RegExp(matcher).test(ctx.toolName ?? '')
      } catch (err) {
        systemMessages.push(
          `[hooks] 事件 ${event} 的 matcher 正则 "${matcher}" 非法（${err instanceof Error ? err.message : String(err)}），该组已跳过`
        )
        return false
      }
    }
    return ctx.matcherValue === matcher
  }

  /** 决策/注入轨：串行执行，deny/ask 熔断，updatedInput waterfall，additionalContext 全拼接 */
  private async runSerial(
    event: HookEvent,
    matched: MatchedHandler[],
    ctx: HookDispatchContext,
    isDecision: boolean,
    systemMessages: string[]
  ): Promise<HookDispatchResult> {
    const result: HookDispatchResult = {
      verdict: { type: 'allow' },
      additionalContext: [],
      systemMessages,
      explicitAllow: false,
    }
    let currentInput = ctx.toolInput
    let transformed = false

    for (const { matcher, handler } of matched) {
      const outcome = await this.runCommandHandler(event, matcher, handler, ctx, currentInput)
      result.additionalContext.push(...outcome.additionalContext)
      result.systemMessages.push(...outcome.systemMessages)
      // 显式 allow 不熔断（其余 hook 照常执行、context 照常收集），仅记录事实供减码槽判定
      if (outcome.allowDecision) result.explicitAllow = true

      if (outcome.deny !== undefined) {
        if (isDecision) {
          // deny 熔断（bail）：后续 handler 不再执行
          result.verdict = { type: 'deny', reason: outcome.deny }
          return result
        }
        // 注入事件无阻断语义：降级为警告，链继续
        result.systemMessages.push(`[hooks] 事件 ${event} 不支持阻断，handler "${handler.name ?? handler.command}" 的阻断输出已忽略`)
      }
      if (outcome.ask !== undefined) {
        if (isDecision) {
          result.verdict = { type: 'ask', reason: outcome.ask }
          return result
        }
        result.systemMessages.push(`[hooks] 事件 ${event} 不支持 ask 语义，handler "${handler.name ?? handler.command}" 的 ask 输出已忽略`)
      }
      if (outcome.updatedInput !== undefined) {
        currentInput = outcome.updatedInput
        transformed = true
      }
    }

    if (transformed) {
      result.verdict = { type: 'transform', updatedInput: currentInput ?? {} }
    }
    return result
  }

  /** 通知轨：并行 fire-and-forget，输出忽略（仅记录触发） */
  private async runNotify(
    event: HookEvent,
    matched: MatchedHandler[],
    ctx: HookDispatchContext
  ): Promise<void> {
    await Promise.allSettled(
      matched.map(({ matcher, handler }) => this.runCommandHandler(event, matcher, handler, ctx, ctx.toolInput))
    )
  }

  /** 执行单个 command 型 handler，落实 exit code / 超时 / failClosed 语义并记录触发 */
  private async runCommandHandler(
    event: HookEvent,
    matcher: string | undefined,
    handler: HookHandlerConfig,
    ctx: HookDispatchContext,
    currentInput: Record<string, unknown> | undefined
  ): Promise<HandlerOutcome> {
    const input: HookInput = {
      ...(ctx.extra ?? {}),
      session_id: ctx.sessionId,
      cwd: ctx.cwd,
      hook_event_name: event,
      tool_name: ctx.toolName,
      tool_input: currentInput,
      tool_response: ctx.toolResponse,
      matcher_value: ctx.matcherValue,
      stop_hook_active: ctx.stopHookActive,
    }
    const timeoutMs = (handler.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000
    // 共享预算事件（SessionEnd）：单 handler 超时压缩到预算内，进程由执行通道按超时兜底终止
    const effectiveTimeoutMs = Math.min(timeoutMs, ctx.timeoutOverrideMs ?? timeoutMs)
    const startedAt = Date.now()

    let result: HookProcessResult
    try {
      result = await this.processRunner.run(handler.command, JSON.stringify(input), effectiveTimeoutMs)
    } catch (err) {
      // 执行通道自身抛异常：视同进程异常
      const outcome = this.failOutcome(handler, `执行通道异常: ${err instanceof Error ? err.message : String(err)}`)
      this.recordInvocation(event, matcher, handler, startedAt, outcome)
      return outcome
    }

    const outcome = this.interpretResult(handler, result)
    this.recordInvocation(event, matcher, handler, startedAt, outcome)
    return outcome
  }

  /** exit code 语义解释：0=放行并解析 stdout；2=阻断；其他=非阻断警告；超时/异常按 failClosed 判定 */
  private interpretResult(handler: HookHandlerConfig, result: HookProcessResult): HandlerOutcome {
    if (result.timedOut) {
      return this.failOutcome(handler, `执行超时（${handler.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS}s）`)
    }
    if (result.exitCode === null) {
      return this.failOutcome(handler, '进程未能正常退出')
    }
    if (result.exitCode === 2) {
      const reason = result.stderr.trim() || 'hook 阻断'
      return { exitCode: 2, decisionLabel: 'deny', deny: reason, additionalContext: [], systemMessages: [] }
    }
    if (result.exitCode !== 0) {
      const stderrTail = result.stderr.trim()
      return {
        exitCode: result.exitCode,
        decisionLabel: 'error',
        additionalContext: [],
        systemMessages: [
          `[hooks] handler "${handler.name ?? handler.command}" 退出码 ${result.exitCode}（非阻断）${stderrTail ? `: ${stderrTail}` : ''}`,
        ],
        error: stderrTail || `退出码 ${result.exitCode}`,
      }
    }
    return this.parseStdout(result)
  }

  /** 超时 / 进程异常：默认 fail-open（警告放行），failClosed 时按 deny 处理 */
  private failOutcome(handler: HookHandlerConfig, message: string): HandlerOutcome {
    if (handler.failClosed === true) {
      return {
        exitCode: null,
        decisionLabel: 'deny',
        deny: `${message}（failClosed）`,
        additionalContext: [],
        systemMessages: [],
        error: message,
      }
    }
    return {
      exitCode: null,
      decisionLabel: 'error',
      additionalContext: [],
      systemMessages: [`[hooks] handler "${handler.name ?? handler.command}" ${message}，fail-open 放行`],
      error: message,
    }
  }

  /** exit 0 的 stdout 解析；污染容错：非 JSON 的 stdout 按纯文本 additionalContext 处理 */
  private parseStdout(result: HookProcessResult): HandlerOutcome {
    const text = result.stdout.trim()
    const base: HandlerOutcome = {
      exitCode: 0,
      decisionLabel: 'allow',
      additionalContext: [],
      systemMessages: [],
    }
    if (!text) return base

    let parsed: HookOutput | null = null
    try {
      const value: unknown = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as HookOutput
      }
    } catch {
      /* 落入纯文本容错 */
    }
    if (!parsed) {
      base.additionalContext.push(text)
      return base
    }

    if (typeof parsed.systemMessage === 'string' && parsed.systemMessage !== '') {
      base.systemMessages.push(parsed.systemMessage)
    }
    const hso = parsed.hookSpecificOutput
    if (hso && typeof hso.additionalContext === 'string' && hso.additionalContext !== '') {
      base.additionalContext.push(hso.additionalContext)
    }

    // 顶层 decision:'block'/'deny' / continue:false → 阻断
    //（'deny' 为 hook-author skill 文档与内部 PolicyVerdict 词汇，'block' 为 Claude 协议词；两者同义兼容）
    if (parsed.decision === 'block' || parsed.decision === 'deny' || parsed.continue === false) {
      base.deny = typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : 'hook 阻断'
      base.decisionLabel = 'deny'
      return base
    }
    if (hso) {
      if (hso.permissionDecision === 'deny') {
        base.deny = typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : 'hook deny'
        base.decisionLabel = 'deny'
        return base
      }
      if (hso.permissionDecision === 'ask') {
        base.ask = typeof parsed.reason === 'string' && parsed.reason !== '' ? parsed.reason : undefined
        base.decisionLabel = 'ask'
        return base
      }
      // 显式 allow：记录事实（PermissionRequest 减码依据），不提前返回——updatedInput 仍可同携
      if (hso.permissionDecision === 'allow') {
        base.allowDecision = true
      }
      if (hso.updatedInput && typeof hso.updatedInput === 'object' && !Array.isArray(hso.updatedInput)) {
        base.updatedInput = hso.updatedInput
        base.decisionLabel = 'transform'
      }
    }
    return base
  }

  private recordInvocation(
    event: HookEvent,
    matcher: string | undefined,
    handler: HookHandlerConfig,
    startedAt: number,
    outcome: HandlerOutcome
  ): void {
    this.invocations.push({
      event,
      matcher,
      handlerName: handler.name ?? handler.command,
      command: handler.command,
      durationMs: Date.now() - startedAt,
      exitCode: outcome.exitCode,
      decision: outcome.decisionLabel,
      error: outcome.error,
      at: new Date().toISOString(),
    })
    if (this.invocations.length > MAX_HOOK_INVOCATIONS) {
      this.invocations.shift()
    }
  }
}
