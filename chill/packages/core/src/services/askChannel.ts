/**
 * 通用提问通道（M4e：问人原语桥接）
 *
 * userInputProvider 全类别请示（ask_user/submit_plan/propose_goal/goal 熔断等）的统一通道，
 * 与 ApprovalChannel "形状同构、类型分立"（回答为选项 label 原文或自由文本，非 approved 二元）。
 *
 * 形状：ask() 登记 pending（id 键控）+ 发 ASK_REQUESTED → 各呈现面（壳订阅 / relay 桥→手机）
 * 呈现并回答 → 回答一律回灌 resolve()（先到先落、唯一落定口）→ 发 ASK_SETTLED → 挂起的
 * Promise 以回答文本落定。本类是常驻唯一提问入口（壳启动即 setUserInputProvider(getAskChannel())，
 * 与 ApprovalChannel 的常驻总线对齐）；壳呈现面自行订阅事件呈现与收摊（CLI 壳在 cli.ts/tuiShell.ts）。
 *
 * Node-free / renderer 安全（登记表 + Promise + eventBus，无 Node API 无显示代码），
 * 导出纪律与 approvals.ts 同级。
 */

import { eventBus, EVENTS } from '../utils/eventBus'
import { randomUuid } from './relay/envelope'
import { SETTLED_RING_CAP, SETTLED_RING_TTL_MS } from './approvals'
import type { AskDecisionEntry, AskTriageCard } from './relay/envelope'
import type { AskUserOption, IUserInputProvider } from '../interfaces/IUserInputProvider'

/** ASK_REQUESTED 事件载荷（也是 ask.request 信封 body 的数据源） */
export interface AskRequestPayload {
  id: string
  question: string
  options?: AskUserOption[]
  allowFreeText?: boolean
  /** 自由文本提示文案（语境相关，由提问方携带；缺省时呈现层用通用文案） */
  hint?: string
  /** 2.4 发起会话 id（只增；M4 徽标与过滤备料。缺归因=undefined 兜底现状） */
  sessionId?: string
  /** V3.2 发起任务绑定键（只增；ask↔看板条目联动的定位键——Worker 的任务=其看板条目绑定。内部归因，不外显线形） */
  taskId?: string
  /** V3.2 关联看板条目 id（只增；挂起→blocked/落定→unblock/认领人死亡→失效的联动键。内部归因，不外显线形） */
  itemId?: string
  /** 改进提案点选裁决卡（只增；协议线形唯一事实点在 envelope.ts。手机端缺字段/校验失败落回纯文本提问卡） */
  card?: AskTriageCard
  /** 提问发起时刻（epoch ms；只增。位置真相单一事实源：首发/pending 重推/落定环重放经 RelayBridge 统一携带为信封 originalTs，手机端据此钉位） */
  requestedAt?: number
}

interface PendingAsk {
  resolve: (answer: string) => void
  meta: { payload: AskRequestPayload; requestedAt: number }
}

/** 近期落定记录（终态愈合的数据源：resync 重放"请求+落定"对，手机卡片收敛到真相） */
export interface SettledAskRecord {
  payload: AskRequestPayload
  answer: string
  by: string
  settledAt: number
  /** 结构化决策（手机点选卡 additive 回传；随落定环携带，开庭收口经 takeSettledDecisions 消费式读取） */
  decisions?: AskDecisionEntry[]
}

/** 近期落定环上限与留存窗复用 approvals.ts 的 SETTLED_RING_CAP/SETTLED_RING_TTL_MS（同纪律单点定义） */

export class AskChannel implements IUserInputProvider {
  /** 挂起提问（Map 迭代序即插入序 = 到达顺序） */
  private pendingAsks = new Map<string, PendingAsk>()
  /** 近期落定环（落定即记录；cap 200 + 读取时惰性剔除超龄条目） */
  private recentSettled: SettledAskRecord[] = []

  /**
   * executor 唯一入口：登记 + 发 ASK_REQUESTED，挂起直到任一呈现面回答。
   * 回答语义与壳侧归一化对齐：选项作答 = label 原文；自由文本原样；跳过 = '跳过'。
   */
  ask(
    question: string,
    options?: AskUserOption[],
    allowFreeText?: boolean,
    freeTextHint?: string,
    attribution?: { sessionId?: string; taskId?: string; itemId?: string },
    extra?: { id?: string; card?: AskTriageCard },
  ): Promise<string> {
    return new Promise((resolve) => {
      const requestedAt = Date.now()
      const payload: AskRequestPayload = {
        id: extra?.id ?? randomUuid(),
        question,
        requestedAt,
        ...(options !== undefined ? { options } : {}),
        ...(allowFreeText !== undefined ? { allowFreeText } : {}),
        ...(freeTextHint !== undefined ? { hint: freeTextHint } : {}),
        // 2.4 载荷补 sessionId（只增；缺归因=undefined 兜底现状）
        ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
        // V3.2 ask↔看板条目联动键（只增;内部归因不外显线形）
        ...(attribution?.taskId ? { taskId: attribution.taskId } : {}),
        ...(attribution?.itemId ? { itemId: attribution.itemId } : {}),
        ...(extra?.card !== undefined ? { card: extra.card } : {}),
      }
      this.pendingAsks.set(payload.id, { resolve, meta: { payload, requestedAt } })
      eventBus.emit(EVENTS.ASK_REQUESTED, payload)
    })
  }

