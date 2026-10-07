/**
 * 任务注册表（委派异步化：进程内单例）
 *
 * 主键 toolCallId（toolCall.id，唯一）；模型给的 task_id 作别名（query/cancel 两个键都接受）。
 * batchId：同轮多 task、同次 batch_task 共享一个；单独委派的任务各自独立成批。
 * 批次齐否判定：批内全部任务落地（completed/failed/cancelled；超时按 failed 记入）才视为
 * "该批可汇报"，整批进待汇报队列；不同批次互不等待。
 * 主动取消不单独进待汇报（cancel_task 的工具结果已告知模型），但计入批次齐否判定。
 *
 * 进程内状态，不做持久化（进程退出即失效；历史里遗留的 RUNNING 占位由引擎启动时清扫）。
 */

import { TaskExecutionStatus, type TaskToolOutput } from '../../orchestrator/types'
import type { IsolatedEnvironment } from '../../orchestrator/isolation/types'

/** 注册任务状态（running 之外都算落地） */
export type RegisteredTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** 注册表条目 */
export interface RegisteredTask {
  /** 模型给的别名（task_id 参数；缺省回退 toolCallId） */
  taskId: string
  /** 注册表主键（toolCall.id） */
  toolCallId: string
  /** Subagent 类型标识符 */
  subagentType: string
  /** 任务描述 */
  description: string
  /** 批次标识（同轮多 task / 同次 batch_task 共享；单任务独立成批） */
  batchId: string
  /**
   * 批次占位根 toolCallId（仅 batch_task 成员设置）：成员无独立占位消息，
   * settle/取消时的占位写回以批次占位（根 id 对应的那条 TOOL 消息）为单位
   */
  batchRootToolCallId?: string
  status: RegisteredTaskStatus
  /** 终态输出（completed/failed 落地时写入） */
  output?: TaskToolOutput
  /** 登记时间（ms） */
  startedAt: number
  /** 落地时间（ms） */
  settledAt?: number
  /** M7 增量 2：settle 时回流/冻结的看板条目 id（完成通知据此点名"重派请带 board_item_id"；无回流不设） */
  boardReflow?: string[]
  /** resume 链：本任务由 resume_task 对 parentToolCallId 的追问产生（展示用） */
  parentToolCallId?: string
  /**
   * 发起引擎的 SessionScope 句柄（2.3 Worker 归属路由）：登记时从 __origin.handle 拷贝。
   * 后台 worker 的 hook 派发/事件归因按 task→engineHandle→scope 解析；老任务/无归因缺省
   * undefined = 回退 legacy 单槽（行为逐位不变）。
   */
  engineHandle?: string
}

/**
 * resume 留存的执行上下文（resume_task 的种子与复跑参数）：
 * 每次成功执行后刷新，追问链可持续。
 */
export interface TaskTranscript {
  /** 完整对话 transcript（含 system），Worker 种子消息 */
  messages: unknown[]
  subagentType: string
  taskDescription: string
  successCriteria?: string
  availableTools?: string[]
  overrideParameters?: Record<string, unknown>
  requireReview?: boolean
  /** 团队成员钉住:LRU 剪枝跳过(团队存续期间成员上下文不蒸发;归档时解钉回归 LRU) */
  pinned?: boolean
  /** 所属团队 runId(钉住归属;resume 续员判定用) */
  teamId?: string
  /** 成员名(resume 续员判定用;撞名派生后的实际名字) */
  memberName?: string
  /** 计划批准门:阶段 1 为只读规划任务(approve_plan 的"非 plan 任务"校验依据;resumeArgs 重建时携带) */
  requirePlan?: boolean
  /** 计划批准门:委托时 Lead 指定的原始工具集(undefined=模板默认;approve_plan 批准时据此扩容,从根任务 transcript 读) */
  planOriginalTools?: string[]
}

/** transcript 留存上限（LRU，超量淘汰最久未刷新者） */
const MAX_RETAINED_TRANSCRIPTS = 10

