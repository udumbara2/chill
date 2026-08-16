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
}

export class TaskRegistry {
  private tasks = new Map<string, RegisteredTask>()
  /** 待汇报队列（入队 = 整批 batchId，出队 = drain） */
  private pendingReportBatches: string[] = []
  /** Worker 环境映射：执行器内部 taskId → IsolatedEnvironment（cancel_task 的 destroy 通道） */
  private environments = new Map<string, IsolatedEnvironment>()
  /** Worker 环境的 agent 记忆目录映射：绑定键 → memoryDir（__origin.memoryDir 注入源；仅声明 memory 的任务登记） */
  private environmentMemoryDirs = new Map<string, string>()
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
   * 标记取消。取消计入批次齐否判定（批内其余任务全部落地后整批仍正常汇报），
   * 但主动取消不单独进待汇报（cancel_task 的工具结果已告知模型）。
   */
  markCancelled(toolCallId: string): void {
    const task = this.tasks.get(toolCallId)
    if (!task || task.status !== 'running') return
    task.status = 'cancelled'
    task.settledAt = Date.now()
    this.enqueueBatchIfSettled(task.batchId)
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

  /** Worker 环境绑定（StandardSubagentExecutor 上抛钩子：sendRequest await 前登记）；memoryDir 为委派时一次解析的 agent 记忆目录（未声明 memory 不传） */
  bindEnvironment(taskId: string, environment: IsolatedEnvironment, memoryDir?: string): void {
    this.environments.set(taskId, environment)
    if (memoryDir) this.environmentMemoryDirs.set(taskId, memoryDir)
  }

  /** Worker 环境解绑（settle 时清项） */
  unbindEnvironment(taskId: string): void {
    this.environments.delete(taskId)
    this.environmentMemoryDirs.delete(taskId)
  }

  /** 按绑定键查 agent 记忆目录（__origin.memoryDir 注入用；未声明返回 undefined） */
  getEnvironmentMemoryDir(taskId: string): string | undefined {
    return this.environmentMemoryDirs.get(taskId)
  }

  /** 按执行器内部 taskId 查 Worker 环境（cancel_task destroy 用） */
  getEnvironment(taskId: string): IsolatedEnvironment | undefined {
    return this.environments.get(taskId)
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
