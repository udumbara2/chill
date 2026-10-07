/**
 * 会话级共享看板 · 运行态容器(V1.5)
 *
 * 定位:boardId=sessionId 的轻量板运行态唯一写入者(内存为真相 + BoardStore 落盘快照)。
 * 纪律:
 * - 按 sessionId 懒建板(首次访问先读快照,无则 createBoard);
 * - 每次 mutation 走 boardCore 纯函数 → 落盘 → 发 BOARD_CHANGED(V1.7);
 * - 直跑退化:spawn 即自动 post+claim(工位 id=subagentType·短序号,板内全局递增防跨批撞名——
 *   死亡回流按 assignee 归组,撞名会误伤在途条目),永无 pending 悬挂;
 * - settle 桥经 settleByTaskId(claimedByTaskId 数据匹配,零启发式);
 * - 会话删除走 archive(→ store.archiveBoard:在途条目全部 cancelItem 留痕后归档标记)。
 * 单例装配仿 TeamRuntimeService(壳侧 set,未装配时桥/工具显式降级,不隐式建默认实例——
 * 防测试与未接线宿主误写真实 ~/.chill/boards)。
 */

import {
  adjudicate,
  block,
  cancelItem,
  claim,
  createBoard,
  onTaskSettle,
  post,
  read,
  release,
  remove,
  rebindClaim as coreRebindClaim,
  unblock,
  update,
} from './boardCore'
import { BoardStore, isCorruptSnapshotError, type SessionBoardStore } from './boardStore'
import {
  buildBoardProjection,
  type BoardProjection,
  type BoardProjectionOptions,
} from './boardProjection'
import { BoardError } from './boardTypes'
import type {
  BoardCaller,
  BoardItem,
  BoardSettleOutcome,
  BoardState,
  BoardAdjudication,
} from './boardTypes'
import { eventBus, EVENTS, type BoardChangedPayload } from '../../utils/eventBus'
import { getAskChannel } from '../askChannel'
import { adoptSnapshotRev, migrateSnapshotRev } from '../snapshotRev'

/** 工位登记(taskId → 板 + 工位名;settle 桥与 caller 解析的反查键) */
interface WorkstationEntry {
  sessionId: string
  workstation: string
}

export interface AutoPostInput {
  /** 发起会话 id(__origin.sessionId);缺省经 parentTaskId 反查(嵌套委派) */
  sessionId?: string
  /** 发起方任务 toolCall.id(嵌套委派的工位/板反查键) */
  parentTaskId?: string
  batchId: string
  /** 本任务的绑定键(=toolCall.id;自动结项关联 claimedByTaskId) */
  taskId: string
  subagentType: string
  title: string
  description?: string
  note?: string
}

/** 短序号 ↔ 数字(以 26 进制双射:A=1..Z=26,AA=27;工位后缀) */
function numToSeq(n: number): string {
  let out = ''
  let x = n
  while (x > 0) {
    x--
    out = String.fromCharCode(65 + (x % 26)) + out
    x = Math.floor(x / 26)
  }
  return out
}

