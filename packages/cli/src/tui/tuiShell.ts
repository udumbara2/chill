/**
 * TUI 显示壳（T5）：进入/退出 alt-screen 全屏界面，对话循环与审批提问的 TUI 接线
 *
 * 进入：setTuiActive → rl.pause → \x1b[?1049h → 动态加载 ink/react/TuiApp →
 * 装载历史 → 注册 ask/print 呈现者 → 订阅引擎消息变化 → render。
 * 退出（/cli）：unmount → 清注册 → \x1b[?1049l → 历史写回 scrollback →
 * setTuiActive(false) → 按来源回程（rl.resume 或 startRepl）。
 * 可重入：alt-screen 恢复与注册清理均幂等。
 */
import type * as readline from 'node:readline'
import { format } from 'node:util'
import type { ChatEngine, StreamCallback } from '@assistant-ai/core'
import { MessageRole, SelectedModelsService, getTemplateManager, parseAgentMentions, parseBareAgentMention, eventBus, EVENTS, modelInfoService, getTaskRegistry, type SubagentTaskEventPayload } from '@assistant-ai/core'
import { MessageModel, messageContentToText, summarizeToolArgs, userDisplayText } from './messageModel.js'
import { InputHistory } from './inputHistory.js'
import {
  setTuiActive,
  registerAskPresenter,
  registerPrintPresenter,
  registerTodoPresenter,
  presentDispatch,
  type AskOption,
} from './tuiState.js'
import { resyncTodo } from '../todoTracker.js'
import { isInteractiveCommand, isKnownCommand } from './commandMenu.js'
import { probeTerminalWidths } from './widthProbe.js'

/** enterTui 依赖的 chatService 最小形状（CliChatService 结构子集） */
export interface TuiChatService {
  /** T6 在 CliChatService 上提供的引擎 getter */
  getEngine(): ChatEngine
}

export interface EnterTuiOpts {
  /** CLI 的 readline（进入时 pause，回程时 resume） */
  rl: readline.Interface
  /** REPL 尚未启动时的首次启动入口（/tui 作为首命令的场景） */
  startRepl: () => void
  /** REPL 是否已在运行（决定回程方式） */
  replStarted: boolean
  /** TUI 直进时分流的启动欢迎内容（banner/入口提示/约束通知，含 ANSI）：
   *  消息区初始行原生渲染 + 退出时补打回主屏 scrollback；/tui 命令再进入时不传 */
  startupLines?: string
}

const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'
/** 鼠标上报：VT200 + SGR 扩展坐标（滚轮以 \x1b[<64/65;列;行M 序列送达 stdin）。
 *  开启后终端内文本选择需按住 Shift 拖选（行业惯例，Claude Code 同） */
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'

let altScreenActive = false
let exitHooksArmed = false

/** 进程退出前的 SessionEnd hooks 触发器（enterTui 注入引擎 endSession；
 *  SIGINT/SIGTERM 兜底退出前 await——cli.ts 的 SIGINT 清理是异步链，
 *  会被此处同步 process.exit 抢占，故 TUI 活跃期的 SessionEnd 由本通道保证） */
let sessionEndBeforeExit: (() => Promise<void>) | null = null

/** 启动欢迎内容的退出补打（一次性）：TUI 直进时 banner 未上主屏（已数据化分流），
 *  /cli 退回与进程退出兜底共用此处补回 scrollback 顶部（与今日"启动即打印"平价） */
let startupExitEcho: string | null = null
function echoStartupLines(): void {
  if (startupExitEcho === null) return
  const text = startupExitEcho
  startupExitEcho = null
  if (text) process.stdout.write(text)
}

/** 输入历史：模块级单例，TUI 多次进出（/cli ↔ /tui）间保留 */
const inputHistory = new InputHistory()

/** 恢复主屏（幂等，进程退出兜底也走这里）；鼠标上报一并关闭 */
function leaveAltScreen(): void {
  if (!altScreenActive) return
  altScreenActive = false
  process.stdout.write(MOUSE_OFF + ALT_SCREEN_OFF)
}

function enterAltScreen(): void {
  process.stdout.write(ALT_SCREEN_ON + MOUSE_ON)
  altScreenActive = true
  // 进程退出/SIGINT/SIGTERM 兜底恢复主屏，避免用户终端卡在 alt-screen
  if (exitHooksArmed) return
  exitHooksArmed = true
  process.on('exit', leaveAltScreen)
  // 启动欢迎内容补打：注册序在 leaveAltScreen 之后 → 落在主屏（覆盖 /exit、崩溃等不经 exitTui 的路径）
  process.on('exit', echoStartupLines)
  const onFatalSignal = (): void => {
    leaveAltScreen()
    // SessionEnd hooks（core 侧共享 1.5s 预算、幂等）落定后再退出；未注入时直接退
    void (sessionEndBeforeExit?.() ?? Promise.resolve())
      .catch(() => {})
      .then(() => process.exit(130))
  }
  process.once('SIGINT', onFatalSignal)
  process.once('SIGTERM', onFatalSignal)
}

