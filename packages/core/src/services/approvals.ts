/**
 * 通用审批通道（泛化 PowerShell 确认模式）
 *
 * 圈外写与命令执行共用的"事件挂起 → 壳侧回答 → 继续"通道：
 * request() 按 toolCallId 键控登记（Map 迭代序即插入序，并发请求按到达顺序逐个呈现）
 * 并发 APPROVAL_REQUESTED 事件（载荷：kind/路径/command/diff 预览/归属）→
 * 壳侧（CLI readline / TUI ask / UI 确认条）提问 → 回发 APPROVAL_RESOLVED 事件
 * （或直调 resolve()）→ 挂起的 Promise 以 ApprovalResolution 落定。
 *
 * 审批选项语义：y=批准一次、d=批准并把写目标所在目录加入会话可写根（resolution.addDir 携带，
 * 仅 kind=write 提供）、s=批准并在本次会话内放行桌面主动作（resolution.allowSession 回传，
 * 仅 payload.sessionGrantable 的桌面操作审批提供）、n/Esc=拒绝。
 */

import { eventBus, EVENTS } from '../utils/eventBus'
import { getTaskRegistry } from './delegation/taskRegistry'

/** 审批类别：write=文件写（提供 [d] 加目录选项）、command=命令执行（无 [d]） */
export type ApprovalKind = 'write' | 'command'

/** 审批归属（谁发起的写/命令；Worker 归属由 T3 经 __origin 注入） */
export interface ApprovalOrigin {
  source: 'main' | 'subagent'
  subagentType?: string
  taskId?: string
  /**
   * 委派时一次解析的 agent 记忆目录（网关注入、Worker 不可伪造）：
   * 模板声明 memory 字段时为三作用域解析结果；未声明/非 subagent 为 undefined。
   * save_memory/delete_memory 的 scope 路由据此选 store，执行零查表。
   */
  memoryDir?: string
}

/** APPROVAL_REQUESTED 事件载荷 */
export interface ApprovalRequestPayload {
  toolCallId: string
  kind: ApprovalKind
  /** 写目标路径（kind=write） */
  path?: string
  /** 命令文本（kind=command） */
  command?: string
  /** diff 预览文本（kind=write 时尽量携带） */
  diffPreview?: string
  /** 归属（缺省主会话） */
  origin: ApprovalOrigin
  /** 附加说明（kind=command 时为命令 purpose/intent） */
  detail?: string
  /** 命令请求的附加信息（壳侧展示/改命令回传用） */
  purpose?: string
  intent?: string
  workingDirectory?: string
  /** 仅桌面动作审批（computer_use）携带：壳侧据此渲染 [s]"本次会话内放行"选项 */
  sessionGrantable?: boolean
}

/** 壳侧审批回答 */
export interface ApprovalResolution {
  approved: boolean
  /** [d] 选项：批准并把写目标所在目录加入会话可写根（仅 kind=write） */
  addDir?: string
  /** 拒绝原因（返回给模型） */
  reason?: string
  /** 壳侧改过的命令（旧 PowerShell 确认流允许编辑命令，兼容桥回传） */
  command?: string
  workingDirectory?: string
  /** 壳侧 [s] 回答：批准并在本次会话内放行后续桌面主动作（仅 sessionGrantable 的审批可回传） */
  allowSession?: boolean
}

interface PendingApproval {
  resolve: (resolution: ApprovalResolution) => void
  meta: { payload: ApprovalRequestPayload; requestedAt: number }
}

export class ApprovalChannel {
  /** 挂起审批（Map 迭代序即插入序 = 到达顺序） */
  private pendingApprovals = new Map<string, PendingApproval>()

  constructor() {
    // 新壳侧回答事件（T4/T5 接入）；壳侧也可直调 resolve()
    eventBus.on(EVENTS.APPROVAL_RESOLVED, (data: { toolCallId: string } & ApprovalResolution) => {
      const { toolCallId, ...resolution } = data
      this.resolve(toolCallId, resolution)
    })
  }

  /**
   * 发起审批请求：登记 + 发 APPROVAL_REQUESTED，挂起直到壳侧回答。
   */
  request(payload: ApprovalRequestPayload): Promise<ApprovalResolution> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(payload.toolCallId, {
        resolve,
        meta: { payload, requestedAt: Date.now() },
      })
      eventBus.emit(EVENTS.APPROVAL_REQUESTED, payload)
    })
  }

  /** 壳侧回答：批准/拒绝/[d]（addDir 携带目标目录）；无此挂起返回 false */
  resolve(toolCallId: string, resolution: ApprovalResolution): boolean {
    const pending = this.pendingApprovals.get(toolCallId)
    if (!pending) return false
    this.pendingApprovals.delete(toolCallId)
    pending.resolve(this.recheckTaskNotCancelled(pending.meta.payload, resolution))
    return true
  }

  /**
   * 批准落定前复查（cancel 一致性钩子，T3）：审批所属任务已被取消时强制转拒绝——
   * 与 cancel_task 的 rejectApprovalsForTask 互为双保险，防"取消与批准竞态下照常落盘"。
   * 仅复查 subagent 归属且批准的回答；主会话审批与非批准回答原样放行。
   */
  private recheckTaskNotCancelled(payload: ApprovalRequestPayload, resolution: ApprovalResolution): ApprovalResolution {
    if (!resolution.approved || payload.origin.source !== 'subagent' || !payload.origin.taskId) {
      return resolution
    }
    const registry = getTaskRegistry()
    const task = registry.getByToolCallId(payload.origin.taskId) ?? registry.getByTaskId(payload.origin.taskId)
    if (task?.status === 'cancelled') {
      return { approved: false, reason: '任务已取消' }
    }
    return resolution
  }

  /**
   * 按任务拒绝全部挂起审批（cancel_task 场景预留，T3 消费）：
   * 防止"任务已取消、用户随后批准、executor 照常落盘"的状态漏洞。返回拒绝数量。
   */
  rejectApprovalsForTask(taskId: string, reason?: string): number {
    let count = 0
    for (const [toolCallId, pending] of Array.from(this.pendingApprovals)) {
      if (pending.meta.payload.origin.taskId === taskId) {
        this.pendingApprovals.delete(toolCallId)
        pending.resolve({ approved: false, reason: reason ?? '任务已取消' })
        count++
      }
    }
    return count
  }

  /** 当前挂起的审批请求（按到达顺序；statusline/列表展示用） */
  listPending(): ApprovalRequestPayload[] {
    return Array.from(this.pendingApprovals.values()).map((p) => p.meta.payload)
  }
}

/**
 * 全局审批通道单例
 */
let globalApprovalChannel: ApprovalChannel | null = null

export function getApprovalChannel(): ApprovalChannel {
  if (!globalApprovalChannel) {
    globalApprovalChannel = new ApprovalChannel()
  }
  return globalApprovalChannel
}

/** 重置全局审批通道（主要用于测试；挂起中的请求随之丢弃） */
export function resetApprovalChannel(): void {
  globalApprovalChannel = null
}