function seqToNum(seq: string): number {
  let n = 0
  for (const ch of seq) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

/** 下一个工位 id:subagentType·短序号(扫既有同前缀工位[板上条目+登记表]取最大序号 +1) */
export function nextWorkstationId(existingAssignees: Iterable<string | undefined | null>, subagentType: string): string {
  const prefix = `${subagentType}·`
  let max = 0
  for (const a of existingAssignees) {
    if (!a || !a.startsWith(prefix)) continue
    const seq = a.slice(prefix.length)
    if (/^[A-Z]+$/.test(seq)) max = Math.max(max, seqToNum(seq))
  }
  return `${prefix}${numToSeq(max + 1)}`
}

export class SessionBoardService {
  private store: SessionBoardStore
  private states = new Map<string, BoardState>()
  private workstations = new Map<string, WorkstationEntry>()
  /** mutation 串行队列(内存 mutex;并发 post+claim 不丢更新——batch 成员 forEach 并发实测教训) */
  private writeQueue: Promise<unknown> = Promise.resolve()
  /** 同板并发首载去重(两个 spawn 同时懒建同一板只读盘一次) */
  private loading = new Map<string, Promise<BoardState>>()

  constructor(store: SessionBoardStore = new BoardStore()) {
    this.store = store
  }

  // ---------------- 懒建板 / 工位 ----------------

  /** 按 sessionId 懒建板:内存 → 快照 → createBoard;快照条目的 claimedByTaskId 回填工位索引。
   *  rev 纪律(2026-10-07 事故根治):加载/新建一律过 migrateSnapshotRev 纪元迁移——损坏重开/文件
   *  丢失的新板绝不回小计数(手机 LWW 只放行更大 rev,回 0=该会话看板永久冻结);损坏与 IO 错误
   *  分流(损坏可重开新板,IO 上抛——瞬时锁文件不得当"没有板"新建覆盖好文件)。 */
  async ensureBoard(sessionId: string): Promise<BoardState> {
    const existing = this.states.get(sessionId)
    if (existing) return existing
    const inflight = this.loading.get(sessionId)
    if (inflight) return inflight
    const pending = (async () => {
      let state: BoardState | undefined
      try {
        state = await this.store.load(sessionId)
      } catch (err) {
        if (isCorruptSnapshotError(err)) {
          console.warn(`【看板】快照损坏(已隔离留证),按新板继续(${sessionId}):`, err)
        } else {
          throw err
        }
      }
      const origin = state ? '快照' : '新建'
      const raw = state ?? createBoard(sessionId)
      const migrated = migrateSnapshotRev(raw.revision)
      const board = migrated === raw.revision ? raw : { ...raw, revision: migrated }
      if (migrated !== raw.revision) {
        console.log(`[board] rev 纪元迁移 sid=${sessionId} ${raw.revision}→${migrated}(${origin};时间基根治)`)
        try {
          await this.store.save(board) // 迁移即落盘:文件诚实+重启不重复迁移(失败不阻断,内存为准)
        } catch (err) {
          console.warn(`【看板】迁移落盘失败(${sessionId},内存继续):`, err)
        }
      }
      this.states.set(sessionId, board)
      for (const item of board.items) {
        if (item.claimedByTaskId && item.assignee && !this.workstations.has(item.claimedByTaskId)) {
          this.workstations.set(item.claimedByTaskId, { sessionId, workstation: item.assignee })
        }
      }
      return board
    })()
    this.loading.set(sessionId, pending)
    try {
      return await pending
    } finally {
      this.loading.delete(sessionId)
    }
  }

  /** mutation 串行化:整段读-改-写-落盘排队执行,返回值=操作本身结果 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** 板内已用工位(条目 assignee + 工位登记表并集;短序号唯一性扫描基) */
  private usedWorkstations(sessionId: string): (string | undefined | null)[] {
    const board = this.states.get(sessionId)
    const fromItems = (board?.items ?? []).map((i) => i.assignee)
    const fromIndex: string[] = []
    for (const entry of this.workstations.values()) {
      if (entry.sessionId === sessionId) fromIndex.push(entry.workstation)
    }
    return [...fromItems, ...fromIndex]
  }

  /** 生成并登记工位(spawn 点调用):subagentType·短序号 */
  async spawnWorkstation(sessionId: string, subagentType: string, taskId: string): Promise<string> {
    return this.enqueue(async () => {
      await this.ensureBoard(sessionId)
      const workstation = nextWorkstationId(this.usedWorkstations(sessionId), subagentType)
      this.workstations.set(taskId, { sessionId, workstation })
      return workstation
    })
  }

  /** 工位反查(参数自报无效:只认 taskId 登记/板上绑定) */
  workstationOf(sessionId: string, taskId: string | undefined): string | undefined {
    if (!taskId) return undefined
    const entry = this.workstations.get(taskId)
    return entry?.sessionId === sessionId ? entry.workstation : undefined
  }

  /** caller 解析兜底(绕过 spawn 点的存量任务):按 subagentType 现场派生工位并登记 */
  async ensureWorkstation(sessionId: string, taskId: string, subagentType: string): Promise<string> {
    return this.enqueue(async () => {
      const known = this.workstationOf(sessionId, taskId)
      if (known) return known
      await this.ensureBoard(sessionId)
      const workstation = nextWorkstationId(this.usedWorkstations(sessionId), subagentType || 'worker')
      this.workstations.set(taskId, { sessionId, workstation })
      return workstation
    })
  }

  /** 任务 → 板(settle 桥反查键) */
  sessionIdOfTask(taskId: string): string | undefined {
    return this.workstations.get(taskId)?.sessionId
  }

  /**
   * 直跑自动挂项(spawn 即认领,永无 pending):post 一条 pending 条目并立即 claim——
   * title=任务标题/摘要,batchId=批次 id,claimedByTaskId=toolCallId,工位=subagentType·短序号。
   * 无 sessionId 且无 parentTaskId 反查命中时返回 null(非会话路径不挂板)。
   */
  async autoPostAndClaim(input: AutoPostInput): Promise<{ sessionId: string; item: BoardItem; workstation: string } | null> {
    return this.enqueue(async () => {
      const sessionId = input.sessionId ?? (input.parentTaskId ? this.sessionIdOfTask(input.parentTaskId) : undefined)
      if (!sessionId) return null
      const board = await this.ensureBoard(sessionId)
      const workstation = nextWorkstationId(this.usedWorkstations(sessionId), input.subagentType)
      const posted = post(board, {
        title: input.title,
        description: input.description,
        batchId: input.batchId,
        createdBy: 'lead',
        note: input.note,
      })
      const claimed = claim(posted.state, posted.item.id, { assignee: workstation, claimedByTaskId: input.taskId })
      await this.commit(sessionId, claimed.state)
      this.workstations.set(input.taskId, { sessionId, workstation })
      return { sessionId, item: claimed.item, workstation }
    })
  }

  // ---------------- 板操作代理(boardCore 纯函数 + 落盘 + 事件) ----------------

  async readBoard(sessionId: string): Promise<{ revision: number; items: BoardItem[] }> {
    return read(await this.ensureBoard(sessionId))
  }

  async post(sessionId: string, input: Parameters<typeof post>[1]): Promise<BoardItem> {
    return this.enqueue(async () => {
      const res = post(await this.ensureBoard(sessionId), input)
      await this.commit(sessionId, res.state)
      return res.item
    })
  }

  async claim(sessionId: string, itemId: string, input: { assignee: string; claimedByTaskId?: string }): Promise<BoardItem> {
    return this.enqueue(async () => {
      const res = claim(await this.ensureBoard(sessionId), itemId, input)
      // 任务绑定即工位索引(settle 桥反查键;绑定缺省=lead 认领,不登记)
      if (input.claimedByTaskId) {
        this.workstations.set(input.claimedByTaskId, { sessionId, workstation: input.assignee })
      }
      await this.commit(sessionId, res.state)
      return res.item
    })
  }

  async update(
    sessionId: string,
    itemId: string,
    patch: Parameters<typeof update>[2],
    caller: BoardCaller,
  ): Promise<{ item: BoardItem; noteTruncated?: boolean; resultTruncated?: boolean }> {
    return this.enqueue(async () => {
      const res = update(await this.ensureBoard(sessionId), itemId, patch, caller)
      await this.commit(sessionId, res.state)
      return { item: res.item, noteTruncated: res.noteTruncated, resultTruncated: res.resultTruncated }
    })
  }

  /** 置为需拍板(ask 通道编程入口;板工具不暴露 block 动作) */
  async block(sessionId: string, itemId: string, input: { reason: string }, caller: BoardCaller): Promise<BoardItem> {
    return this.enqueue(async () => {
      const res = block(await this.ensureBoard(sessionId), itemId, input, caller)
      await this.commit(sessionId, res.state)
      return res.item
    })
  }

  async release(sessionId: string, itemId: string, input: { by: string; reason: string; suggestedTo?: string }): Promise<BoardItem> {
    return this.enqueue(async () => {
      const res = release(await this.ensureBoard(sessionId), itemId, input)
      await this.commit(sessionId, res.state)
      return res.item
    })
  }

  async remove(sessionId: string, itemId: string, caller: BoardCaller): Promise<void> {
    return this.enqueue(async () => {
      const res = remove(await this.ensureBoard(sessionId), itemId, caller)
      await this.commit(sessionId, res.state)
    })
  }

  async adjudicate(sessionId: string, itemId: string, decision: BoardAdjudication, caller: BoardCaller): Promise<BoardItem> {
    return this.enqueue(async () => {
      const res = adjudicate(await this.ensureBoard(sessionId), itemId, decision, caller)
      await this.commit(sessionId, res.state)
      return res.item
    })
  }

  async unblock(sessionId: string, itemId: string, caller: BoardCaller): Promise<BoardItem> {
    return this.enqueue(async () => {
      const res = unblock(await this.ensureBoard(sessionId), itemId, caller)
      await this.commit(sessionId, res.state)
      return res.item
    })
  }

  async cancelItem(sessionId: string, itemId: string, input: { by: string; reason: string }): Promise<BoardItem> {
    return this.enqueue(async () => {
      const res = cancelItem(await this.ensureBoard(sessionId), itemId, input)
      await this.commit(sessionId, res.state)
      return res.item
    })
  }

  // ---------------- settle 桥 / 投影 / 归档 ----------------

  /**
   * settle 桥入口(boardSettleBridge 调;claimedByTaskId 数据匹配走 boardCore.onTaskSettle):
   * completed=自动结项 / failed|cancelled=死亡回流(见 boardCore 语义)。未登记任务=无操作。
   * 返回影响面(死亡回流清 ask / 拉活识别的判定材料;未登记时全空)。
   */
  async settleByTaskId(
    taskId: string,
    outcome: BoardSettleOutcome,
    opts?: { result?: string },
  ): Promise<{ settledIds: string[]; reflowedIds: string[]; frozenIds: string[] }> {
    return this.enqueue(async () => {
      const sessionId = this.sessionIdOfTask(taskId)
      if (!sessionId) return { settledIds: [] as string[], reflowedIds: [] as string[], frozenIds: [] as string[] }
      const board = await this.ensureBoard(sessionId)
      const res = onTaskSettle(board, taskId, outcome, opts)
      await this.commit(sessionId, res.state)
      // V3.2 死亡回流清 ask(联动规则钉在死亡回流源头,任何调用路径都生效):
      // 回流/冻结条目上挂起的提问 → resolved(cancelled)「该提问已失效(认领人已死)」
      if (outcome === 'failed' || outcome === 'cancelled') {
        getAskChannel().invalidateByItems([...res.reflowedIds, ...res.frozenIds])
      }
      return { settledIds: res.settledIds, reflowedIds: res.reflowedIds, frozenIds: res.frozenIds }
    })
  }

  /**
   * V3.1 拉活识别:该工位「已认领未绑任务」条目(assignee=工位 && claimedByTaskId 空 && in_progress),
   * 最早挂起的在前(拉活取第一条,余下等续跑 settle 再链式拉起)。
   */
  findIntentItems(sessionId: string, workstation: string): BoardItem[] {
    const board = this.states.get(sessionId)
    if (!board) return []
    return board.items
      .filter((i) => i.assignee === workstation && !i.claimedByTaskId && i.status === 'in_progress')
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** V3.2 ask 归属反查:任务绑定键 → 条目(ask_user 挂起→该条目 blocked 的定位口) */
  findItemByTaskId(taskId: string): { sessionId: string; itemId: string } | undefined {
    const sessionId = this.sessionIdOfTask(taskId)
    if (!sessionId) return undefined
    const board = this.states.get(sessionId)
    const item = board?.items.find((i) => i.claimedByTaskId === taskId)
    return item ? { sessionId, itemId: item.id } : undefined
  }

  /**
   * V3.1 换绑(拉活续跑:意图条目→新执行;照 TeamRuntimeService.resumeMember 换绑先例):
   * claimedByTaskId 改绑新键 + 工位索引登记新键(feed/settle 反查)。
   */
  async rebindClaim(sessionId: string, itemId: string, taskId: string): Promise<BoardItem> {
    return this.enqueue(async () => {
      const board = await this.ensureBoard(sessionId)
      const res = coreRebindClaim(board, itemId, taskId)
      const item = res.item
      if (item.assignee) this.workstations.set(taskId, { sessionId, workstation: item.assignee })
      await this.commit(sessionId, res.state)
      return item
    })
  }

  /**
   * 在既有条目上开始一次尝试（M7 增量 2 的唯一入口；板工具不暴露——派活侧专用）。
   * 状态分流：`pending` → 认领(派新工位 subagentType·短序号 并绑定任务键)；`in_progress|blocked` → 换绑任务键(不动 assignee)；
   * `failed`(待裁决) → 拒绝并指路 adjudicate(retry)；终态 → 拒绝(终态不可离开)。
   * 一次绑定**不改 batchId/createdAt**：工作单元身份不变，只追加一次尝试。
   */
  async attachAttempt(
    sessionId: string,
    itemId: string,
    input: { claimedByTaskId: string; subagentType: string; takeOverFromTaskId?: string },
  ): Promise<BoardItem> {
    return this.enqueue(async () => {
      const board = await this.ensureBoard(sessionId)
      const current = board.items.find((i) => i.id === itemId)
      if (!current) {
        throw new BoardError('ITEM_NOT_FOUND', `看板条目 ${itemId} 不在会话 ${sessionId} 的板上`, itemId)
      }
      if (current.status === 'pending') {
        const assignee = nextWorkstationId(this.usedWorkstations(sessionId), input.subagentType)
        const res = claim(board, itemId, { assignee, claimedByTaskId: input.claimedByTaskId })
        this.workstations.set(input.claimedByTaskId, { sessionId, workstation: assignee })
        await this.commit(sessionId, res.state)
        return res.item
      }
      if (current.status === 'in_progress' || current.status === 'blocked') {
        // 已绑定的在途条目 = 有执行者持有：只允许"接管自己这一次执行的旧键"（计划批准轮/打回轮的续跑），
        // 不允许把别人的在途活改派给另一个执行者（防两个执行者同时做同一件活）。
        if (current.claimedByTaskId && current.claimedByTaskId !== input.takeOverFromTaskId) {
          throw new BoardError(
            'INVALID_STATE',
            `看板条目 ${itemId}「${current.title}」正由 ${current.claimedByTaskId} 执行中，不能改派给另一个执行者。` +
              `若它已停/已死，请先 board release（退回池）或 cancel_item 清场，再带 board_item_id 重派。`,
            itemId,
          )
        }
        const res = coreRebindClaim(board, itemId, input.claimedByTaskId)
        if (res.item.assignee) {
          this.workstations.set(input.claimedByTaskId, { sessionId, workstation: res.item.assignee })
        }
        await this.commit(sessionId, res.state)
        return res.item
      }
      if (current.status === 'failed') {
        throw new BoardError(
          'INVALID_STATE',
          `看板条目 ${itemId}「${current.title}」处于待裁决(连续失败 ${current.failCount ?? 2} 次)。` +
            `请先裁决：board adjudicate(id="${itemId}", decision="retry") 回池后再带 board_item_id 复用；不要另起一行。`,
          itemId,
        )
      }
      throw new BoardError(
        'INVALID_STATE',
        `看板条目 ${itemId}「${current.title}」已是${current.status === 'completed' ? '已交付' : '已取消'}终态，不可复用。` +
          `若这是另一件新活，请带 new_work: true 重新派活。`,
        itemId,
      )
    })
  }

  async getProjection(sessionId: string, opts: BoardProjectionOptions, extraItems?: BoardItem[]): Promise<BoardProjection> {
    const board = await this.ensureBoard(sessionId)
    // 显示并集（M7 增量 1）：会话板 ∪ 外部行集（当前=同会话活动团队板行）——同一投影纯函数，行序/needsYou/限窗天然一致
    const items = extraItems && extraItems.length > 0 ? [...board.items, ...extraItems] : board.items
    return buildBoardProjection(items, opts)
  }

  /** 当前板 revision（board.sync 对账的 rev 数据源;副作用=确保板已载+纪元迁移） */
  async getRevision(sessionId: string): Promise<number> {
    return (await this.ensureBoard(sessionId)).revision
  }

  /**
   * 对账采纳(rev 纪律):手机上报 knownRev 高于本端(跨纪元/跨进程丢更新)→ 抬到 adoptSnapshotRev
   * 再答——应答必过手机 LWW。enqueue 串行+落盘+BOARD_CHANGED(commit 同款);未低于下限=零动作。
   */
  async touchRevisionAtLeast(sessionId: string, knownRev: number): Promise<number> {
    return this.enqueue(async () => {
      const board = await this.ensureBoard(sessionId)
      if (Number.isFinite(knownRev) && board.revision <= knownRev) {
        const next = { ...board, revision: adoptSnapshotRev(knownRev) }
        console.log(`[board] rev 对账采纳 sid=${sessionId} ${board.revision}→${next.revision}`)
        await this.commit(sessionId, next)
        return next.revision
      }
      return board.revision
    })
  }

  /** 会话删除语义:在途条目全部 cancelItem 留痕后落盘归档标记(经 store.archiveBoard) */
  async archive(sessionId: string, reason: string): Promise<void> {
    return this.enqueue(async () => {
      const board = await this.ensureBoard(sessionId)
      try {
        await this.store.save(board)
      } catch (err) {
        console.warn(`【看板】归档前快照写入失败(${sessionId}):`, err)
      }
      const archived = await this.store.archiveBoard(sessionId, reason)
      this.states.set(sessionId, archived)
      this.emitChanged(archived)
    })
  }

  // ---------------- 内部 ----------------

  private async commit(sessionId: string, state: BoardState): Promise<void> {
    this.states.set(sessionId, state)
    try {
      await this.store.save(state)
    } catch (err) {
      console.warn(`【看板】快照写入失败(${sessionId}):`, err)
    }
    this.emitChanged(state)
  }

  private emitChanged(state: BoardState): void {
    const payload: BoardChangedPayload = { sessionId: state.boardId, boardId: state.boardId, revision: state.revision }
    eventBus.emit(EVENTS.BOARD_CHANGED, payload)
  }

  /** 测试/优雅退出:清内存(不落盘) */
  reset(): void {
    this.states.clear()
    this.workstations.clear()
  }
}

// ---------- 进程级单例访问器(双壳各自装配;仿 TeamRuntimeService) ----------

let sessionBoardService: SessionBoardService | undefined

export function setSessionBoardService(svc: SessionBoardService): void {
  sessionBoardService = svc
}

/** 会话看板服务访问器(未装配返回 undefined,调用方降级——不隐式建默认实例) */
export function getSessionBoardService(): SessionBoardService | undefined {
  return sessionBoardService
}

/** 重置单例(主要用于测试) */
export function resetSessionBoardService(): void {
  sessionBoardService = undefined
}