/** 提问回答的归一化：编号 → 选项标签；标签文本（忽略大小写）→ 标签；其余原样返回 */
function resolveAskAnswer(text: string, options: AskOption[] | undefined, allowFreeText: boolean): string {
  const trimmed = text.trim()
  // 自由文本 ask 的 Esc 取消 → 空串（core 跳过分支）；非自由文本 ask 保持 esc 原样（各调用方自理，零回归）
  if (allowFreeText && trimmed.toLowerCase() === 'esc') return ''
  if (options && options.length > 0) {
    const n = Number.parseInt(trimmed, 10)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].label
    const hit = options.find((op) => op.label.toLowerCase() === trimmed.toLowerCase())
    if (hit) return hit.label
    if (!allowFreeText && trimmed === '') return options[0].label
  }
  return trimmed
}

/** 退出 TUI 时把会话历史以纯文本写回终端 scrollback（Cmd+f / tmux copy mode 可检索）；
 *  导出供无头验证（tmp/verify-todo.mts） */
export function writeHistoryToScrollback(engine: ChatEngine): void {
  const toolNameById = new Map<string, string>()
  const out: string[] = []
  for (const msg of engine.getHistory()) {
    if (msg.role === MessageRole.ASSISTANT && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id) toolNameById.set(tc.id, tc.function.name)
      }
    }
    if (msg.role === MessageRole.SYSTEM) continue
    if (msg.role === MessageRole.USER) {
      if (msg.synthetic === 'todoLanding') {
        // 任务清单落地留痕：全量原文写回（用户侧最终态记录，可回溯；数据层标记，不猜字符串）
        out.push(messageContentToText(msg.content))
      } else if (msg.synthetic === 'goalTick') {
        // 目标模式推进消息：与 TUI 显示同款折叠摘要（数据层标记，不猜字符串）
        const firstLine = messageContentToText(msg.content).split('\n')[0] ?? ''
        out.push(`【目标推进】${firstLine.replace(/^【[^】]*】/, '').trim() || '目标未达成，自动续跑'}`)
      } else if (msg.synthetic) {
        // 合成编排消息（回流轮通知）：与 TUI 显示同款折叠摘要（数据层标记，不猜字符串）
        const n = (messageContentToText(msg.content).match(/^- \[/gm) || []).length
        out.push(`【后台任务完成通知】${n} 项任务已落地，结果已写回工具消息`)
      } else {
        out.push(userDisplayText(messageContentToText(msg.content)))
      }
    } else if (msg.role === MessageRole.ASSISTANT) {
      const text = messageContentToText(msg.content)
      if (text.trim()) out.push(text)
    } else if (msg.role === MessageRole.TOOL && msg.toolCallStatus) {
      out.push(`[工具] ${toolNameById.get(msg.toolCallId ?? '') ?? 'unknown'}`)
    }
  }
  if (out.length > 0) process.stdout.write(out.join('\n') + '\n')
}

/**
 * 进入 TUI 全屏界面；返回的 Promise 在退出 TUI（/cli）后 resolve。
 * 任一环节失败：清理标志与 alt-screen、按来源回程并打印原因（降级不丢会话）。
 */