  /** 落定通告 + 记近期落定环（终态愈合重放的数据源）；所有落定路径统一经此 */
  private emitSettled(payload: AskRequestPayload, answer: string, by: string, decisions?: AskDecisionEntry[]): void {
    this.recentSettled.push({ payload, answer, by, settledAt: Date.now(), ...(decisions !== undefined ? { decisions } : {}) })
    if (this.recentSettled.length > SETTLED_RING_CAP) this.recentSettled.splice(0, this.recentSettled.length - SETTLED_RING_CAP)
    eventBus.emit(EVENTS.ASK_SETTLED, { id: payload.id, answer, by })
  }

  /** 近期落定记录（读取时惰性剔除超龄条目；resync 重放用） */
  listRecentSettled(): SettledAskRecord[] {
    const cutoff = Date.now() - SETTLED_RING_TTL_MS
    this.recentSettled = this.recentSettled.filter((r) => r.settledAt >= cutoff)
    return this.recentSettled.slice()
  }

  /** 呈现面回答：先到先落；无此挂起（迟到/落空）返回 false。by 标记回答来源（local/phone）。
   *  decisions = 结构化决策（手机点选卡 additive 回传），随落定记录存储供开庭收口消费。 */
  resolve(id: string, answer: string, by = 'local', decisions?: AskDecisionEntry[]): boolean {
    const pending = this.pendingAsks.get(id)
    if (!pending) return false
    this.pendingAsks.delete(id)
    this.emitSettled(pending.meta.payload, answer, by, decisions)
    pending.resolve(answer)
    return true
  }

  /** 消费式读取落定记录的结构化决策（开庭收口的双通道之一；取走即清，二次读取返回 undefined） */
  takeSettledDecisions(id: string): AskDecisionEntry[] | undefined {
    const rec = this.recentSettled.find((r) => r.payload.id === id)
    if (!rec || rec.decisions === undefined) return undefined
    const decisions = rec.decisions
    delete rec.decisions
    return decisions
  }

  /** 重发 ASK_REQUESTED（开庭去重重推用；仅挂起中命中，手机端同 id 幂等收敛）。返回是否命中 */
  reannounce(id: string): boolean {
    const pending = this.pendingAsks.get(id)
    if (!pending) return false
    eventBus.emit(EVENTS.ASK_REQUESTED, pending.meta.payload)
    return true
  }

  /**
   * V3.2 失效收尾（认领人死亡/上下文蒸发）：挂起 ask → resolved(cancelled)「该提问已失效」，
   * 挂起 Promise 以失效文案落定（不再等回答）。照既有"迟到回答回 resolved(cancelled)"的终态语义。
   * 返回是否命中（已落定/不存在=false，幂等）。
   */
  invalidate(id: string, reason = '该提问已失效'): boolean {
    const pending = this.pendingAsks.get(id)
    if (!pending) return false
    this.pendingAsks.delete(id)
    this.emitSettled(pending.meta.payload, reason, 'cancelled')
    pending.resolve(reason)
    return true
  }

  /**
   * V3.2 按看板条目批量失效（死亡回流清尾）：itemId 命中的挂起 ask 一律 resolved(cancelled)。
   * 返回命中的 ask id（幂等;无归因 ask 不在此列）。
   */
  invalidateByItems(itemIds: string[], reason = '该提问已失效(认领人已死)'): string[] {
    if (itemIds.length === 0) return []
    const dead = new Set(itemIds)
    const hit: string[] = []
    for (const payload of this.listPending()) {
      if (payload.itemId && dead.has(payload.itemId) && this.invalidate(payload.id, reason)) {
        hit.push(payload.id)
      }
    }
    return hit
  }

  /** 当前挂起的提问（按到达顺序；重连重推/列表展示用） */
  listPending(): AskRequestPayload[] {
    return Array.from(this.pendingAsks.values()).map((p) => p.meta.payload)
  }
}

/** 全局提问通道单例 */
let globalAskChannel: AskChannel | null = null
export function getAskChannel(): AskChannel {
  if (!globalAskChannel) {
    globalAskChannel = new AskChannel()
  }
  return globalAskChannel
}

/** 重置全局提问通道（主要用于测试；挂起中的请求随之丢弃） */
export function resetAskChannel(): void {
  globalAskChannel = null
}
