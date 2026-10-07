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

/** 审批归属（谁发起的写/命令；Worker 归属由 T3 经 __origin 注入；mobile 归属由 M2 引擎轮次上下文注入） */
export interface ApprovalOrigin {
  source: 'main' | 'subagent' | 'mobile'
  subagentType?: string
  taskId?: string
  /**
   * 委派时一次解析的 agent 记忆目录（网关注入、Worker 不可伪造）：
   * 模板声明 memory 字段时为三作用域解析结果；未声明/非 subagent 为 undefined。
   * save_memory/delete_memory 的 scope 路由据此选 store，执行零查表。
   */
  memoryDir?: string
  /**
   * 委派时登记的 agent 知识库绑定名单（网关注入、Worker 不可伪造）：
   * 模板声明 knowledge 字段时为绑定库名数组；未声明为 undefined（不划界）。
   * 知识库工具的硬边界据此复核，执行零查表。
   */
  knowledgeBases?: string[]
  /**
   * 发起方 SessionScope 路由句柄（2.1 主会话注入；只增字段）：executor 按此经 scope
   * 现读 sessionId/cwd/planMode 等；无 handle（Worker 网关/老路径）回退 legacy 单槽。
   */
  handle?: string
  /** 发起会话 id（2.1 随 __origin 流动；只增字段，事件载荷归因数据源） */
  sessionId?: string
  /** 发起轮次 user 消息身份（2.1 随 __origin 流动；只增字段，备份/事件轮次归因） */
  turnId?: string
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
  /** mobile 起源审批的绝对死线（epoch ms）：request() 在源头算好附带，远程呈现端（手机）倒计时用 */
  timeoutAt?: number
  /** 审批发起时刻（epoch ms；只增。与 askChannel.requestedAt 同构：重放钉位的事实源） */
  requestedAt?: number
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
  /** mobile 起源审批的超时定时器（仅 mobile 起源创建；落定/批量拒绝时 clear） */
  timeoutTimer?: ReturnType<typeof setTimeout>
}

/** mobile 起源审批的默认超时（人在外面、审批弹在没人的桌面屏幕上时 fail-closed） */
export const MOBILE_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

/** 近期落定记录（终态愈合的数据源：resync 重放"请求+落定"对，手机卡片收敛到真相） */
export interface SettledApprovalRecord {
  payload: ApprovalRequestPayload
  approved: boolean
  by: string
  reason?: string
  settledAt: number
}

/** 近期落定环上限与留存窗（手机重启历史即清空，环只需盖住"桥侧没发出"的窗口） */
export const SETTLED_RING_CAP = 200
export const SETTLED_RING_TTL_MS = 30 * 60 * 1000

export class ApprovalChannel {
  /** 挂起审批（Map 迭代序即插入序 = 到达顺序） */
  private pendingApprovals = new Map<string, PendingApproval>()
  /** 近期落定环（落定即记录；cap 200 + 读取时惰性剔除超龄条目） */
  private recentSettled: SettledApprovalRecord[] = []

  constructor() {
    // 新壳侧回答事件（T4/T5 接入）；壳侧也可直调 resolve()
    eventBus.on(EVENTS.APPROVAL_RESOLVED, (data: { toolCallId: string } & ApprovalResolution) => {
      const { toolCallId, ...resolution } = data
      this.resolve(toolCallId, resolution)
    })
  }

