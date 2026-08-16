import type { CliContext } from '../context/CliContext.js'
import * as readline from 'node:readline'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ChatEngine,
  eventBus,
  EVENTS,
  MessageRole,
  ToolCallStatus,
  buildContentParts,
  getOwnProjectPaths,
  modelInfoService,
  providerManager,
  SelectedModelsService,
  type AvailableSubagent,
  type ChatEngineInput,
  type ContextInjector,
  type GoalState,
  type Message,
  type SessionStoreAdapter,
  type StreamCallback,
  type SubagentTaskEventPayload,
  type ToolCall,
} from '@assistant-ai/core'
import { pathToDescriptor, cliVideoStorage } from '../adapters/cliMediaAdapter.js'
import { createCliChatEngine } from '../adapters/cliChatEngineFactory.js'
import { isTuiActive } from '../tui/tuiState.js'

/**
 * 流式打印器工厂（[思考中]/[回复]/[工具调用] ANSI 范式，每次调用返回独立状态的一套）：
 * chat() 的 sendMessage streamCallback（含补打监听用 printToolCall）与
 * 回流轮常驻输出通道（setExternalOutputHandler）共用。
 * writeEvent（旁路事件）/writeContent（助手正文）注入——可测性接缝
 * （无头验证可驱动 abort 时序断言 SGR 复位，参照 todoTracker 导出工厂先例）。
 */
export function createStreamPrinter(
  writeEvent: (text: string) => void,
  writeContent: (text: string) => void
): { streamCallback: StreamCallback; printToolCall: (tc: ToolCall) => void; resetSgr: () => void } {
  const printedToolCallIds = new Set<string>()
  let lastPrintedToolName: string | null = null
  let lastPrintedToolCount = 0
  let needLeadingNewline = true
  let thinkingStarted = false
  let thinkingEnded = false

  const printToolCall = (tc: ToolCall): void => {
    if (tc.id && printedToolCallIds.has(tc.id)) return
    if (tc.id) printedToolCallIds.add(tc.id)
    const name = tc.function.name
    if (needLeadingNewline) {
      writeEvent('\n')
      needLeadingNewline = false
    }
    if (name === lastPrintedToolName && lastPrintedToolCount >= 1) {
      lastPrintedToolCount++
      writeEvent(`\x1b[1A\x1b[0K\r[工具调用] ${name} x${lastPrintedToolCount}\n`)
    } else {
      lastPrintedToolName = name
      lastPrintedToolCount = 1
      writeEvent(`[工具调用] ${name}\n`)
    }
  }

  const streamCallback: StreamCallback = (chunk) => {
    if (chunk.reasoningContent) {
      if (!thinkingStarted) {
        thinkingStarted = true
        writeEvent('\n[思考中]\n\x1b[2m')
      }
      writeEvent(chunk.reasoningContent)
    }
    if (chunk.content) {
      if (thinkingStarted && !thinkingEnded) {
        thinkingEnded = true
        writeEvent('\x1b[0m\n[回复]\n\n')
      }
      writeContent(chunk.content)
    }
    if (chunk.toolCalls && chunk.toolCalls.length > 0) {
      for (const tc of chunk.toolCalls) {
        printToolCall(tc)
      }
    }
    if (chunk.isStreamComplete) {
      if (thinkingStarted && !thinkingEnded) {
        writeEvent('\x1b[0m\n')
      }
      writeContent('\n')
      // 每次 API 调用结束后重置标志，确保后续轮次能重新输出
      // [思考中] 标题、dim 样式以及 [工具调用] 前的换行符
      thinkingStarted = false
      thinkingEnded = false
      lastPrintedToolName = null
      lastPrintedToolCount = 0
      needLeadingNewline = true
    }
  }

  /** SGR 复位兜底（abort/异常路径：dim 在 [思考中] 标题处打开，仅正文到达与 isStreamComplete
   *  两处复位，中断后终端会残留 dim 属性——思考中 Ctrl+X 后后续输出全灰）。
   *  幂等：仅 dim 打开且未复位时写复位序列并复位标志，其余情况空转 */
  const resetSgr = (): void => {
    if (thinkingStarted && !thinkingEnded) {
      thinkingEnded = true
      writeEvent('\x1b[0m')
    }
  }

  return { streamCallback, printToolCall, resetSgr }
}

