/**
 * TUI 全局状态（零依赖，可被 cli.ts 静态 import）
 *
 * ink/react 均为 tuiShell 动态加载，本模块不得引入任何依赖（含 core 类型），
 * 保证 cli.ts 启动路径零成本。提问/打印呈现者由 tuiShell 进入 TUI 时注册、
 * 离开时清空，core 与各命令经此与 TUI 显示层解耦。
 */

/** 提问选项（编号展示，用户可回编号或标签文本） */
export interface AskOption {
  label: string
  description?: string
}

/** 提问呈现者：渲染问题与选项，resolve 用户选择的文本；freeTextHint 为自由文本提示文案（提问方携带） */
export type AskPresenter = (
  question: string,
  options?: AskOption[],
  allowFreeText?: boolean,
  freeTextHint?: string
) => Promise<string>

/** 打印呈现者：把一行提示文本呈现到 TUI 消息区 */
export type PrintPresenter = (text: string) => void

let tuiActive = false
let askPresenter: AskPresenter | null = null
let printPresenter: PrintPresenter | null = null

/** TUI 激活标记（core 据此选择呈现通道） */
export function setTuiActive(on: boolean): void {
  tuiActive = on
}

export function isTuiActive(): boolean {
  return tuiActive
}

/** 注册/清空提问呈现者（tuiShell 进入时注册、离开时置 null） */
export function registerAskPresenter(fn: AskPresenter | null): void {
  askPresenter = fn
}

export function hasAskPresenter(): boolean {
  return askPresenter !== null
}

/** 经 TUI 提问；未注册时返回 undefined，调用方回退到 readline 提问 */
export function presentAsk(
  question: string,
  options?: AskOption[],
  allowFreeText?: boolean,
  freeTextHint?: string
): Promise<string> | undefined {
  return askPresenter ? askPresenter(question, options, allowFreeText, freeTextHint) : undefined
}

/** 注册/清空打印呈现者 */
export function registerPrintPresenter(fn: PrintPresenter | null): void {
  printPresenter = fn
}

/** 经 TUI 打印提示；未注册时返回 false，调用方回退到 stdout 打印 */
export function presentPrint(text: string): boolean {
  if (!printPresenter) return false
  printPresenter(text)
  return true
}

/** 任务清单行（status 供呈现层着色；text 为纯文本不含 ANSI、不含 id；'header' 为进度头行） */
export interface TodoLine {
  text: string
  status: 'header' | 'pending' | 'in_progress' | 'completed' | 'failed'
}

/** 任务清单呈现者：lines 为当前快照（null=撤除活动区）；
 *  落地留痕不走此通道——最终态经引擎历史重建呈现（单一显示通道） */
export type TodoPresenter = (lines: TodoLine[] | null) => void

let todoPresenter: TodoPresenter | null = null

/** 注册/清空任务清单呈现者（tuiShell 进入时注册、离开时置 null） */
export function registerTodoPresenter(fn: TodoPresenter | null): void {
  todoPresenter = fn
}

/** 经 TUI 呈现任务清单；未注册时返回 false，调用方回退到 CLI 打印 */
export function presentTodo(lines: TodoLine[] | null): boolean {
  if (!todoPresenter) return false
  todoPresenter(lines)
  return true
}

/** 命令分发器：TUI 内执行 / 命令时调用，由 cli.ts 注册（REPL 行处理器） */
export type CommandDispatcher = (input: string) => Promise<void>

let commandDispatcher: CommandDispatcher | null = null

/** 注册/清空命令分发器（cli.ts 顶层注册一次） */
export function registerCommandDispatcher(fn: CommandDispatcher | null): void {
  commandDispatcher = fn
}

/** 经分发器执行命令；未注册时返回 undefined，调用方提示回 CLI 使用 */
export function presentDispatch(input: string): Promise<void> | undefined {
  return commandDispatcher ? commandDispatcher(input) : undefined
}

/** 粘贴提供者：TUI 内 Ctrl+V 时调用，由 cli.ts 注册（readClipboard） */
export type PasteProvider = () => string

let pasteProvider: PasteProvider | null = null

/** 注册/清空粘贴提供者（cli.ts 顶层注册一次） */
export function registerPasteProvider(fn: PasteProvider | null): void {
  pasteProvider = fn
}

/** 经提供者读剪贴板；未注册或读取失败返回空串 */
export function presentPaste(): string {
  return pasteProvider ? pasteProvider() : ''
}