  /**
   * 发起审批请求：登记 + 发 APPROVAL_REQUESTED，挂起直到壳侧回答。
   * mobile 起源审批带 5 分钟超时：人在外面、审批弹在没人的桌面屏幕上时 fail-closed
   * （超时自动拒绝，reason 进工具结果 → assistant 回复经 relay 自然回流手机回执）。
   * opts.timeoutMs：测试注入用覆盖超时（生产缺省 = MOBILE_APPROVAL_TIMEOUT_MS）。
   */
  request(payload: ApprovalRequestPayload, opts?: { timeoutMs?: number }): Promise<ApprovalResolution> {
    return new Promise((resolve) => {
      const requestedAt = Date.now()
      const timeoutMs = opts?.timeoutMs ?? MOBILE_APPROVAL_TIMEOUT_MS
      // mobile 起源：源头算好绝对死线附带进 payload（远程呈现端倒计时用，桥不做近似）
      const effectivePayload: ApprovalRequestPayload =
        payload.origin.source === 'mobile'
          ? { ...payload, timeoutAt: requestedAt + timeoutMs, requestedAt }
          : { ...payload, requestedAt }
      const pending: PendingApproval = {
        resolve,
        meta: { payload: effectivePayload, requestedAt },
      }
      if (payload.origin.source === 'mobile') {
        pending.timeoutTimer = setTimeout(() => {
          if (!this.pendingApprovals.delete(payload.toolCallId)) return
          approvalPendingLeave()
          this.emitSettled(payload, false, 'timeout', '审批超时已拒绝')
          resolve({ approved: false, reason: '审批超时已拒绝' })
        }, timeoutMs)
        // 审批超时不应拖住进程退出（CLI 退出/测试收尾）
        if (typeof pending.timeoutTimer.unref === 'function') pending.timeoutTimer.unref()
      }
      this.pendingApprovals.set(payload.toolCallId, pending)
      approvalPendingEnter()
      eventBus.emit(EVENTS.APPROVAL_REQUESTED, effectivePayload)
    })
  }

  /** 落定通告（M4：手机等远程呈现端据此时将审批卡片置灰）+ 记近期落定环（终态愈合重放的数据源）；所有落定路径统一经此 */
  private emitSettled(payload: ApprovalRequestPayload, approved: boolean, by: string, reason?: string): void {
    this.recentSettled.push({ payload, approved, by, ...(reason !== undefined ? { reason } : {}), settledAt: Date.now() })
    if (this.recentSettled.length > SETTLED_RING_CAP) this.recentSettled.splice(0, this.recentSettled.length - SETTLED_RING_CAP)
    eventBus.emit(EVENTS.APPROVAL_SETTLED, { toolCallId: payload.toolCallId, approved, by, ...(reason !== undefined ? { reason } : {}) })
  }

  /** 近期落定记录（读取时惰性剔除超龄条目；resync 重放用） */
  listRecentSettled(): SettledApprovalRecord[] {
    const cutoff = Date.now() - SETTLED_RING_TTL_MS
    this.recentSettled = this.recentSettled.filter((r) => r.settledAt >= cutoff)
    return this.recentSettled.slice()
  }

  /** 壳侧回答：批准/拒绝/[d]（addDir 携带目标目录）；无此挂起返回 false。by 标记回答来源（local/phone） */
  resolve(toolCallId: string, resolution: ApprovalResolution, by = 'local'): boolean {
    const pending = this.pendingApprovals.get(toolCallId)
    if (!pending) return false
    this.pendingApprovals.delete(toolCallId)
    if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer)
    approvalPendingLeave()
    this.emitSettled(pending.meta.payload, resolution.approved, by, resolution.reason)
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
        if (pending.timeoutTimer) clearTimeout(pending.timeoutTimer)
        approvalPendingLeave()
        this.emitSettled(pending.meta.payload, false, 'cancelled', reason ?? '任务已取消')
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

// ---------- 审批挂起聚合（桌面自审批防护的数据源） ----------
// enter/leave 计数聚合：任一审批通道挂起即 pending。严禁各通道直写绝对值——
// A 通道挂起中 B 通道落定会把 A 的挂起态冲掉（竞态）。
let approvalPendingCount = 0
type ApprovalPendingListener = (pending: boolean) => void
const approvalPendingListeners = new Set<ApprovalPendingListener>()
let lastApprovalPending = false

function notifyApprovalPending(): void {
  const pending = approvalPendingCount > 0
  if (pending === lastApprovalPending) return
  lastApprovalPending = pending
  for (const fn of approvalPendingListeners) fn(pending)
}

/** 审批挂起进入（ApprovalChannel.request 与 hook 信任审批 trustApprover 等各通道统一入口） */
export function approvalPendingEnter(): void {
  approvalPendingCount++
  notifyApprovalPending()
}

/** 审批落定离开（与 enter 严格配对） */
export function approvalPendingLeave(): void {
  if (approvalPendingCount > 0) approvalPendingCount--
  notifyApprovalPending()
}

/** 订阅挂起状态变化（返回退订函数） */
export function onApprovalPendingChange(fn: ApprovalPendingListener): () => void {
  approvalPendingListeners.add(fn)
  return () => {
    approvalPendingListeners.delete(fn)
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