/**
 * CLI 聊天壳（T4：对话路径收敛为 ChatEngine 调用）
 *
 * 引擎负责：权威历史、上下文组装（公共注入）、工具集构建与工具循环（含同轮多 task 并行）、
 * planMode/goalMode 状态、前台选择、持久化与自动标题、abort 回滚。
 * 本壳保留：readline 渲染（[思考中]/[回复]/[工具调用] ANSI 打印）、CLI 专属注入器
 * （selfMd/status/switch/failure）、非交互模式标记、委派进度打印、/front 与 planMode/goalMode 的引擎代理。
 * （写确认已收敛到 core 的通用审批通道：边界内直接写、边界外当场审批，壳侧无暂存收集）
 */
export class CliChatService {
  private ctx: CliContext
  private engine: ChatEngine
  /** 当前 CLI 交互模式（单一数据源，cli.ts 直接读写此属性） */
  mode: 'auto' | 'mcp' | 'workflow' = 'auto'
  /** 非交互一次性执行模式（chill -p）：旁路事件输出走 stderr，stdout 只留助手正文，跳过确认交互 */
  private nonInteractive = false

  constructor(ctx: CliContext, _rl: readline.Interface, sessionStore: SessionStoreAdapter) {
    this.ctx = ctx
    this.engine = createCliChatEngine(ctx, sessionStore)
    // CLI 专属条件注入器（selfMd/status/switch/failure；order 复现旧 prefixMsgs 插入位置）
    for (const injector of this.createCliInjectors()) {
      this.engine.registerContextInjector(injector)
    }
    this.registerSubagentPrinting()
    // 回流轮渲染通道：回流轮由引擎发起、无 sendMessage 的 streamCallback——
    // 注册常驻输出回调打印回流汇报（与 chat() 同一打印范式；TUI 活跃时 writeEvent 自动跳过，
    // TUI 侧经 onMessagesChanged 呈现消息流，不重复渲染）
    this.engine.setExternalOutputHandler(this.createStreamPrinter().streamCallback)
  }

  // ==================== 引擎状态代理（壳命令经此读写） ====================

  /** 规划模式：状态源在引擎（此处为只读代理，promptForMode 用） */
  get planMode(): boolean {
    return this.engine.isPlanMode()
  }

  /** 规划模式开关（/plan、/plan off 壳命令；引擎同步 executor 并发事件） */
  setPlanMode(on: boolean): void {
    this.engine.setPlanMode(on)
  }

  /** 目标模式：状态源在引擎（此处为只读代理，promptForMode 用） */
  isGoalMode(): boolean {
    return this.engine.isGoalMode()
  }

  /** 当前目标状态（/goal 幂等提示与 TUI 状态栏数据源；无目标返回 null） */
  getGoalState(): GoalState | null {
    return this.engine.getGoalState()
  }

  /** 设定目标（/goal <目标与判据> 壳命令；引擎发 GOAL_STARTED 事件） */
  setGoal(objective: string, successCriteria?: string, maxRounds?: number): void {
    this.engine.setGoal(objective, successCriteria, maxRounds)
  }

  /** 清除目标（/goal clear|off 壳命令；引擎发 GOAL_CLEARED 事件） */
  clearGoal(): void {
    this.engine.clearGoal()
  }

  /** 暂停目标推进（/goal pause 壳命令；引擎发 GOAL_PAUSED 事件） */
  pauseGoal(): void {
    this.engine.pauseGoal()
  }

  /** 恢复目标推进（/goal resume 壳命令；引擎空闲时 await 至推进循环跑完，与 chat 同一阻塞语义） */
  async resumeGoal(): Promise<void> {
    return this.engine.resumeGoal()
  }

  /** /compact：压缩历史上下文（引擎代理；护栏不满足或失败时抛错，错误消息已含用户可读原因） */
  async compactHistory(guidance?: string) {
    return this.engine.compactHistory(guidance)
  }

  /** 当前会话 id（watch 跟随、/ui handoff 用；未落盘前为 null） */
  getSessionId(): string | null {
    return this.engine.getSessionState().sessionId
  }

  /** 当前消息列表（/memory distill 读取） */
  getMessages(): Message[] {
    return this.engine.getHistory()
  }

  /** 消息变化钩子（cli.ts 注入 watch 跟随），引擎每次历史变化后调用 */
  set onMessagesChanged(fn: (() => void) | null) {
    this.engine.onMessagesChanged = fn
  }

  /** 停止当前正在进行的模型请求（Ctrl+X） */
  abortCurrent(): void {
    this.engine.abort()
  }

  /** 引擎只读访问(TUI 壳共享同一实例,切换会话无缝) */
  getEngine(): ChatEngine {
    return this.engine
  }

  /** 设置非交互一次性执行模式（cli.ts 的 -p 分支调用） */
  setNonInteractive(on: boolean): void {
    this.nonInteractive = on
  }