export async function enterTui(chatService: TuiChatService, opts: EnterTuiOpts): Promise<void> {
  const { rl, startRepl, replStarted } = opts
  const engine = chatService.getEngine()
  // SessionEnd hooks 退出触发器（阶段 4）：TUI 活跃期 SIGINT/SIGTERM 兜底退出前由 onFatalSignal await；
  // 防御性判存——core 未落位时保持 null，退出零阻塞
  sessionEndBeforeExit = async () => {
    const e = engine as unknown as { endSession?: () => Promise<void> }
    if (typeof e.endSession === 'function') await e.endSession()
  }
  const model = new MessageModel()
  // 启动欢迎内容（TUI 直进时由 cli.ts 数据化分流）：消息区初始行原生渲染
  // （eventLines 锚点 0——置顶于 :201 loadHistory 恢复的历史之上）+ 退出补打留存
  startupExitEcho = opts.startupLines || null
  if (opts.startupLines) model.addRawLines(opts.startupLines)

  // ---- console 接管（输出归通道）----
  // Ink 的 patchConsole 已关（renderOptions）：其 writeToStdout 对任何 console 输出
  // 整帧擦写（全屏闪烁根因）。TUI 期间 console.* 一律路由进消息区提示行（增量渲染）。
  // 洪泛防御（append-only 兼容）：连续相同文本只显示首条、重复数在恢复时补记一行；
  // 每秒超 CONSOLE_RATE_LIMIT 条的部分丢弃、窗口结算时补记折叠行。
  // 包装内严禁调用 console.*（防递归——直调 model，天然安全）。
  const CONSOLE_RATE_LIMIT = 20
  const savedConsole = {
    log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error,
  }
  let consoleLastText: string | null = null
  let consoleRepeatCount = 0
  let consoleWindowStart = Date.now()
  let consoleWindowCount = 0
  let consoleDropped = 0
  const routeConsole = (isError: boolean, args: unknown[]): void => {
    const text = format(...args)
    const now = Date.now()
    if (now - consoleWindowStart >= 1000) {
      // 窗口结算：补记重复与折叠计数后重置
      if (consoleRepeatCount > 0) { model.addNotice(`（上一条已重复 ${consoleRepeatCount} 次）`); consoleRepeatCount = 0 }
      if (consoleDropped > 0) { model.addNotice(`（已折叠 ${consoleDropped} 条 console 输出）`); consoleDropped = 0 }
      consoleWindowStart = now
      consoleWindowCount = 0
    }
    if (text === consoleLastText) { consoleRepeatCount++; return }
    if (consoleRepeatCount > 0) { model.addNotice(`（上一条已重复 ${consoleRepeatCount} 次）`); consoleRepeatCount = 0 }
    consoleLastText = text
    if (consoleWindowCount >= CONSOLE_RATE_LIMIT) { consoleDropped++; return }
    consoleWindowCount++
    if (isError) model.addError(text)
    else model.addNotice(text)
  }
  console.log = (...args: unknown[]) => routeConsole(false, args)
  console.info = (...args: unknown[]) => routeConsole(false, args)
  console.debug = (...args: unknown[]) => routeConsole(false, args)
  console.warn = (...args: unknown[]) => routeConsole(false, args)
  console.error = (...args: unknown[]) => routeConsole(true, args)
  /** 恢复原 console（exitTui 与启动失败兜底共用，幂等） */
  let consoleRestored = false
  const restoreConsole = (): void => {
    if (consoleRestored) return
    consoleRestored = true
    console.log = savedConsole.log
    console.info = savedConsole.info
    console.debug = savedConsole.debug
    console.warn = savedConsole.warn
    console.error = savedConsole.error
  }

  /** 回程：REPL 已在运行则恢复 readline，否则走首次启动 */
  const backToRepl = (): void => {
    if (replStarted) rl.resume()
    else startRepl()
  }

  setTuiActive(true)
  rl.pause()

  // 版本切换成功标志：与 CLI 模式同逻辑（cli.ts pendingSwitchExit），本轮对话结束后退出旧窗口
  let tuiPendingSwitchExit = false
  const switchHandler = (): void => { tuiPendingSwitchExit = true }
  eventBus.on('chill:switch-succeeded', switchHandler)
  // readline 的回显走 stdin 的 'keypress' 监听（rl.pause() 挡不住——emitKeypressEvents 的
  // 'data' 流仍在，首个字符就触发 _refreshLine 把提示符+整行写到屏幕）。进入 TUI 时摘除全部
  // keypress 监听（readline 自身 + cli.ts 全局粘贴/中断处理），退出时恢复；
  // Ink 走 'readable' 模式读输入，不受影响（与 handleModel 选择器同款对策）。
  const savedKeypressListeners = process.stdin.listeners('keypress')
  process.stdin.removeAllListeners('keypress')
  const restoreKeypressListeners = (): void => {
    for (const l of savedKeypressListeners) process.stdin.on('keypress', l as (...args: any[]) => void)
  }

  // 鼠标滚轮 → 滚动：包装 stdin.read，在 Ink 之前剥离 SGR 鼠标序列
  // （Ink 经 readable+read() 读输入，看不到被剥掉的序列，输入框不留乱码）。
  // 按钮 64=滚轮上、65=滚轮下，每格 3 视觉行；点击等其他按钮序列一并剥离丢弃。
  // CPR 应答（\x1b[{r};{c}R，宽度探测的迟到应答或终端主动上报）一并剥离——
  // Ink 的 use-input 对未识别带修饰位的 CSI 会崩（keypress.name=undefined），不可达。
  const MOUSE_SEQ = /\x1b\[<(\d+);\d+;\d+[Mm]/g
  const CPR_SEQ = /\x1b\[\d+;\d+R/g
  const MOUSE_TAIL = /\x1b\[<?[\d;]*$/
  const rawStdinRead = process.stdin.read.bind(process.stdin)
  let mouseTail = ''
  const wrappedRead = (size?: number): unknown => {
    const chunk = rawStdinRead(size)
    if (typeof chunk !== 'string') return chunk
    let data = mouseTail + chunk
    mouseTail = ''
    data = data.replace(CPR_SEQ, '')
    data = data.replace(MOUSE_SEQ, (_m, btn: string) => {
      // 查看器打开时滚轮路由到查看器滚动，否则走主窗口滚动
      if (btn === '64') {
        if (model.viewerOpen) model.viewerScroll(-3)
        else model.scrollUp(3)
      } else if (btn === '65') {
        if (model.viewerOpen) model.viewerScroll(3)
        else model.scrollDown(3)
      }
      return ''
    })
    // 不完整序列留存尾部，与下一块拼接
    const tail = MOUSE_TAIL.exec(data)
    if (tail) {
      mouseTail = tail[0]
      data = data.slice(0, data.length - mouseTail.length)
    }
    return data
  }
  process.stdin.read = wrappedRead as typeof process.stdin.read
  const restoreStdinRead = (): void => {
    process.stdin.read = rawStdinRead as typeof process.stdin.read
  }

  /** SUBAGENT_TASK_* 监听摘除（try 内注册后赋值；exitTui 与启动失败兜底共用，幂等） */
  let removeSubagentListeners: () => void = () => {}
  /** TUI 接管前的常驻输出 handler（回流轮通道；exitTui/兜底恢复用，外层声明因 catch 在 try 外） */
  let prevExternalHandler: ReturnType<ChatEngine['getExternalOutputHandler']>

  // ---- 原子进入（DEC 2026 同步帧）：从 shell 提示符直接呈现完整 TUI，零中间帧 ----
  // 旧顺序是"进 alt-screen（黑屏）→ 懒加载/宽度探测 → 首帧"，黑屏窗口=加载+探测耗时，肉眼可见。
  // 现在先持 BSU 冻结呈现，在主屏上完成全部准备（懒加载、探测、接线），就绪后才切屏渲染：
  // 终端呈现的下一帧就是完整 TUI——黑屏从未上屏。不支持 2026 的终端视 BSU/ESU 为无操作，
  // 探测自身仍有 conceal+同批擦除兜底（退化为旧体验，无功能影响）；tmux 破坏 2026 原子性，跳过。
  // closeSync 幂等，三条闭合路径：Ink 首帧落屏 / 异常兜底（catch）/ 超时安全阀。
  const rawStdoutWrite = process.stdout.write.bind(process.stdout)
  let syncOpen = false
  let syncTimer: ReturnType<typeof setTimeout> | null = null
  const closeSync = (): void => {
    if (!syncOpen) return
    syncOpen = false
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
    rawStdoutWrite('\x1b[?2026l')
  }

  try {
    if (!process.env.TMUX) {
      rawStdoutWrite('\x1b[?2026h')
      syncOpen = true
      // 安全阀：首帧始终未落也不把终端留在冻结呈现（超时强制闭合，呈现届时已有的内容）
      syncTimer = setTimeout(closeSync, 1500)
      syncTimer.unref?.()
    }
    // ink/react/TuiApp 动态加载（tuiState 之外的 TUI 代码全在懒加载 chunk 中）;
    // CPR 宽度实测与加载并发——全程在同步帧内、主屏上进行（探测行所在行为空行，擦除无损），
    // 外层已持同步帧故 wrapSync:false（嵌套 ESU 会提前解除外层帧）
    const [ink, reactNs, { TuiApp }] = await Promise.all([
      import('ink'),
      import('react'),
      import('./TuiApp.js'),
      probeTerminalWidths({ wrapSync: false }),
    ])
    // esbuild 打包 CJS react 时,动态 import 得到的是命名空间,真正的 React 在 .default 上
    const React = (reactNs as any).default ?? reactNs

    model.setCompactions(engine.getSessionState().compactions)
    model.loadHistory(engine.getHistory())

    // ---- / 命令捕获执行：复用 CLI 命令处理器（handleReplInput），输出收集进消息区 ----
    // 捕获期间模型静音（mute），防"Ink 渲染写 stdout → 被捕获 → notice → 再渲染"回流；
    // askPresenter 提问时暂停捕获并解除静音（否则提问不可见、回答无门，假死）。
    let commandRunning = false
    let capturing = false
    let captureBuf: string[] = []
    const rawStderrWrite = process.stderr.write.bind(process.stderr)

    const captureInto = (chunk: unknown, ...rest: unknown[]): boolean => {
      captureBuf.push(typeof chunk === 'string' ? chunk : String(chunk))
      const cb = rest.find((a) => typeof a === 'function') as (() => void) | undefined
      cb?.()
      return true
    }

    const startCapture = (): void => {
      captureBuf = []
      capturing = true
      // 只补丁 stdout/stderr 拦命令文本输出；模型不静音——Ink 走专属写通道（见 inkStdout），
      // 帧永远直达真实屏幕，不进捕获缓冲，回流循环与账本脱节在结构上不可能
      process.stdout.write = captureInto as typeof process.stdout.write
      process.stderr.write = captureInto as typeof process.stderr.write
    }

    /** 恢复 stdout/stderr，供 stopCapture 与提问暂停共用 */
    const restoreWrites = (): void => {
      process.stdout.write = rawStdoutWrite
      process.stderr.write = rawStderrWrite
      capturing = false
    }

    const pauseCaptureForAsk = (): void => {
      restoreWrites()
    }

    const resumeCaptureAfterAsk = (): void => {
      capturing = true
      process.stdout.write = captureInto as typeof process.stdout.write
      process.stderr.write = captureInto as typeof process.stderr.write
    }

    /** ANSI/控制序列剥离（捕获缓冲 → 纯文本行进消息区） */
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')

    /** 捕获缓冲 → notice 行（模型仍在静音时不触发渲染，由后续 unmute 一帧带出） */
    const flushCapture = (): void => {
      const out = stripAnsi(captureBuf.join(''))
      captureBuf = []
      for (const line of out.split('\n')) {
        if (line.trim()) model.addNotice(line.replace(/\s+$/, ''))
      }
    }

    // 版本切换/命令进度（/switch-version、/compact 等长耗时命令）：实时显示进度。
    // Ink 走专属写通道（见 inkStdout），帧永不进捕获缓冲——进度只需进模型即随正常帧实时上屏，
    // 无需任何捕获暂停/裸写技巧（裸写绕开 Ink 帧所有权曾是残影/串色/菜单残帧的根因）
    const commandProgressHandler = (msg: string): void => {
      model.addNotice(msg)
    }
    eventBus.on('chill:switch-progress', commandProgressHandler)
    eventBus.on('chill:command-progress', commandProgressHandler)

    const dispatchSlashCommand = async (text: string): Promise<void> => {
      commandRunning = true
      // 必须先打补丁再调用：presentDispatch 调用即执行，handleReplInput 的同步段
      // （含命令输出的 process.stdout.write）会立刻运行，晚补丁则同步输出逃逸捕获
      startCapture()
      try {
        const dispatch = presentDispatch(text)
        if (!dispatch) {
          model.addNotice('命令处理器未注册，请 /cli 后使用')
          return
        }
        await dispatch
        // 提问挂起时先等回答:handleReplInput 并不 await 部分交互命令(/rollback、/model、
        // /restore 等),dispatch 会先返回而提问仍挂起——若此时 finally 恢复写入,
        // 回答后的 resumeCaptureAfterAsk 会把 stdout 重新补丁为 captureInto,
        // 无人再恢复(输出被吞、界面假死的根因)
        while (askResolver !== null) {
          await new Promise((r) => setTimeout(r, 50))
        }
      } catch (err) {
        model.addError(err instanceof Error ? err.message : String(err))
      } finally {
        restoreWrites()
        flushCapture()
        commandRunning = false
        // 版本切换已成功（手动 /switch-version 路径）→ 复用 auto-switch 的 exitTui 退出
        if (tuiPendingSwitchExit) {
          model.addNotice('版本切换已完成，5 秒后退出（历史记录可向上翻阅）...')
          setTimeout(() => {
            exitTui()
            process.stdout.write('\n版本切换已完成，程序已退出（历史记录可向上翻阅）。\n')
            process.exit(0)
          }, 5000)
        }
      }
    }

    // ---- 提问/打印呈现者：core 与审批通道经 tuiState 与 TUI 解耦 ----
    let askResolver: ((answer: string) => void) | null = null
    let askOptions: AskOption[] | undefined
    let askFreeText = true
    let askFreeTextHint: string | undefined
    registerAskPresenter((question, options, allowFreeText, freeTextHint) => {
      askOptions = options
      askFreeText = allowFreeText ?? true
      askFreeTextHint = freeTextHint
      // 捕获执行 / 命令期间收到提问：暂停捕获并恢复渲染，否则提问不可见形成假死
      const resumeAfter = capturing
      if (resumeAfter) pauseCaptureForAsk()
      // 单键应答态(选项全为单字符且禁自由文本):不打印编号列表(y/n/Esc 单键作答,
      // 编号用不到),选项提示以内联 [y]说明 形式呈现——问题行未内联的选项自动补上,
      // 已内联的不重复(编辑确认等调用方问题行已自含提示);列表模式保留编号供键入
      const singleKey =
        !!options &&
        options.length > 0 &&
        !(allowFreeText ?? true) &&
        options.every((op) => Array.from(op.label).length === 1)
      if (singleKey) {
        const missing = options.filter((op) => !question.includes(`[${op.label}]`))
        const hint = missing.map((op) => `[${op.label}]${op.description ?? ''}`).join(' ')
        model.addNotice(hint ? `${question} ${hint}` : question)
      } else {
        // 选项类提问(非单键):只打印问题——选项由 TuiApp 的交互选择菜单呈现
        // (↑↓ 移动、回车确认、Esc 取消;键入编号/文本同样可答,不再打印静态编号列表)
        model.addNotice(question)
      }
      return new Promise<string>((resolve) => {
        askResolver = (answer) => {
          if (resumeAfter) resumeCaptureAfterAsk()
          resolve(answer)
        }
      })
    })
    registerPrintPresenter((text) => model.addNotice(text))
    // 任务清单呈现者：活跃期快照进活动区（原位刷新，历史区零噪音）；lines=null 为撤除
    // （落地/删空/会话切换）。落地块不走此通道——最终态经 recorder 入引擎历史，
    // 由 onMessagesChanged → rebuildCommitted 呈现（单一显示通道，无双显）
    registerTodoPresenter((lines) => model.setTodoLines(lines))
    // /tui 重进重放：注册后即有活跃清单则立即恢复活动区（setTuiActive(true) 早于注册，不会空转）
    resyncTodo()

    // 引擎历史变化（确认写回、会话重载、后台任务写回与回流轮等）→ 重建已提交显示行；保留 cli.ts 已挂的监听器
    const prevOnMessagesChanged = engine.onMessagesChanged
    engine.onMessagesChanged = () => {
      prevOnMessagesChanged?.()
      // 压缩 checkpoint 随历史同重建（/compact、对端 watch 采纳、/session load 均经此通道刷新标记条）
      model.setCompactions(engine.getSessionState().compactions)
      model.rebuildCommitted(engine.getHistory())
      // 回流轮边界惰性置假：drain 结束（isRunning 转假）后的首个 rebuild 生效；
      // 此前 inTurn=true 但锚点补偿计数恒为 0（计数器随 rebuild 从历史现算），行为与置假严格等价
      if (!engine.getSessionState().isRunning) model.inTurn = false
    }

    // ---- 流式接线：思考/正文进 inflight，工具调用提交标记行 ----
    const printedToolCallIds = new Set<string>()
    const streamCallback: StreamCallback = (chunk) => {
      if (chunk.reasoningContent) model.appendThinking(chunk.reasoningContent)
      if (chunk.content) model.appendContent(chunk.content)
      if (chunk.toolCalls) {
        for (const tc of chunk.toolCalls) {
          if (tc.id && printedToolCallIds.has(tc.id)) continue
          if (tc.id) printedToolCallIds.add(tc.id)
          // 关键参数摘要（行业形态：同名调用凭参数可区分）；流式中途 arguments 可能不完整，
          // 摘要器正则回退兜底，历史重建时会以完整 arguments 原位补全
          const argsSummary = summarizeToolArgs(tc.function?.arguments ?? '')
          model.addToolCall(tc.function.name, argsSummary)
        }
      }
    }

    // ---- 后台委派任务通知（T5：SUBAGENT_TASK_* → 消息区 notice 行） ----
    // 回流轮呈现：引擎回流轮经上方 setExternalOutputHandler 注册的同路由 handler 逐字流入 inflight，
    // 落史后经 notifyMessagesChanged → rebuildCommitted 原位替换（与普通轮次同一条流式管线）
    // 活跃任务表：STARTED 入表、settle（COMPLETED/FAILED/取消同路径）出表并给 notice 附耗时；
    // 状态栏「后台: N (最长 Xs)」段的数据源。秒表由 1s 定时器驱动 poke 重绘，表空即停（零开销）。
    const activeTasks = new Map<string, { label: string; startedAt: number }>()
    let bgTimer: ReturnType<typeof setInterval> | null = null
    const stopBgTimer = (): void => {
      if (bgTimer) { clearInterval(bgTimer); bgTimer = null }
    }
    const startBgTimer = (): void => {
      if (bgTimer) return
      bgTimer = setInterval(() => model.poke(), 1000)
      bgTimer.unref() // 不阻止进程退出
    }
    const trackStarted = (taskId: string, label: string, startedAt: number): void => {
      activeTasks.set(taskId, { label, startedAt })
      startBgTimer()
      model.poke() // 状态栏段同帧出现
    }
    const trackSettled = (taskId: string): number | null => {
      const t = activeTasks.get(taskId)
      if (!t) return null // 迟到 settle（已取消/已出表）：不追加耗时，保持现状语义
      activeTasks.delete(taskId)
      if (activeTasks.size === 0) stopBgTimer()
      return Math.max(0, Math.round((Date.now() - t.startedAt) / 1000))
    }
    const subagentTaskLabel = (p: SubagentTaskEventPayload): string =>
      (p.description || p.taskId).replace(/\s+/g, ' ').trim()
    const onSubagentTaskStarted = (p: SubagentTaskEventPayload): void => {
      trackStarted(p.taskId, subagentTaskLabel(p), Date.now())
      model.addNotice(`[委派] ${p.subagentType} 已后台执行: ${subagentTaskLabel(p)}`)
    }
    const onSubagentTaskCompleted = (p: SubagentTaskEventPayload): void => {
      const secs = trackSettled(p.taskId)
      model.addNotice(`[委派] ${p.subagentType} 已完成: ${subagentTaskLabel(p)}${secs !== null ? `（耗时 ${secs}s）` : ''}`)
    }
    const onSubagentTaskFailed = (p: SubagentTaskEventPayload): void => {
      const secs = trackSettled(p.taskId)
      const reason = p.taskOutput?.error_info?.message
      model.addNotice(`[委派] ${p.subagentType} 失败: ${reason || subagentTaskLabel(p)}${secs !== null ? `（耗时 ${secs}s）` : ''}`)
    }
    eventBus.on(EVENTS.SUBAGENT_TASK_STARTED, onSubagentTaskStarted)
    eventBus.on(EVENTS.SUBAGENT_TASK_COMPLETED, onSubagentTaskCompleted)
    eventBus.on(EVENTS.SUBAGENT_TASK_FAILED, onSubagentTaskFailed)
    removeSubagentListeners = () => {
      eventBus.off(EVENTS.SUBAGENT_TASK_STARTED, onSubagentTaskStarted)
      eventBus.off(EVENTS.SUBAGENT_TASK_COMPLETED, onSubagentTaskCompleted)
      eventBus.off(EVENTS.SUBAGENT_TASK_FAILED, onSubagentTaskFailed)
      activeTasks.clear()
      stopBgTimer()
    }
    // 进 TUI 时同步在跑任务：/cli↔/tui 切换或重进后表被清过，但任务真在跑——
    // 不同步则状态栏「隐身」直到 settle。startedAt 取注册表登记时间（taskRegistry.startedAt）
    for (const t of getTaskRegistry().listRunning()) {
      activeTasks.set(t.toolCallId, { label: (t.description || t.taskId).replace(/\s+/g, ' ').trim(), startedAt: t.startedAt })
    }
    if (activeTasks.size > 0) startBgTimer()

    // ---- 对话循环：组件 onSubmit 驱动 ----
    let turnStartedAt = 0

    // ---- 回流轮（引擎发起轮）流式通道 ----
    // 接管常驻输出 handler：chunk 路由与用户轮 streamCallback 完全一致（复用同一闭包，防两份逻辑漂移）；
    // 首个 chunk 推断轮次边界（inTurn/turnStartedAt）。轮末由 rebuildCommitted 清 inflight 原位替换；
    // inTurn 在 drain 结束后的首个 rebuild 惰性置假（见下方 onMessagesChanged）。exitTui/兜底恢复原 handler。
    prevExternalHandler = engine.getExternalOutputHandler()
    engine.setExternalOutputHandler((chunk) => {
      if (!model.inTurn) {
        model.inTurn = true
        turnStartedAt = Date.now()
      }
      streamCallback(chunk)
    })

    const runTurn = async (text: string): Promise<void> => {
      printedToolCallIds.clear()
      turnStartedAt = Date.now()
      // @ agent 提及解析：仅精确命中模板（内置/个人/项目/远程全量）才点名，不匹配按普通文本（现状）
      const availableTypes = new Set(getTemplateManager().getAllTemplates().map((t) => t.subagent_type))
      const { explicitAgent } = parseAgentMentions(text, availableTypes)
      try {
        model.inTurn = true
        const result = await engine.sendMessage({ text, explicitAgent }, { streamCallback })
        model.commitInflight()
        if (result.aborted) model.addNotice('[已停止]')
      } catch (err) {
        model.commitInflight()
        model.addError(err instanceof Error ? err.message : String(err))
      } finally {
        model.inTurn = false
        // 版本切换已成功且本轮对话（告别语）完成 → 先退出 TUI（历史写回 scrollback），再彻底退出进程（窗口保留）
        if (tuiPendingSwitchExit) {
          setTimeout(() => {
            exitTui()
            process.stdout.write('\n版本切换已完成，程序已退出（历史记录可向上翻阅）。\n')
            process.exit(0)
          }, 5000)
        }
      }
    }

    const onSubmit = (text: string): void => {
      // 提问等待中：输入先路由给 askPresenter
      if (askResolver) {
        const resolve = askResolver
        const options = askOptions
        const freeText = askFreeText
        askResolver = null
        resolve(resolveAskAnswer(text, options, freeText))
        return
      }
      const trimmed = text.trim()
      // / 命令：复用 CLI 命令处理器（捕获执行）；/cli 由 TuiApp 直接处理不进这里
      if (trimmed.startsWith('/')) {
        if (commandRunning || engine.getSessionState().isRunning) {
          model.addNotice('当前有任务进行中，请稍候')
          return
        }
        if (trimmed === '/tui') {
          model.addNotice('当前已在 TUI 显示（/cli 退回命令行）')
          return
        }
        if (!isKnownCommand(trimmed)) {
          model.addNotice(`未知命令: ${trimmed}（输入 /help 查看命令列表）`)
          return
        }
        if (isInteractiveCommand(trimmed)) {
          model.addNotice(`该命令为交互式命令，请 /cli 后使用: ${trimmed}`)
          return
        }
        void dispatchSlashCommand(trimmed)
        return
      }
      if (commandRunning) {
        model.addNotice('命令执行中，请稍候')
        return
      }
      if (engine.getSessionState().isRunning) {
        model.addNotice('生成进行中，请稍候（Ctrl+X 中断）')
        return
      }
      // 裸 @agent 提及（只喊名字不带任务）= 切换前台直聊：走 /front 命令通道
      //（捕获执行 CLI handler，提示文案复用），不发起模型轮；带内容则维持委派
      const bareAgent = parseBareAgentMention(
        trimmed,
        new Set(getTemplateManager().getAllTemplates().map((t) => t.subagent_type))
      )
      if (bareAgent) {
        void dispatchSlashCommand(`/front ${bareAgent}`)
        return
      }
      model.addUserMessage(text)
      void runTurn(text)
    }

    // ---- 退出（/cli）：清理幂等，可多次 /tui 重入 ----
    let exitResolve: () => void = () => {}
    const exited = new Promise<void>((resolve) => {
      exitResolve = resolve
    })
    let exitDone = false
    const exitTui = (): void => {
      if (exitDone) return
      exitDone = true
      // 防御：命令捕获执行中直接 /cli 退出时，先恢复 stdout（否则写回 scrollback 的历史会被捕获吞掉）
      restoreWrites()
      app.unmount()
      // Ink 的 unmount 清理会关闭 raw mode（stdin.setRawMode(false)），
      // 而 readline 依赖 raw mode 才能触发 keypress 事件。
      // 显式重新启用，否则 /model list 等交互式命令的键盘选择会失效。
      if (process.stdin.isTTY) process.stdin.setRawMode(true)
      restoreKeypressListeners()
      restoreStdinRead()
      registerAskPresenter(null)
      registerPrintPresenter(null)
      registerTodoPresenter(null)
      removeSubagentListeners()
      restoreConsole()
      engine.setExternalOutputHandler(prevExternalHandler)
      eventBus.off('chill:switch-succeeded', switchHandler)
      eventBus.off('chill:switch-progress', commandProgressHandler)
      eventBus.off('chill:command-progress', commandProgressHandler)
      engine.onMessagesChanged = prevOnMessagesChanged
      leaveAltScreen()
      // 启动欢迎内容补打回 scrollback 顶部（先于历史写回，时序=今日"启动即打印"）
      echoStartupLines()
      writeHistoryToScrollback(engine)
      setTuiActive(false)
      backToRepl()
      exitResolve()
    }

    const statusProvider = (): {
      modelName: string
      frontAgent?: string
      planMode: boolean
      goalMode?: { roundCount: number; maxRounds: number }
      running: boolean
      turnStartedAt: number
      contextStatus: { usedTokens: number; maxContextTokens?: number } | null
      background?: { count: number; longestSec: number }
    } => {
      const state = engine.getSessionState()
      const currentModelName = SelectedModelsService.getInstance().getCurrentModelName() ?? '未配置'
      // 前台直聊时模型槽显示**生效模型**（模板 model 优先），前台槽显示名称+来源标注——
      // 数据源自引擎 getFrontAgentDisplay（与执行同一判定，单一事实源）
      const frontDisplay = engine.getFrontAgentDisplay()
      const effectiveModelName = frontDisplay?.model ?? currentModelName
      // 状态栏显示 displayName（缺省回退注册名），内部比较仍用注册名
      const currentModelInfo = effectiveModelName !== '未配置' ? modelInfoService.getModelInfoByName(effectiveModelName) : undefined
      let longestStartedAt = 0
      for (const t of activeTasks.values()) {
        if (longestStartedAt === 0 || t.startedAt < longestStartedAt) longestStartedAt = t.startedAt
      }
      return {
        modelName: currentModelInfo?.displayName || effectiveModelName,
        frontAgent: frontDisplay
          ? `${frontDisplay.name}${frontDisplay.modelSource === 'template' ? '（模板指定）' : ''}`
          : state.frontAgent,
        planMode: state.planMode,
        goalMode: state.goalMode
          ? { roundCount: state.goalMode.roundCount, maxRounds: state.goalMode.maxRounds }
          : undefined,
        running: state.isRunning,
        turnStartedAt,
        contextStatus: engine.getContextStatus(),
        background: activeTasks.size > 0
          ? { count: activeTasks.size, longestSec: Math.max(0, Math.floor((Date.now() - longestStartedAt) / 1000)) }
          : undefined,
      }
    }

    // CHILL_TUI_FULL_REPAINT=1：全帧重绘（增量渲染在某些终端上残留单元格时使用）
    // inkStdout：Ink 专属写通道——write 永久绑定捕获前的真实写，其余经原型委托 process.stdout。
    // 命令捕获只补丁 process.stdout.write 拦命令文本；Ink 帧经此通道永远直达真实屏幕：
    // 帧不进捕获缓冲（否则 flush 成黄色 notice=原文变黄）、渲染账本与物理屏幕不脱节
    // （否则增量 diff 落空=菜单/输入行残帧）、渲染→捕获→notice→渲染的回流循环结构上不可能
    // 全部准备就绪：此刻才切 alt-screen——在同步帧内，黑屏不会被呈现
    enterAltScreen()
    const inkStdout = Object.create(process.stdout) as typeof process.stdout
    // 首帧落屏即闭合同步帧（之后每次 write 走 rawStdoutWrite 直写，语义与原先一致）
    inkStdout.write = ((...args: Parameters<typeof rawStdoutWrite>) => {
      const ret = rawStdoutWrite(...args)
      closeSync()
      return ret
    }) as typeof process.stdout.write
    const renderOptions = {
      stdout: inkStdout,
      // console 由本模块接管路由进消息区（见 enterTui 顶部）；Ink 的 console 拦截
      // 对任何 console 输出整帧擦写（全屏闪烁根因），必须关闭
      patchConsole: false,
      ...(process.env.CHILL_TUI_FULL_REPAINT === '1' ? {} : { incrementalRendering: true as const }),
    }
    const app = ink.render(
      React.createElement(TuiApp, {
        model,
        history: inputHistory,
        onSubmit,
        onExitCli: exitTui,
        onAbort: () => engine.abort(),
        statusProvider,
        askState: () => ({
          pending: askResolver !== null,
          options: askOptions,
          allowFreeText: askFreeText,
          freeTextHint: askFreeTextHint,
        }),
        onResizeSettled: () => {
          // 边界全量再同步:尺寸不连续点之后,增量渲染的三处状态都必须归零——
          // ① 挂起中的节流写作废(防过期帧在清屏后落笔);
          // ② log-update 行账(previousLines)清零 → 恢复帧全量重写;
          // ③ ink.js 输出账(lastOutput/lastOutputHeight)清零,防其与行账错位累积;
          // 再 CSI 2J+H 清屏(conhost 重排残留的鬼影行一并清掉)
          const inkApp = app as unknown as {
            throttledOnRender?: { cancel?: () => void }
            throttledLog?: { cancel?: () => void }
            log?: { clear?: () => void }
            lastOutput?: string
            lastOutputHeight?: number
          }
          inkApp.throttledOnRender?.cancel?.()
          inkApp.throttledLog?.cancel?.()
          inkApp.log?.clear?.()
          inkApp.lastOutput = ''
          inkApp.lastOutputHeight = 0
          process.stdout.write('\x1b[2J\x1b[H')
        },
      }),
      renderOptions
    )
    // 显式重置 stdin 读取管线(根因修复):首次 TUI 退出在读周期中途拆卸,会把
    // _readableState.reading 卡死,二次进入时 Ink 的 readable 不触发、read() 也进不了
    // _read(/cli ↔ /tui 往返输入失效);同步 resume→pause 强制重置 flowing/reading
    // 簿记(复现实验 R2 验证有效;同步块内无事件循环间隙,缓冲数据不会经 'data' 流失)
    process.stdin.resume()
    process.stdin.pause()

    await exited
  } catch (err) {
    // 异常兜底：清标志/恢复主屏/按来源回程，打印原因后降级到 CLI
    closeSync() // 先闭合同步帧：否则后续恢复序列与提示文本都被冻结不呈现
    restoreKeypressListeners()
    restoreStdinRead()
    registerAskPresenter(null)
    registerPrintPresenter(null)
    registerTodoPresenter(null)
    removeSubagentListeners()
    restoreConsole()
    engine.setExternalOutputHandler(prevExternalHandler)
    leaveAltScreen()
    setTuiActive(false)
    backToRepl()
    process.stdout.write(`[TUI] 启动失败，已回退到命令行模式: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
