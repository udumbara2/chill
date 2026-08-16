/**
 * Worker MCP 工具的 hooks 派发通道（阶段 4：Worker MCP 覆盖收口）
 *
 * Worker 的 MCP 工具调用经 IPC 抵达宿主网关（TemplateSubagentForkManager.handleToolCallRequest
 * 的 mcp 分支）——咽喉在宿主进程内，因此 hooks 可以过宿主管线：网关注入来源标记
 * （origin 随 hook 载荷透传，不进工具入参——args 原样发往外部 MCP server，注入 __origin
 * 保留字段会污染协议；builtin 分支的 __origin 由宿主 executor 消费，MCP 侧无此消费者），
 * 经本通道派发 PreToolUse/PostToolUse。与主会话挂点（executeOneToolCall）来源互斥、无双触发。
 *
 * 注册：CLI 由 ChatEngine 构造时注册（网关与引擎同进程，直连 HookRunner）；
 * electron 的网关在主进程、HookRunner 在渲染进程，需壳层在主进程另行注册
 * （未注册时网关跳过 hooks，行为与此前一致）。
 */

import type { ApprovalOrigin } from '../approvals'

/** 网关 → 引擎的一次 hook 派发请求 */
export interface WorkerMcpHookCall {
  toolName: string
  toolInput?: Record<string, unknown>
  /** PostToolUse：工具执行结果 */
  toolResponse?: unknown
  /** Worker 侧的工具调用 id（ask 升级审批的键控用） */
  toolCallId?: string
  /** 调用归属（网关注入、Worker 不可伪造）；仅作 hook 载荷，不进 MCP 工具入参 */
  origin: ApprovalOrigin
}

/** 引擎 → 网关的简化判定（ask 已在引擎侧升级为人工审批并折算成放行/拒绝） */
export interface WorkerMcpHookOutcome {
  /** deny：拒绝原因（网关返回 Worker 作为工具错误） */
  deny?: string
  /** PreToolUse transform：改写后的工具入参 */
  updatedInput?: Record<string, unknown>
  /** PostToolUse transform：改写后的工具结果 */
  updatedResponse?: unknown
  /** 附加上下文（网关拼入工具结果文本回传 Worker——Worker 模型的唯一回传通道） */
  notes: string[]
}

export type WorkerMcpHookDispatcher = (
  event: 'PreToolUse' | 'PostToolUse',
  call: WorkerMcpHookCall
) => Promise<WorkerMcpHookOutcome | null>

/** 进程内单例（仿 eventBus/taskRegistry 先例）；CLI 同进程直连，electron 主/渲染各自持有 */
let workerMcpHookDispatcher: WorkerMcpHookDispatcher | null = null

export function setWorkerMcpHookDispatcher(dispatcher: WorkerMcpHookDispatcher | null): void {
  workerMcpHookDispatcher = dispatcher
}

export function getWorkerMcpHookDispatcher(): WorkerMcpHookDispatcher | null {
  return workerMcpHookDispatcher
}