  /** 恢复既有会话到当前上下文（/session load、对端同步采纳） */
  async reloadSession(id: string): Promise<boolean> {
    return this.engine.loadSession(id)
  }

  /** 开始新会话（/session new：清空历史与记录状态） */
  startNewSession(): void {
    this.engine.startNewSession()
  }

  /** 脱离当前会话记录（/session delete 删当前会话：清记录 id 但保留历史，继续对话作为新记录保存） */
  detachSession(): void {
    this.engine.detachSession()
  }

  // ==================== 前台选择（/front 壳命令） ====================

  getFrontAgent(): string | undefined {
    return this.engine.getFrontAgent()
  }

  getFrontAgentCandidates(): AvailableSubagent[] {
    return this.engine.getFrontAgentCandidates()
  }

  setFrontAgent(type?: string): void {
    this.engine.setFrontAgent(type)
  }

  /** 前台显示信息（模板名 + 生效模型 + 来源），透传引擎单一事实源 */
  getFrontAgentDisplay() {
    return this.engine.getFrontAgentDisplay()
  }

  // ==================== 主入口 ====================

  /** 旁路事件输出（思考/工具调用/进度通知）：非交互模式改写 stderr，保证 stdout 只有助手正文；
   * TUI 活跃时不写 stdout（防污染 alt-screen；TUI 侧呈现由 tuiShell 监听负责，参照 cli.ts 的 TUI 旁路） */
  private writeEvent(text: string): void {
    if (isTuiActive()) return
    if (this.nonInteractive) process.stderr.write(text)
    else process.stdout.write(text)
  }

  /** 助手正文输出（stdout；TUI 活跃时跳过，防污染 alt-screen） */
  private writeContent(text: string): void {
    if (isTuiActive()) return
    process.stdout.write(text)
  }

  /** 流式打印器（每轮独立状态；实现见模块级 createStreamPrinter 工厂，此处注入壳侧输出通道） */
  private createStreamPrinter(): ReturnType<typeof createStreamPrinter> {
    return createStreamPrinter(
      (text) => this.writeEvent(text),
      (text) => this.writeContent(text)
    )
  }

  async chat(userInput: string, imagePaths?: string[], videoPaths?: string[], explicitAgent?: string): Promise<void> {
    // 输入侧媒体：构建 contentParts（能力过滤与历史占位符替换由引擎负责）；
    // explicitAgent：@提及点名的 agent（subagent_type），透传引擎本轮注入显式委派指令（plan 模式引擎侧不注入）
    let input: ChatEngineInput
    if (imagePaths?.length || videoPaths?.length) {
      const imageDescs = (imagePaths || []).map((p) => pathToDescriptor(p))
      const videoDescs = (videoPaths || []).map((p) => pathToDescriptor(p))
      const contentParts = await buildContentParts(userInput, imageDescs, videoDescs, cliVideoStorage)
      input = { text: userInput, contentParts, explicitAgent }
    } else {
      input = { text: userInput, explicitAgent }
    }

    // 流式打印器（[思考中]/[回复]/[工具调用] ANSI 体验，每轮独立状态）
    const { streamCallback, printToolCall, resetSgr } = this.createStreamPrinter()

    // 补打流中未出现的工具调用（引擎每执行一个工具都发 running/pending 事件；
    // 替代旧实现"响应返回后补打剩余 toolCalls"的兜底）
    const onToolCallStatus = (payload: any): void => {
      if (payload?.module !== 'chat') return
      if (payload?.toolCallStatus !== ToolCallStatus.RUNNING && payload?.toolCallStatus !== ToolCallStatus.PENDING) return
      const tc = payload.toolCall as ToolCall | undefined
      if (tc?.id) printToolCall(tc)
    }
    eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, onToolCallStatus)