export class TaskRegistry {
  private tasks = new Map<string, RegisteredTask>()
  /** 待汇报队列（入队 = 整批 batchId，出队 = drain） */
  private pendingReportBatches: string[] = []
  /** Worker 环境映射：执行器内部 taskId → IsolatedEnvironment（cancel_task 的 destroy 通道） */
  private environments = new Map<string, IsolatedEnvironment>()
  /** Worker 环境的 agent 记忆目录映射：绑定键 → memoryDir（__origin.memoryDir 注入源；仅声明 memory 的任务登记） */
  private environmentMemoryDirs = new Map<string, string>()
  /** Worker 环境的 agent 知识库绑定映射：绑定键 → 绑定库名单（__origin.knowledgeBases 注入源；仅声明 knowledge 的任务登记） */
  private environmentKnowledgeBases = new Map<string, string[]>()
  /** steer 中途指示队列：绑定键 → 待下发消息（宿主网关随 TOOL_CALL_RESPONSE 捎带下发） */
  private environmentSteerQueues = new Map<string, string[]>()
  /** resume transcript 区：绑定键 → 执行上下文（LRU 10 条；Map 插入序即 LRU 序，刷新时重插提位） */
  private transcripts = new Map<string, TaskTranscript>()
  private batchSeq = 0

  /** 生成新批次 id（一次 toolCall 批次取一个共享） */
  newBatchId(): string {
    this.batchSeq += 1
    return `batch-${Date.now()}-${this.batchSeq}`
  }

  /** 登记任务（初始状态 running） */
  register(entry: Omit<RegisteredTask, 'status' | 'startedAt'>): RegisteredTask {
    const task: RegisteredTask = { ...entry, status: 'running', startedAt: Date.now() }
    this.tasks.set(task.toolCallId, task)
    return task
  }

  /** 按主键查询 */
  getByToolCallId(toolCallId: string): RegisteredTask | undefined {
    return this.tasks.get(toolCallId)
  }

