/**
 * 任务清单跟踪器（活动区挂载 + 落地留痕入引擎历史）
 *
 * 任务列表是随时间变化的状态对象，不是事件日志：
 * - 活跃期：快照经 tuiState 的 todoPresenter 推到 TUI 活动区原位刷新（历史区零噪音）；
 * - 落地（全部 completed/failed，或被新列表创建取代）：最终态全量文本经 landRecorder
 *   写入引擎历史（synthetic:'todoLanding'；TUI/CLI/-p 模式无关），显示由历史重建派生
 *   （单一显示通道，不写事件行），TUI 活动区同时撤除；
 * - 会话切换（/session load/new）：clearTodoList 清空跟踪器与活动区（不留痕）。
 *
 * 严格成员制：任务只在 TASK_LIST_CREATED/TASK_ADDED 时获得成员资格；未知 id 的更新/删除
 * 不补登——同进程同步发射下掉项不可能，补登只会把落地后的迟到更新重建成单任务碎块
 * （并再次落地污染历史）。未知 id 更新在 CLI 回退下打紧凑单行留信息，TUI 下忽略。
 *
 * 独立成模块而非内联 cli.ts：cli.ts 是副作用入口不可被测试导入，
 * 本模块纯逻辑可无头验证。CLI 回退文本经返回值交给 cli.ts 的 notify 打印
 * （notify 已分流：-p 模式落 stderr，交互 CLI 落 stdout）。
 */
import { isTuiActive, presentTodo, type TodoLine } from './tui/tuiState.js'

/** 任务状态（与 core builtInToolExecutor 的 validStatuses 一致） */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

interface TodoTask {
  content: string
  status: TodoStatus
}

/** 当前清单（Map 保插入序）；空 = 无活跃清单 */
const tasks = new Map<string, TodoTask>()

/** 落地留痕记录器（cli.ts 注册 → 引擎 appendSyntheticMessage；TUI/CLI/-p 模式无关均记录） */
let landRecorder: ((text: string) => void) | null = null

/** 注册落地留痕记录器（入参为最终态全量清单文本） */
export function setTodoLandRecorder(fn: (text: string) => void): void {
  landRecorder = fn
}

const isTerminal = (s: TodoStatus): boolean => s === 'completed' || s === 'failed'

/** 进度计数：已落地（completed/failed）/ 总数 */
function progress(): { done: number; total: number } {
  let done = 0
  for (const t of tasks.values()) if (isTerminal(t.status)) done++
  return { done, total: tasks.size }
}

/** 状态图标（win10 安全字形；禁用 ☐/☑ 缺字字符） */
const STATUS_ICON: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '●',
  pending: '○',
  failed: '✗',
}

/** 清单快照 → 显示行（header 进度行 + 任务行；纯文本不含 id，着色归呈现层） */
export function buildTodoLines(): TodoLine[] {
  const { done, total } = progress()
  const lines: TodoLine[] = [{ text: `[任务列表] ${done}/${total}`, status: 'header' }]
  for (const t of tasks.values()) {
    lines.push({ text: `  ${STATUS_ICON[t.status]} ${t.content}`, status: t.status })
  }
  return lines
}

/** 全量清单文本（落地留痕与 CLI 回退共用同一份；首尾空行包裹，与既有输出形态一致） */
function fullListText(): string {
  return '\n' + buildTodoLines().map((l) => l.text).join('\n') + '\n'
}

/** 活跃期原位刷新；返回 false 表示无 TUI 活动区（调用方走 CLI 回退打印） */
function presentActive(): boolean {
  return isTuiActive() && presentTodo(buildTodoLines())
}

/**
 * 落地：清单非空时 先取全量文本 → recorder 留痕（模式无关）→ TUI 撤除活动区 → 清状态。
 * 返回 CLI 回退用的全量清单文本（TUI 下为 null，落地块由引擎历史重建呈现）
 */
function land(): string | null {
  if (tasks.size === 0) return null
  const text = fullListText()
  landRecorder?.(text)
  if (isTuiActive()) presentTodo(null)
  tasks.clear()
  return isTuiActive() ? null : text
}

/** 会话切换清空（/session load/new）：跟踪器与活动区一并清空，不留痕 */
export function clearTodoList(): void {
  tasks.clear()
  if (isTuiActive()) presentTodo(null)
}

/** /tui 重进重放：活跃清单快照重新推活动区（presenter 注册后调用一次；无活跃清单则空转） */
export function resyncTodo(): void {
  if (tasks.size > 0) presentActive()
}

/** 紧凑单行（CLI 回退的更新/增删提示）：`  ✓ 任务内容（3/10）`；无活跃清单（total=0）则无计数 */
function compactLine(icon: string, text: string): string {
  const { done, total } = progress()
  return total > 0 ? `  ${icon} ${text}（${done}/${total}）\n` : `  ${icon} ${text}\n`
}

// ===== 事件入口（cli.ts 的 4 个 TASK_* 处理器委托于此） =====
// 返回值：需走 CLI 回退打印的文本；TUI 通道已推送时为 null（调用方不打印）

/** 列表创建：新列表取代旧列表时旧清单最终态先落地留痕；调用方须保证 list 非空 */
export function onTaskListCreated(
  list: Array<{ id?: string; task_id?: string; content?: string; description?: string }>
): string | null {
  const landed = land()
  for (const t of list) {
    tasks.set(t.id || t.task_id || '', { content: t.content || t.description || '', status: 'pending' })
  }
  const created = tasks.size > 0 ? fullListText() : null
  if (tasks.size > 0 && presentActive()) return landed
  // CLI 回退：旧清单全量与新清单全量依次输出（均可能为 null）
  const out = (landed ?? '') + (created ?? '')
  return out === '' ? null : out
}

/** 状态更新：全部落地（completed/failed）时整单落地留痕 */
export function onTaskStatusUpdated(taskId: string, status: TodoStatus, content?: string): string | null {
  const task = tasks.get(taskId)
  if (!task) {
    // 未知 id（落地后的迟到更新/从未登记的补发）：严格成员制不补登；
    // CLI 打紧凑单行留信息（无活跃清单故无计数），TUI 忽略
    if (isTuiActive()) return null
    return compactLine(STATUS_ICON[status], content || '')
  }
  task.status = status
  if (content) task.content = content
  const allTerminal = [...tasks.values()].every((t) => isTerminal(t.status))
  if (allTerminal) return land()
  if (presentActive()) return null
  return compactLine(STATUS_ICON[status], task.content)
}

/** 任务删除：删空撤除活动区（不留痕）；剩余全部落地则整单落地 */
export function onTaskDeleted(taskId: string): string | null {
  const task = tasks.get(taskId)
  // 未知 id：载荷只有 taskId 无 content，打印只会产出空内容行——直接忽略
  if (!task) return null
  const content = task.content
  tasks.delete(taskId)
  if (tasks.size === 0) {
    if (isTuiActive()) {
      presentTodo(null)
      return null
    }
    return compactLine('✕', `${content} 已删除`)
  }
  const allTerminal = [...tasks.values()].every((t) => isTerminal(t.status))
  if (allTerminal) return land()
  if (presentActive()) return null
  return compactLine('✕', `${content} 已删除`)
}

/** 任务添加（新任务恒为 pending，不触发落地） */
export function onTaskAdded(taskId: string, content: string): string | null {
  tasks.set(taskId, { content, status: 'pending' })
  if (presentActive()) return null
  return compactLine('＋', content)
}