    try {
      const result = await this.engine.sendMessage(input, { streamCallback })
      if (result.aborted) {
        this.writeEvent('\n[已停止]\n')
      }
    } catch (err: any) {
      // 无可用模型：保持旧版引导 UX（引擎抛出的是单行错误，这里补全 provider 列表）
      if (typeof err?.message === 'string' && err.message.includes('未检测到已配置 API Key 的模型')) {
        this.writeNoModelGuidance()
        return
      }
      throw err
    } finally {
      // abort/异常路径统一兜底 SGR 复位（正常路径已复位，此处幂等空转）
      resetSgr()
      eventBus.off(EVENTS.TOOL_CALL_STATUS_CHANGED, onToolCallStatus)
    }
  }

  /** 无可用模型时的引导（迁移自旧 resolveModelType 的提示分支） */
  private writeNoModelGuidance(): void {
    process.stdout.write('\n⚠ 未检测到已配置 API Key 的模型\n')
    process.stdout.write('请先使用 /key set <provider> <apiKey> 配置 API Key\n')
    const providers = providerManager.getAllProviders()
    if (providers.length > 0) {
      process.stdout.write('支持的 provider:\n')
      for (const p of providers) {
        process.stdout.write(`  ${p.name}\n`)
      }
    }
    process.stdout.write('\n')
  }

  // ==================== CLI 专属注入器（selfMd/status/switch/failure） ====================

  /**
   * CLI 专属条件注入器（迁移自旧 prefixMsgs 组装 :421-537；每轮组装时现读）。
   * order 复现旧插入位置：selfMd 在 pending(30) 与 AGENTS.md(40) 之间；
   * status/switch/failure 依次在 AGENTS.md 之后。
   */
  private createCliInjectors(): ContextInjector[] {
    const selfMdInjector: ContextInjector = {
      id: 'cli-self-md',
      order: 35,
      inject: () => {
        // 注入项目结构信息（.self.md）（npm 模式无源码环境，跳过）
        try {
          const projectPath = getOwnProjectPaths().projectPath
          if (projectPath !== null) {
            const selfMdPath = path.join(projectPath, '.self.md')
            const selfMdContent = fs.readFileSync(selfMdPath, 'utf-8')
            if (selfMdContent.trim()) {
              return {
                role: MessageRole.SYSTEM,
                content: `以下内容来自项目根目录的 .self.md 文件。如果你修改了项目代码，请评估是否需要更新该文件以反映项目结构或模块职责的变化；如无变化，无需更新。\n\n${selfMdContent}`,
                timestamp: new Date(),
              }
            }
          }
        } catch {
          // .self.md 不存在或读取失败，跳过
        }
        return null
      },
    }

    const statusInjector: ContextInjector = {
      id: 'cli-runtime-status',
      order: 60,
      inject: async () => {
        // 注入运行时状态（每轮 API 调用前实时读取，确保模型感知最新状态）
        const lines: string[] = ['当前运行状态：']
        lines.push(`- 模式：${this.mode}`)
        if (this.engine.isPlanMode()) {
          lines.push('- 规划模式：已开启（只读讨论，修改性工具已被系统拦截；规划完整后调用 submit_plan 提交用户批准）')
        }
        // 当前模型
        const currentModelName = SelectedModelsService.getInstance().getCurrentModelName()
        if (currentModelName) {
          const modelInfo = modelInfoService.getModelInfoByName(currentModelName)
          const caps: string[] = []
          if (modelInfo?.supportsTools) caps.push('tools')
          if (modelInfo?.supportsStreaming) caps.push('streaming')
          if (modelInfo?.supportsThinking) caps.push('thinking')
          if (modelInfo?.supportedModalities) {
            for (const m of modelInfo.supportedModalities) {
              const v = String(m).toLowerCase()
              if (v !== 'text') caps.push(v)
            }
          }
          const capStr = caps.length > 0 ? `（${modelInfo?.provider ?? ''}，支持 ${caps.join('/')})` : ''
          lines.push(`- 模型：${currentModelName}${capStr}`)
        } else {
          lines.push('- 模型：未配置')
        }
        // auto-apply
        const autoApply = this.ctx.builtInExecutor.getAutoApply()
        lines.push(`- auto-apply：${autoApply ? '已开启 — 任意路径直接写不问' : '已关闭 — 边界内直接写、边界外触发用户审批'}`)
        // auto-switch 与 switcher.js 路径（自迭代相关，npm 模式下改为注入"源码未安装"说明）
        const isNpmMode = getOwnProjectPaths().projectPath === null
        if (isNpmMode) {
          lines.push('- 源码环境：未安装（npm 模式）。用户想修改 chill 自身源码时，引导其输入 /fetch-source 开启自迭代')
        } else {
          const autoSwitch = await this.ctx.keyValueStore.getItem('autoSwitchAfterIteration')
          lines.push(`- auto-switch：${autoSwitch === 'true' ? '已开启 — 自迭代后自动切换版本' : '已关闭 — 自迭代后打开体验窗口'}`)
          // 自迭代绝对路径（供 robocopy/编译/档案读写等全流程使用，避免模型猜测或用 get_current_directory 误推）
          const { projectPath, parentDir } = getOwnProjectPaths()
          lines.push(`- chill 项目路径：${projectPath}`)
          lines.push(`- chill 项目父目录：${parentDir}`)
          lines.push(`- workcopy 路径：${path.join(parentDir, 'chill-workcopy')}`)
          lines.push(`- chill-archive 路径：${path.join(parentDir, 'chill-archive')}`)
          lines.push('  （自迭代流程中的所有路径操作一律使用以上绝对路径；工作目录是用户的启动目录，与 chill 源码位置无关）')
          // switcher.js 路径（供自迭代版本切换使用，避免模型猜测）
          const guardianPath = path.join(parentDir, 'chill-guardian', 'switcher.js')
          lines.push(`- switcher.js 路径：${guardianPath}（自迭代版本切换时使用此路径，调用 trigger_guardian 或写入 .ready-for-switch 时直接使用）`)
        }
        return {
          role: MessageRole.SYSTEM,
          content: lines.join('\n'),
          timestamp: new Date(),
        }
      },
    }

    const switchInjector: ContextInjector = {
      id: 'cli-switch-ready',
      order: 70,
      inject: () => {
        // 检测待切换状态，注入 system 消息（每次调用动态检查；npm 模式跳过）
        try {
          const { projectPath, parentDir } = getOwnProjectPaths()
          const readyForSwitchPath = projectPath !== null ? path.join(parentDir, 'chill-workcopy', '.ready-for-switch') : null
          if (readyForSwitchPath && fs.existsSync(readyForSwitchPath)) {
            const content = fs.readFileSync(readyForSwitchPath, 'utf-8')
            const lines = content.split('\n')
            const goal = lines[0] || ''
            const projectPathLine = lines.find((l) => l.startsWith('project_path='))?.split('=').slice(1).join('=') || ''
            const guardianPath = lines.find((l) => l.startsWith('guardian_path='))?.split('=').slice(1).join('=') || ''
            return {
              role: MessageRole.SYSTEM,
              content: `检测到已完成的自迭代（目标：${goal}）。如果用户要求切换到新版本，调用 trigger_guardian 工具执行版本切换，参数：guardian_path='${guardianPath}', project_path='${projectPathLine}'`,
              timestamp: new Date(),
            }
          }
        } catch {
          // 读取失败，跳过
        }
        return null
      },
    }

    const failureInjector: ContextInjector = {
      id: 'cli-switch-failure',
      order: 80,
      inject: () => {
        // 检测上次版本切换失败报告，注入 system 消息（每次调用动态检查；npm 模式跳过）
        try {
          const { projectPath, parentDir } = getOwnProjectPaths()
          const failurePath = projectPath !== null ? path.join(parentDir, 'chill-guardian', 'switch-failure.json') : null
          if (failurePath && fs.existsSync(failurePath)) {
            const f = JSON.parse(fs.readFileSync(failurePath, 'utf-8'))
            return {
              role: MessageRole.SYSTEM,
              content: `警告：上次版本切换于 ${f.time} 失败。失败步骤：${f.step}；诊断：${f.reason}；建议：${f.guidance}。请主动向用户说明失败情况并协助处理；处理后用户可重新执行 /switch-version，或调用 trigger_guardian 重试。`,
              timestamp: new Date(),
            }
          }
        } catch {
          // 读取失败，跳过
        }
        return null
      },
    }

    return [selfMdInjector, statusInjector, switchInjector, failureInjector]
  }

  // ==================== 委派进度打印 ====================

  /** Subagent 委派进度（全局 eventBus 的 SUBAGENT_* 事件，风格对齐 [工具调用]） */
  private registerSubagentPrinting(): void {
    eventBus.on(EVENTS.SUBAGENT_TASK_STARTED, (p: SubagentTaskEventPayload) => {
      // 委派默认后台化：登记后立即返回占位，主对话不阻塞（完成/失败见下方提示与回流汇报）
      this.writeEvent(`\n[委派已后台执行] ${p.subagentType}: ${p.description}（完成时将自动汇报）\n`)
    })
    eventBus.on(EVENTS.SUBAGENT_TASK_COMPLETED, (p: SubagentTaskEventPayload) => {
      const summary = (p.taskOutput?.final_output ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      this.writeEvent(`[委派完成] ${p.subagentType}: ${p.description}${summary ? ` — ${summary}` : ''}\n`)
    })
    eventBus.on(EVENTS.SUBAGENT_TASK_FAILED, (p: SubagentTaskEventPayload) => {
      const err = p.taskOutput?.error_info?.message ?? ''
      this.writeEvent(`[委派失败] ${p.subagentType}: ${p.description}${err ? ` — ${err}` : ''}\n`)
    })
  }
}
