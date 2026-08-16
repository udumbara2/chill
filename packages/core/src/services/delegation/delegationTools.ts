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
import { ORCHESTRATION_TOOL_NAMES } from '../../orchestrator/types'
import { getTaskExecutor, isTaskExecutorInitialized } from '../../orchestrator/executor/TaskExecutor'
import { eventBus, EVENTS } from '../../utils/eventBus'
import { getTaskRegistry, type RegisteredTask, type RegisteredTaskStatus, type TaskRegistry } from './taskRegistry'
import { getApprovalChannel } from '../approvals'

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
        available_tools: {
          type: 'array',
          description: '分配给 Subagent 的工具名称列表，Subagent 将使用这些工具执行任务。名称须从委派指南的可用工具清单精确照抄；不指定则默认分配全部可用工具（task 等编排工具除外）',
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
      },
      required: ['task_id', 'subagent_type', 'task_description', 'success_criteria'],
    },
  },
}

/**
 * 过滤传给 Subagent 的工具集，剔除 task 等编排工具
 * （名单单一事实源：orchestrator/types.ts ORCHESTRATION_TOOL_NAMES）
 * @param toolDefinitions - 候选工具定义列表
 * @returns 过滤后的工具定义列表
 */
export function filterSubagentTools(toolDefinitions?: ToolDefinition[]): ToolDefinition[] | undefined {
  if (!toolDefinitions) {
    return undefined
  }
  return toolDefinitions.filter(
    (tool) => !ORCHESTRATION_TOOL_NAMES.includes(tool.function?.name ?? '')
  )
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
  preDelegation(call: { toolCallId: string; args: Record<string, unknown> }): Promise<string | undefined>
  /** PostDelegation：任务 settle 后触发（注入式；output 为任务终态输出） */
  postDelegation(call: { toolCallId: string; args: Record<string, unknown>; output: TaskToolOutput }): Promise<void>
}

let delegationHookDispatcher: DelegationHookDispatcher | null = null

export function setDelegationHookDispatcher(dispatcher: DelegationHookDispatcher | null): void {
  delegationHookDispatcher = dispatcher
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
  const dispatcher = delegationHookDispatcher
  if (!dispatcher) return undefined
  try {
    return await dispatcher.preDelegation({ toolCallId: toolCall.id, args: parseTaskArgsForHooks(toolCall) })
  } catch {
    return undefined
  }
}

/** PostDelegation hook 派发（注入式；hooks 故障静默，不反向影响执行） */
async function runPostDelegationHooks(toolCall: ToolCall, output: TaskToolOutput): Promise<void> {
  const dispatcher = delegationHookDispatcher
  if (!dispatcher) return
  try {
    await dispatcher.postDelegation({ toolCallId: toolCall.id, args: parseTaskArgsForHooks(toolCall), output })
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
  subagentTools?: ToolDefinition[]
): Promise<TaskToolOutput> {
  try {
    return await getTaskExecutor().executeFromToolCall(toolCall, toolMetadata, subagentTools)
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
  const subagentTools = filterSubagentTools(ctx.toolDefinitions)

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
  const startExecution = (toolCall: ToolCall, index: number): Promise<TaskToolOutput> => {
    const execution = executeOne(toolCall, ctx.toolMetadata, subagentTools)
    execution.then(async (taskOutput) => {
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
  if (options?.sync) {
    for (const payload of payloads) {
      eventBus.emit(EVENTS.SUBAGENT_TASK_STARTED, payload)
    }
    return await Promise.all(
      toolCalls.map(async (toolCall, index) => ({
        toolCall,
        taskOutput: await startExecution(toolCall, index),
      }))
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
    })
    startExecution(toolCall, index)
    results.push({ toolCall, taskOutput: buildPlaceholderOutput(args.taskId) })
  }
  return results
}

/**
 * 单个 task 的可启动性预检（登记注册表前调用）：
 * 解析 toolCall 参数后复用 TaskExecutor.preflightDelegation
 * （模板存在 + 模型兜底链 + baseURL + API Key，与执行路径同源）。
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
  try {
    return await getTaskExecutor().preflightDelegation({
      task_id: (args.task_id as string) ?? toolCall.id,
      subagent_type: args.subagent_type,
      task_description: (args.task_description as string) ?? '',
      success_criteria: args.success_criteria as string | undefined,
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
              available_tools: {
                type: 'array',
                description: '分配给 Subagent 的工具名称列表（语义同 task；不指定则默认分配全部可用工具，编排工具除外）',
                items: {
                  type: 'string',
                  description: '工具名称',
                },
              },
              override_parameters: {
                type: 'object',
                description: '可选的参数覆盖（字段与语义同 task 的 override_parameters）',
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

/** 长文本截断（结果摘要用） */
function truncateText(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

/** 单任务的一行式状态描述（query_task_status 输出） */
function formatTaskLine(task: RegisteredTask): string {
  const elapsedSec = (((task.settledAt ?? Date.now()) - task.startedAt) / 1000).toFixed(1)
  let line =
    `- [${TASK_STATUS_TEXT[task.status]}] ${task.subagentType}` +
    `（task_id=${task.taskId}，toolCallId=${task.toolCallId}，批次=${task.batchId}，耗时=${elapsedSec}s）：${task.description}`
  if (task.status === 'completed' && task.output) {
    line += `\n  结果摘要: ${truncateText(task.output.final_output || '(空)')}`
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

/** batch_task 的 tasks 数组成员形态 */
export interface BatchTaskItemInput {
  subagent_type?: string
  task_description?: string
  success_criteria?: string
  available_tools?: string[]
  override_parameters?: Record<string, unknown>
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
          available_tools: task.available_tools,
          override_parameters: task.override_parameters,
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
  const subagentTools = filterSubagentTools(ctx.toolDefinitions)
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

  memberCalls.forEach((call, index) => {
    registry.register({
      taskId: call.id,
      toolCallId: call.id,
      subagentType: tasks[index].subagent_type!,
      description: tasks[index].task_description!,
      batchId,
      batchRootToolCallId: toolCallId,
    })
    const execution = executeOne(call, ctx.toolMetadata, subagentTools)
    execution.then((taskOutput) => {
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
      '全部完成后会收到通知，届时请整合结果答复用户；在收到通知前不要假设任务已有结果。',
  }
}