  /**
   * 是否 batch_task 批次占位根 id：根自身不登记为任务（成员以派生 id 登记、
   * 根 id 存于成员的 batchRootToolCallId），引擎写回批次占位/触发回流时按此识别
   */
  isBatchRoot(toolCallId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.batchRootToolCallId === toolCallId) return true
    }
    return false
  }

  /** 按模型别名查询 */
  getByTaskId(taskId: string): RegisteredTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.taskId === taskId) return task
    }
    return undefined
  }

  /** 全部任务（登记顺序） */
  list(): RegisteredTask[] {
    return Array.from(this.tasks.values())
  }

  /** 进行中的任务 */
  listRunning(): RegisteredTask[] {
    return this.list().filter((t) => t.status === 'running')
  }

  /** 同批任务 */
  getBatchTasks(batchId: string): RegisteredTask[] {
    return this.list().filter((t) => t.batchId === batchId)
  }

  /** 批次齐否判定：批内全部任务落地（取消/失败/超时都算落地） */
  isBatchSettled(batchId: string): boolean {
    const batch = this.getBatchTasks(batchId)
    return batch.length > 0 && batch.every((t) => t.status !== 'running')
  }

  /**
   * 标记终态（按 output.status 归 completed/failed，超时计入 failed；重复 settle 忽略）。
   * 落地后若所属批次全部落地，整批入待汇报队列（去重）。
   */
  markSettled(toolCallId: string, output: TaskToolOutput): void {
    const task = this.tasks.get(toolCallId)
    if (!task || task.status !== 'running') return
    task.output = output
    task.status = output.status === TaskExecutionStatus.COMPLETED ? 'completed' : 'failed'
    task.settledAt = Date.now()
    this.enqueueBatchIfSettled(task.batchId)
  }

  /**
   * M7 增量 2：登记 settle 时回流/冻结的看板条目（完成通知据此给出"重派请带 board_item_id"的写法）。
   * 与 markSettled 解耦：settle 桥在通知前落地，条目可能已终态（重复 settle 被忽略）也照记。
   */
  markBoardReflow(toolCallId: string, itemIds: string[]): void {
    const task = this.tasks.get(toolCallId)
    if (!task || itemIds.length === 0) return
    task.boardReflow = itemIds
  }

  /**
   * 标记取消。取消计入批次齐否判定（批内其余任务全部落地后整批仍正常汇报），
   * 但主动取消不单独进待汇报（cancel_task 的工具结果已告知模型）。
   */
  markCancelled(toolCallId: string): void {
    const task = this.tasks.get(toolCallId)
    if (!task || task.status !== 'running') return
    task.status = 'cancelled'
    task.settledAt = Date.now()
    this.enqueueBatchIfSettled(task.batchId)
    // 计划批准门:任务取消时清理打回计数(计数不随取消残留)
    this.clearPlanRounds(toolCallId)
  }

  /** 批次落地后入待汇报队列（去重；批内需至少一个非取消的落地任务才汇报） */
  private enqueueBatchIfSettled(batchId: string): void {
    if (!this.isBatchSettled(batchId)) return
    const batch = this.getBatchTasks(batchId)
    if (!batch.some((t) => t.status === 'completed' || t.status === 'failed')) return
    if (!this.pendingReportBatches.includes(batchId)) {
      this.pendingReportBatches.push(batchId)
    }
  }

  /** 待汇报队列 drain：取出并清空当前全部已齐批次（每元素为一批的任务列表） */
  drainPendingReports(): RegisteredTask[][] {
    const drained = this.pendingReportBatches.map((batchId) => this.getBatchTasks(batchId))
    this.pendingReportBatches = []
    return drained
  }

  /**
   * 已取出的批次放回待汇报队列头部（去重、保持原顺序）：
   * 回流轮被 abort/失败收尾时不立即再报，留到下一个自然触发点（下一任务落地或下轮正常结束）。
   */
  requeueReportBatches(batchIds: string[]): void {
    if (batchIds.length === 0) return
    this.pendingReportBatches = [
      ...batchIds,
      ...this.pendingReportBatches.filter((id) => !batchIds.includes(id)),
    ]
  }

  // ---------- 成员上报队列(escalate_to_lead;与待汇报批次语义不同,队列独立、骨架同款) ----------

  /** 成员上报(Worker 执行中途的请示;非阻塞,drain 骨架送达 Lead 执行上下文) */
  private pendingEscalations: Array<{
    subagentType: string
    taskId?: string
    message: string
    suggestion?: string
  }> = []

  /** 上报入队(escalate_to_lead 宿主执行入口) */
  enqueueEscalation(entry: { subagentType: string; taskId?: string; message: string; suggestion?: string }): void {
    this.pendingEscalations.push(entry)
  }

  /** 上报队列 drain:取出并清空当前全部上报 */
  drainEscalations(): Array<{ subagentType: string; taskId?: string; message: string; suggestion?: string }> {
    const drained = this.pendingEscalations
    this.pendingEscalations = []
    return drained
  }

  /** 已取出的上报放回队列头部(drain 轮失败/被 abort 时,留到下一个自然触发点) */
  requeueEscalations(entries: Array<{ subagentType: string; taskId?: string; message: string; suggestion?: string }>): void {
    if (entries.length === 0) return
    this.pendingEscalations = [...entries, ...this.pendingEscalations]
  }

  // ---------------- 团队消息 → Lead 队列(pendingEscalations 同款生命周期;drainPendingReports 第三段) ----------------

  private pendingTeamMessages: Array<{ from: string; content: string; at: number }> = []

  /** 团队消息入队(send_message target='lead' 宿主执行入口) */
  enqueueTeamMessage(entry: { from: string; content: string; at: number }): void {
    this.pendingTeamMessages.push(entry)
  }

  /** 团队消息队列 drain:取出并清空 */
  drainTeamMessages(): Array<{ from: string; content: string; at: number }> {
    const drained = this.pendingTeamMessages
    this.pendingTeamMessages = []
    return drained
  }

  /** 已取出的团队消息放回队列头部(drain 轮失败/被 abort 时) */
  requeueTeamMessages(entries: Array<{ from: string; content: string; at: number }>): void {
    if (entries.length === 0) return
    this.pendingTeamMessages = [...entries, ...this.pendingTeamMessages]
  }

  // ---------------- 计划批准门:打回轮次计数(approve_plan;approve/markCancelled 时清理) ----------------

  private planRounds = new Map<string, number>()

  /** 打回轮数+1,返回最新轮数(key = 根任务 id,approve_plan 经 parentToolCallId 链归并) */
  incrementPlanRound(rootToolCallId: string): number {
    const n = (this.planRounds.get(rootToolCallId) ?? 0) + 1
    this.planRounds.set(rootToolCallId, n)
    return n
  }

  /** 清除打回计数(批准或任务取消时) */
  clearPlanRounds(rootToolCallId: string): void {
    this.planRounds.delete(rootToolCallId)
  }

  /** Worker 环境绑定（StandardSubagentExecutor 上抛钩子：sendRequest await 前登记）；resources 为委派时一次解析的 agent 资源（记忆目录/知识库绑定名单，未声明不传） */
  bindEnvironment(
    taskId: string,
    environment: IsolatedEnvironment,
    resources?: { memoryDir?: string; knowledgeBases?: string[] }
  ): void {
    this.environments.set(taskId, environment)
    if (resources?.memoryDir) this.environmentMemoryDirs.set(taskId, resources.memoryDir)
    if (resources?.knowledgeBases?.length) this.environmentKnowledgeBases.set(taskId, resources.knowledgeBases)
  }

  /** Worker 环境解绑（settle 时清项；steer 队列一并清理） */
  unbindEnvironment(taskId: string): void {
    this.environments.delete(taskId)
    this.environmentMemoryDirs.delete(taskId)
    this.environmentKnowledgeBases.delete(taskId)
    this.environmentSteerQueues.delete(taskId)
  }

  /**
   * steer 中途指示入队（steer_task 工具入口）。
   * @returns true=已入队(环境在跑);false=任务不在跑或无环境绑定
   */
  enqueueSteer(bindKey: string, message: string): boolean {
    if (!this.environments.has(bindKey)) return false
    const queue = this.environmentSteerQueues.get(bindKey) ?? []
    queue.push(message)
    this.environmentSteerQueues.set(bindKey, queue)
    return true
  }

  /** 按 envId 出队全部 steer 消息（宿主网关随 TOOL_CALL_RESPONSE 捎带用;经既有 getEnvironmentKeyByEnvId 反查绑定键） */
  drainSteerByEnvId(envId: string): string[] {
    const bindKey = this.getEnvironmentKeyByEnvId(envId)
    if (!bindKey) return []
    const queue = this.environmentSteerQueues.get(bindKey)
    if (!queue || queue.length === 0) return []
    this.environmentSteerQueues.delete(bindKey)
    return queue
  }

  /** 按绑定键查 agent 记忆目录（__origin.memoryDir 注入用；未声明返回 undefined） */
  getEnvironmentMemoryDir(taskId: string): string | undefined {
    return this.environmentMemoryDirs.get(taskId)
  }

  /** 按绑定键查 agent 知识库绑定名单（__origin.knowledgeBases 注入用；未声明返回 undefined） */
  getEnvironmentKnowledgeBases(taskId: string): string[] | undefined {
    return this.environmentKnowledgeBases.get(taskId)
  }

  /** 按执行器内部 taskId 查 Worker 环境（cancel_task destroy 用） */
  getEnvironment(taskId: string): IsolatedEnvironment | undefined {
    return this.environments.get(taskId)
  }

  /**
   * 留存执行上下文（delegation 层 settle 处理点调用：任务成功且 Worker 带回 conversation 时）。
   * 每次成功执行都刷新（重插提位到 LRU 最新端）；超上限淘汰最久未刷新者。
   * 与任务注册解耦——-p 同步路径不注册条目，transcript 照存（同进程后续 resume_task 可用）。
   */
  retainTranscript(bindKey: string, record: TaskTranscript): void {
    this.transcripts.delete(bindKey)
    this.transcripts.set(bindKey, record)
    while (this.transcripts.size > MAX_RETAINED_TRANSCRIPTS) {
      // 团队成员钉住:跳过 pinned,淘汰最久未钉住者;全部钉住则停止(宁超上限不丢成员上下文,归档时解钉回归)
      const oldestUnpinned = [...this.transcripts.keys()].find((k) => !this.transcripts.get(k)?.pinned)
      if (oldestUnpinned === undefined) break
      this.transcripts.delete(oldestUnpinned)
    }
  }

  /** 团队归档时解除该队成员的钉住(回归 LRU 自然淘汰;团队档案已落盘) */
  unpinTeamTranscripts(teamId: string): void {
    for (const record of this.transcripts.values()) {
      if (record.teamId === teamId) record.pinned = false
    }
  }

  /** 按绑定键（toolCallId）或模型别名（task_id）查 transcript；无则 undefined */
  getTranscript(key: string): TaskTranscript | undefined {
    const direct = this.transcripts.get(key)
    if (direct) return direct
    const entry = this.getByTaskId(key)
    return entry ? this.transcripts.get(entry.toolCallId) : undefined
  }

  /**
   * 按 Worker 环境 id 反查绑定键（toolCall.id）：
   * ForkManager 网关从 envId 推导任务归属（__origin 注入）用，复用同一绑定 Map 反查、不另建映射
   */
  getEnvironmentKeyByEnvId(envId: string): string | undefined {
    for (const [key, environment] of this.environments) {
      if (environment.id === envId) return key
    }
    return undefined
  }
}

/**
 * 全局任务注册表单例
 */
let globalTaskRegistry: TaskRegistry | null = null

export function getTaskRegistry(): TaskRegistry {
  if (!globalTaskRegistry) {
    globalTaskRegistry = new TaskRegistry()
  }
  return globalTaskRegistry
}

/** 重置全局注册表（主要用于测试） */
export function resetTaskRegistry(): void {
  globalTaskRegistry = null
}
