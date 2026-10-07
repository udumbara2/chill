/**
 * 团队运行时服务(迭代 1:花名册 + 共享看板)
 *
 * 架构纪律:
 * - 单一写入者:本服务持进程内内存真相,team-runs/<runId>/ 下的 JSON 为落盘快照
 *   (tmp+rename 原子写,照 workflowRunStore 范式;宿主无 renameFile 时退化直写)。
 *   Worker 工具调用经网关回宿主执行,天然无跨进程并发,不需要文件锁。
 * - 看板 mutation 走内存 mutex(promise 链)+ 全局 boardRevision CAS。
 * - 归属约束:post 人人可挂;claim 仅 pending;update 仅认领人或 Lead;remove 仅 Lead。
 * - 每进程一个活动团队;进程退出即归档(内存态消失),落盘文件留档只读。
 * - 运行时 roster 是成队时刻的快照:团队 YAML 热改不影响在跑的队。
 */

import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { TeamDefinition } from '../../team/types'
import { getTaskRegistry } from '../delegation/taskRegistry'
import { eventBus, EVENTS } from '../../utils/eventBus'
import { applySnapshotUpdate, createDefaultSnapshot } from './teamPolicy'
import {
  adjudicate as boardAdjudicateOp,
  claim as boardClaimOp,
  post as boardPostOp,
  rebindClaim as boardRebindClaimOp,
  release as boardReleaseOp,
  remove as boardRemoveOp,
  settle as boardSettleOp,
  onTaskSettle as boardOnTaskSettleOp,
  update as boardUpdateOp,
} from '../board/boardCore'
import { BoardError } from '../board/boardTypes'
import type { BoardCaller, BoardState } from '../board/boardTypes'
import {
  type BoardItem,
  type BoardItemStatus,
  type RosterEntry,
  type SnapshotHistoryEntry,
  type TeamBudget,
  type AtomGrant,
  type TeamInboxMessage,
  type TeamRunState,
  type TeamSnapshot,
  type TeamUnfreeze,
} from './teamRuntimeTypes'

/** 归属约束的调用方身份:'lead' 或成员名(由网关 __origin 反查得出,Worker 自报无效) */
export type TeamCaller = string

function makeRunId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/** member_name 会成为信箱文件名:Windows 非法字符响亮拒绝(杜绝信箱写炸) */
function assertSafeMemberName(name: string): void {
  if (/[\\/:*?"<>|]/.test(name)) {
    throw new Error(`成员名 "${name}" 含文件系统非法字符(\\/:*?"<>|),请更换后再试`)
  }
}

export class TeamRuntimeService {
  private fs: IFileSystemProvider
  private dir: string
  /** 宿主 pid 覆盖(UI 渲染进程的 process 是 vite polyfill、无 pid——壳装配时注入实例 pid,见 teamAssetService) */
  private hostPidOverride?: number
  private active: TeamRunState | undefined
  /** mutation/落盘的串行队列(内存 mutex) */
  private writeQueue: Promise<unknown> = Promise.resolve()
  /** 变更监听器(迭代 4 watchdog 订阅;enqueueMutation/enqueuePersist 完成后触发——变更通知,非轮询) */
  private changeListeners = new Set<() => void>()

  constructor(fs: IFileSystemProvider, dir: string, opts?: { hostPid?: number }) {
    this.fs = fs
    this.dir = dir
    this.hostPidOverride = opts?.hostPid
  }

  /** 订阅团队状态变更;返回退订函数 */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  private fireChange(): void {
    for (const fn of this.changeListeners) {
      try {
        fn()
      } catch (err) {
        console.warn('【团队】变更监听器异常:', err)
      }
    }
  }

  // ---------------- 查询(只读,不进 mutex) ----------------

  getActiveTeam(): TeamRunState | undefined {
    return this.active
  }

  /** 授权快照只读访问(team_policy read / 各门控判定用;缺省 = 默认语义) */
  getSnapshot(): TeamSnapshot | undefined {
    return this.active?.snapshot
  }

  /**
   * 快照热更新(team_policy update / 用户直达 / watchdog 解冻共用):
   * 串行化 + teamPolicy 校验(合法值+豁免)+ history 留痕 + 清除未收回 unfreeze + 落盘。
   */
  async updateSnapshot(
    update: { grants?: Record<string, AtomGrant[]>; defaultMemberGrants?: AtomGrant[]; budget?: TeamBudget },
    by: SnapshotHistoryEntry['by'],
    note: string,
  ): Promise<TeamSnapshot> {
    this.requireActive()
    return this.enqueueMutation(() => {
      const team = this.active!
      if (!team.snapshot) throw new Error('当前团队没有授权快照(异常状态)')
      team.snapshot = applySnapshotUpdate(team.snapshot, update, by, note)
      return team.snapshot
    })
  }

  /** 写入解冻态(迭代 4 三通道:watchdog/用户/lead 申请):临时恢复 lead 干预原子并留痕 */
  async setUnfreeze(unfreeze: TeamUnfreeze, note: string): Promise<void> {
    this.requireActive()
    return this.enqueueMutation(() => {
      const team = this.active!
      if (!team.snapshot) throw new Error('当前团队没有授权快照(异常状态)')
      team.snapshot = {
        ...team.snapshot,
        unfreeze,
        history: [...team.snapshot.history, { at: Date.now(), by: unfreeze.by === 'watchdog' ? 'watchdog' : 'system', note }],
      }
    })
  }

  /** 收回解冻态(平息收回:看板恢复活动或 Lead 显式结束):失效并留痕 */
  async clearUnfreeze(note: string): Promise<void> {
    if (!this.active?.snapshot?.unfreeze) return
    return this.enqueueMutation(() => {
      const team = this.active!
      if (!team.snapshot?.unfreeze) return
      team.snapshot = {
        ...team.snapshot,
        unfreeze: undefined,
        history: [...team.snapshot.history, { at: Date.now(), by: 'system', note }],
      }
    })
  }

  /** 同名幂等判断:叫到的就是当前活动团队 → use_team 纯重读,不动运行时状态 */
  isActiveNamedTeam(name: string): boolean {
    return this.active?.name === name
  }

  /** 网关成员资格门:该绑定键(toolCall.id)是否属于在册成员 */
  isMemberTask(taskId: string | undefined): boolean {
    if (!taskId || !this.active) return false
    return this.active.roster.some((e) => e.currentTaskId === taskId)
  }

  /** 归属判定唯一来源:绑定键 → 成员名(Worker 参数自报一律不用) */
  getMemberNameByTaskId(taskId: string | undefined): string | undefined {
    if (!taskId || !this.active) return undefined
    return this.active.roster.find((e) => e.currentTaskId === taskId)?.name
  }

  boardList(): { revision: number; items: BoardItem[] } | undefined {
    if (!this.active) return undefined
    return { revision: this.active.boardRevision, items: [...this.active.board] }
  }

  boardGet(id: string): BoardItem | undefined {
    return this.active?.board.find((i) => i.id === id)
  }

  // ---------------- 生命周期 ----------------

  /** 固定团队成队:有活动团队先归档(归档信息随返回值上报);同名幂等由调用方先行判断 */
  async formFromDefinition(def: TeamDefinition, sessionId?: string): Promise<{ runId: string; archivedRunId?: string }> {
    const archivedRunId = await this.archive()
    const roster: RosterEntry[] = []
    for (const m of def.members) {
      roster.push({
        name: this.uniqueMemberName(m.agent, roster),
        agent: m.agent,
        role: m.role,
        planFirst: m.plan_first === true ? true : undefined,
        status: 'standby',
        joinedAt: Date.now(),
      })
    }
    this.activate(
      {
        runId: makeRunId(def.name),
        name: def.name,
        // 归属会话登记（手机显示并集按此匹配；缺省不写字段=旧语义）
        ...(sessionId !== undefined ? { sessionId } : {}),
        createdAt: Date.now(),
        roster,
        board: [],
        boardRevision: 0,
      },
      def.policy,
    )
    await this.persist()
    return { runId: this.active!.runId, archivedRunId }
  }

  /** ad-hoc 惰性成队:无活动团队时建临时队;已存在(固定/ad-hoc 皆可)则直接复用 */
  ensureAdHocTeam(sessionId?: string): TeamRunState {
    if (!this.active) {
      const state: TeamRunState = {
        runId: makeRunId('adhoc'),
        // 归属会话登记（手机显示并集按此匹配；缺省不写字段=旧语义）
        ...(sessionId !== undefined ? { sessionId } : {}),
        createdAt: Date.now(),
        roster: [],
        board: [],
        boardRevision: 0,
      }
      this.activate(state)
      this.enqueuePersist()
      return state
    }
    // 老内存态补登归属（首次带会话调用时；随后续 mutation 落盘带走）
    if (sessionId !== undefined && this.active.sessionId === undefined) this.active.sessionId = sessionId
    return this.active
  }

  /**
   * 团队诞生的唯一收敛点(显式成队与惰性成队都经这里):授权快照在此生成一次。
   * 默认快照 = 现状语义(成员无编排工具、有团队三工具+请示通道;Lead 全权);
   * 团队 YAML policy 段可声明初始 grants/defaultMemberGrants/budget。
   */
  private activate(state: TeamRunState, policy?: TeamDefinition['policy']): void {
    state.snapshot = createDefaultSnapshot(policy)
    state.ledger = { spentTokens: null, memberCount: state.roster.length }
    // 跨进程观测(UI 快照区):宿主 pid 是存活判定的地面真值,随 activate 固定一次;
    // 渲染进程 process 是 polyfill 无 pid,故优先壳注入值(构造 opts.hostPid)
    state.hostPid = this.hostPidOverride ?? process.pid
    this.active = state
  }

  /** 等待全部挂起的 mutation/落盘完成(测试与优雅退出用;mutation 的 await 只保证内存变更,不保证快照写完) */
  async flush(): Promise<void> {
    await this.writeQueue
  }

  /** 归档:落 archivedAt 标记(观测方据此即隐)+ 解除成员 transcript 钉住 + 清活动态(落盘文件已留档) */
  async archive(): Promise<string | undefined> {
    if (!this.active) return undefined
    const runId = this.active.runId
    this.active.archivedAt = Date.now()
    await this.persist()
    getTaskRegistry().unpinTeamTranscripts(runId)
    this.active = undefined
    return runId
  }

  // ---------------- 花名册(内存同步操作 + 异步落盘) ----------------

  /**
   * 成员登记/流转(delegationTools 在预检通过后、registry.register 同点调用):
   * 有 standby 同名条目则复用(固定团队成员首次派活),否则新建(撞名自动派生 -2/-3 后缀)。
   * 返回实际条目与该成员信箱未读消息(任务 5 拼入种子的统一 drain 点)。
   */
  async registerMember(opts: { agent: string; role?: string; memberName?: string; taskId: string; depth?: number }): Promise<{ entry: RosterEntry; undelivered: TeamInboxMessage[] }> {
    const team = this.ensureAdHocTeam()
    const base = opts.memberName ?? opts.agent
    assertSafeMemberName(base)
    let entry = team.roster.find((e) => e.name === base && e.status === 'standby')
    if (!entry && base !== opts.agent) {
      // 角色名匹配(第二档):无同名 standby 时找同 agent 的 standby 条目复用并改名——
      // YAML 成员以模板名在册,Lead 常以角色名 member_name 派活;
      // 不复用会留下幽灵 standby + 重复条目(花名册 6 人实为 3 人的实测 bug)
      entry = team.roster.find((e) => e.agent === opts.agent && e.status === 'standby')
      if (entry) {
        const oldName = entry.name
        entry.name = base
        await this.migrateInboxOnRename(oldName, base)
      }
    }
    if (!entry) {
      entry = {
        name: this.uniqueMemberName(base, team.roster),
        agent: opts.agent,
        role: opts.role,
        status: 'standby',
        depth: opts.depth,
        joinedAt: Date.now(),
      }
      team.roster.push(entry)
      // 账本(迭代 3):新建条目才计数(standby 复用不占新名额)
      if (team.ledger) team.ledger.memberCount++
    }
    if (entry.depth === undefined && opts.depth !== undefined) entry.depth = opts.depth
    entry.status = 'running'
    entry.currentTaskId = opts.taskId
    this.enqueuePersist()
    const undelivered = await this.drainInbox(entry.name)
    return { entry, undelivered }
  }

  /** 账本 token 聚合(迭代 3):settle 统一回写点调用;无计量数据(null)时不入账,保持"未知"态语义;
   *  estimated 单向置位(任一笔估值则账本标估值,"先估值后实测"不误清) */
  addTokenSpend(tokens: number | undefined, estimated?: boolean): void {
    const team = this.active
    if (!team?.ledger || tokens === undefined || tokens <= 0) return
    team.ledger.spentTokens = (team.ledger.spentTokens ?? 0) + tokens
    if (estimated) team.ledger.estimated = true
    this.enqueuePersist()
  }

  /** 改名时迁移信箱:standby 期间按旧名收到的消息并入新名信箱(保序),删除旧文件;
   *  经 writeQueue 串行化(必须在先前排队的 append 之后执行,否则读到空旧信箱) */
  private async migrateInboxOnRename(oldName: string, newName: string): Promise<void> {
    if (!this.active || oldName === newName) return
    return this.enqueueMutation(async () => {
      const oldPath = `${this.dir}/${this.active!.runId}/inboxes/${oldName}.json`
      const oldMessages = await this.readInboxFile(oldPath)
      if (oldMessages.length === 0) return
      const newPath = `${this.dir}/${this.active!.runId}/inboxes/${newName}.json`
      const newMessages = await this.readInboxFile(newPath)
      await this.atomicWrite(newPath, JSON.stringify([...oldMessages, ...newMessages], null, 2))
      await this.fs.deleteFile(oldPath)
    }, { persist: false })
  }

  /** settle/cancel 回写(delegationTools 全部 settle 站点统一调用):completed/cancelled→idle,failed→failed;
   *  running 守卫:已离开 running 的条目幂等忽略(取消后 destroy 的二次 settle 不误覆写);
   *  同时解除该成员的唤醒中标记(teamMessageRouter 的防双重唤醒守卫);
   *  planPending 规则唯一:completed 且 requirePlan 才置真,其余 outcome 一律置假;
   *  认领人死亡/被取消时其进行中看板条目自动回流认领池(契约不烂在死人手里;实测教训:成员超时死掉后
   *  条目残留"进行中",队友空转等待) */
  syncOnTaskSettle(taskId: string, outcome: 'completed' | 'failed' | 'cancelled', transcriptKey?: string, requirePlan?: boolean, resultText?: string): void {
    const entry = this.active?.roster.find((e) => e.currentTaskId === taskId)
    if (!entry || entry.status !== 'running') return
    entry.status = outcome === 'failed' ? 'failed' : 'idle'
    if (transcriptKey) entry.transcriptKey = transcriptKey
    entry.planPending = outcome === 'completed' && requirePlan === true ? true : undefined
    this.wakingMembers.delete(entry.name)
    // 结项闭环/死亡回流板半边(收编 V4.1:薄委托 boardCore.onTaskSettle——零启发式同语义):
    // completed 且非计划阶段(阶段 1 完成 ≠ 活干完)→ 绑定本任务条目自动结项并标注;
    // failed/cancelled → 死亡回流(含 blocked 条目)+ 交付失败 failCount++,≥2 次停在 failed(待裁决)——
    // team 板同用 board 规则(现状无限回流→对齐 boardCore;行为变更见收编说明)
    if (!(outcome === 'completed' && requirePlan === true)) {
      this.withBoard(this.active!, (state) =>
        boardOnTaskSettleOp(state, taskId, outcome, outcome === 'completed' ? { result: resultText } : undefined),
      )
    }
    this.enqueuePersist()
  }

  // ---------------- 唤醒中守卫(teamMessageRouter 防双重唤醒;settle 时解除) ----------------

  private wakingMembers = new Set<string>()

  isWaking(member: string): boolean {
    return this.wakingMembers.has(member)
  }

  markWaking(member: string): void {
    this.wakingMembers.add(member)
  }

  unmarkWaking(member: string): void {
    this.wakingMembers.delete(member)
  }

  /** resume 续员:transcript 的 teamId/memberName 找回条目,重新置 running 并换绑新 taskId;
   *  返回是否续员成功与该成员信箱未读消息(任务 5 拼入种子的统一 drain 点) */
  async resumeMember(teamId: string, memberName: string, taskId: string): Promise<{ resumed: boolean; undelivered: TeamInboxMessage[] }> {
    if (!this.active || this.active.runId !== teamId) return { resumed: false, undelivered: [] }
    const entry = this.active.roster.find((e) => e.name === memberName)
    if (!entry) return { resumed: false, undelivered: [] }
    // 换绑前同步改绑看板绑定:进行中条目的 claimedByTaskId 从旧 taskId 改为新 taskId——
    // 否则 resume 续作完成时绑定失配,自动结项漏结(覆盖计划批准轮与一切 resume 续作链)
    const previousTaskId = entry.currentTaskId
    if (previousTaskId && previousTaskId !== taskId) {
      for (const item of this.active.board) {
        if (item.status === 'in_progress' && item.claimedByTaskId === previousTaskId) {
          item.claimedByTaskId = taskId
        }
      }
    }
    entry.status = 'running'
    entry.currentTaskId = taskId
    entry.planPending = undefined
    this.enqueuePersist()
    const undelivered = await this.drainInbox(memberName)
    return { resumed: true, undelivered }
  }

  // ---------------- 信箱(迭代 2;真相源,路由 = 投递尝试) ----------------

  private inboxPath(member: string): string {
    return `${this.dir}/${this.active!.runId}/inboxes/${member}.json`
  }

  /** 追加消息到成员信箱(串行化 read-modify-write;delivered=false 待投递;与 roster/board 快照无关) */
  async appendInbox(member: string, msg: TeamInboxMessage): Promise<void> {
    this.requireActive()
    return this.enqueueMutation(async () => {
      const path = this.inboxPath(member)
      const existing = await this.readInboxFile(path)
      existing.push(msg)
      await this.atomicWrite(path, JSON.stringify(existing, null, 2))
    }, { persist: false })
  }

  /** 读出该成员全部未读并标 delivered(拼入种子/唤醒即视为送达);无信箱文件返回空 */
  async drainInbox(member: string): Promise<TeamInboxMessage[]> {
    if (!this.active) return []
    return this.enqueueMutation(async () => {
      const path = this.inboxPath(member)
      const existing = await this.readInboxFile(path)
      const unread = existing.filter((m) => !m.delivered)
      if (unread.length === 0) return [] as TeamInboxMessage[]
      const marked = existing.map((m) => (m.delivered ? m : { ...m, delivered: true }))
      await this.atomicWrite(path, JSON.stringify(marked, null, 2))
      return unread as TeamInboxMessage[]
    }, { persist: false })
  }

  /** 各成员(含 lead)未读消息计数(team_status 用) */
  async unreadCounts(): Promise<Record<string, number>> {
    if (!this.active) return {}
    const members = [...this.active.roster.map((e) => e.name), 'lead']
    const counts: Record<string, number> = {}
    for (const member of members) {
      const existing = await this.readInboxFile(this.inboxPath(member))
      const n = existing.filter((m) => !m.delivered).length
      if (n > 0) counts[member] = n
    }
    return counts
  }

  /** steer 入队成功后标记该条已投(按 at 匹配;信箱串行化) */
  async markInboxDelivered(member: string, at: number): Promise<void> {
    if (!this.active) return
    return this.enqueueMutation(async () => {
      const path = this.inboxPath(member)
      const existing = await this.readInboxFile(path)
      if (!existing.some((m) => m.at === at && !m.delivered)) return
      await this.atomicWrite(
        path,
        JSON.stringify(existing.map((m) => (m.at === at ? { ...m, delivered: true } : m)), null, 2),
      )
    }, { persist: false })
  }

  private async readInboxFile(path: string): Promise<TeamInboxMessage[]> {
    const read = await this.fs.readFile(path)
    if (!read.success || !read.data) return []
    try {
      const parsed = JSON.parse(read.data.content) as unknown
      return Array.isArray(parsed) ? (parsed as TeamInboxMessage[]) : []
    } catch {
      return []
    }
  }

  // ---------------- 看板(收编 V4.1:薄委托 boardCore;落盘仍归 team persist 的 board.json) ----------------

  /** TeamCaller('lead'|成员名) → boardCore 结构化 caller */
  private boardCallerOf(caller: TeamCaller): BoardCaller {
    return caller === 'lead' ? { role: 'lead' } : { role: 'worker', assignee: caller }
  }

  /**
   * team 板容器 ↔ boardCore BoardState 互转(板变更唯一出入口;纯函数 op 后回写 board/boardRevision)。
   * 落盘归属不动:board.json 仍由本服务 persist(boardStore 只服务会话轻量板)。
   */
  private withBoard<T extends { state: BoardState }>(team: TeamRunState, op: (state: BoardState) => T): T {
    const state: BoardState = {
      boardId: team.runId,
      revision: team.boardRevision,
      items: team.board,
      createdAt: team.createdAt,
      updatedAt: Date.now(),
    }
    const res = op(state)
    team.board = res.state.items
    team.boardRevision = res.state.revision
    // 团队板变更广播（手机显示并集的触发源；与会话板 BOARD_CHANGED 分立；sessionId 缺省=旧数据，桥侧不推）
    eventBus.emit(EVENTS.TEAM_BOARD_CHANGED, {
      runId: team.runId,
      ...(team.sessionId !== undefined ? { sessionId: team.sessionId } : {}),
      revision: team.boardRevision,
    })
    return res
  }

  async boardPost(input: { title: string; description?: string; createdBy: TeamCaller; stagnationAfter?: number; parentTaskId?: string }): Promise<{ item: BoardItem; revision: number }> {
    const team = this.requireActive()
    return this.enqueueMutation(() => {
      const res = this.withBoard(team, (state) =>
        boardPostOp(state, {
          title: input.title,
          description: input.description,
          createdBy: input.createdBy,
          stagnationAfter: input.stagnationAfter,
          parentTaskId: input.parentTaskId,
        }),
      )
      return { item: res.item, revision: team.boardRevision }
    })
  }

  async boardClaim(id: string, caller: TeamCaller): Promise<{ item: BoardItem; revision: number }> {
    const team = this.requireActive()
    return this.enqueueMutation(() => {
      // 任务绑定(自动结项关联):成员记其 currentTaskId,lead 认领无绑定——绑定语义收编前后一致
      const claimedByTaskId = caller === 'lead' ? undefined : team.roster.find((e) => e.name === caller)?.currentTaskId
      const res = this.withBoard(team, (state) => boardClaimOp(state, id, { assignee: caller, claimedByTaskId }))
      return { item: res.item, revision: team.boardRevision }
    })
  }

  /**
   * 在既有团队板条目上开始一次尝试（M7 增量 2；与 SessionBoardService.attachAttempt 同形）。
   * `pending` → 认领（显式绑定 taskId + assignee=member）；`in_progress|blocked` → 换绑任务键（不动 assignee）；
   * `failed`(待裁决)/终态 → 响亮拒绝并指路（不越权改状态机）。
   * roster.currentTaskId 由 registerMember 在入队时已设（collab/admission.ts:154），此处只做板半边。
   */
  async attachAttempt(
    itemId: string,
    taskId: string,
    member: string,
    opts?: { takeOverFromTaskId?: string },
  ): Promise<BoardItem> {
    const team = this.requireActive()
    return this.enqueueMutation(() => {
      const current = team.board.find((i) => i.id === itemId)
      if (!current) {
        throw new BoardError('ITEM_NOT_FOUND', `看板条目 ${itemId} 不在团队板(${team.runId})`, itemId)
      }
      if (current.status === 'pending') {
        const res = this.withBoard(team, (state) =>
          boardClaimOp(state, itemId, { assignee: member, claimedByTaskId: taskId }),
        )
        return res.item
      }
      if (current.status === 'in_progress' || current.status === 'blocked') {
        // 同会话板纪律：只允许接管"自己这一次执行的旧键"（在途续跑），不许把别人的在途活改派
        if (current.claimedByTaskId && current.claimedByTaskId !== opts?.takeOverFromTaskId) {
          throw new BoardError(
            'INVALID_STATE',
            `看板条目 ${itemId}「${current.title}」正由 ${current.claimedByTaskId} 执行中，不能改派给另一个执行者。` +
              `若它已停/已死，请先 team_board release（退回池）清场，再带 board_item_id 重派。`,
            itemId,
          )
        }
        const res = this.withBoard(team, (state) => boardRebindClaimOp(state, itemId, taskId))
        return res.item
      }
      if (current.status === 'failed') {
        throw new BoardError(
          'INVALID_STATE',
          `看板条目 ${itemId}「${current.title}」处于待裁决(连续失败 ${current.failCount ?? 2} 次)。` +
            `请先 team_board adjudicate(id="${itemId}", decision="retry") 回池后再派活绑定；不要另起一行。`,
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

  /**
   * 更新(收编 V4.1:status 按 board 状态机映射等价操作;result 走 boardCore.update 归属+截断):
   * - 纯 result → boardCore.update;completed → settle completed(result 随带);
   * - failed → settle failed(交付失败:failCount++/死亡回流,≥2 停在 failed 待裁决);
   * - pending → release(置回待认领,留痕);in_progress → claim(仅 pending 可起)。
   * 归属门("仅认领人或 Lead 可更新")保留在本层:boardCore 的 settle/claim 是系统级状态机操作,
   * 无归属参数——不能经 status 映射绕过归属契约(防伪造用例锁定)。
   */
  async boardUpdate(
    id: string,
    caller: TeamCaller,
    patch: { status?: BoardItemStatus; result?: string },
  ): Promise<{ item: BoardItem; revision: number; resultTruncated?: boolean }> {
    const team = this.requireActive()
    return this.enqueueMutation(() => {
      const current = team.board.find((i) => i.id === id)
      if (!current) {
        const known = team.board.map((i) => i.id).join(', ') || '(空)'
        throw new Error(`看板条目 ${id} 不存在。现有条目: ${known}`)
      }
      if (caller !== 'lead' && current.assignee !== caller) {
        throw new Error(`看板条目 ${id} ${current.assignee ? `由 ${current.assignee} 认领` : '尚无人认领'},仅认领人或 Lead 可更新`)
      }
      let resultTruncated: boolean | undefined
      const finish = (item: BoardItem) => ({
        item,
        revision: team.boardRevision,
        ...(resultTruncated !== undefined ? { resultTruncated } : {}),
      })
      if (patch.status === undefined || patch.status === 'failed') {
        // result 书写(归属+4KB 截断由 boardCore 把关);failed 携带 result 时先写结果再按失败结算
        if (patch.result !== undefined) {
          const u = this.withBoard(team, (state) => boardUpdateOp(state, id, { result: patch.result }, this.boardCallerOf(caller)))
          resultTruncated = u.resultTruncated
          if (patch.status === undefined) return finish(u.item)
        } else if (patch.status === undefined) {
          return finish(this.withBoard(team, (state) => boardUpdateOp(state, id, {}, this.boardCallerOf(caller))).item)
        }
        const s = this.withBoard(team, (state) => boardSettleOp(state, id, 'failed'))
        return finish(s.item)
      }
      if (patch.status === 'completed') {
        const s = this.withBoard(team, (state) => boardSettleOp(state, id, 'completed', { result: patch.result }))
        resultTruncated = s.resultTruncated
        return finish(s.item)
      }
      if (patch.status === 'pending') {
        const r = this.withBoard(team, (state) => boardReleaseOp(state, id, { by: caller, reason: '经 update 置回待认领' }))
        return finish(r.item)
      }
      // 'in_progress':pending → 起活(claim 同语义)
      const claimedByTaskId = caller === 'lead' ? undefined : team.roster.find((e) => e.name === caller)?.currentTaskId
      const c = this.withBoard(team, (state) => boardClaimOp(state, id, { assignee: caller, claimedByTaskId }))
      return finish(c.item)
    })
  }

  async boardRemove(id: string, caller: TeamCaller): Promise<{ revision: number }> {
    const team = this.requireActive()
    return this.enqueueMutation(() => {
      this.withBoard(team, (state) => boardRemoveOp(state, id, this.boardCallerOf(caller)))
      return { revision: team.boardRevision }
    })
  }

  /**
   * 退回归领池(迭代 2 release;收编 V4.1 对齐 boardCore 三清):
   * 仅进行中条目可退回;仅认领人或 Lead;状态回流 pending + 清 assignee/claimedAt/**claimedByTaskId**
   * + releaseHistory 留痕(watchdog 冲突检测读它:同一条目 release ≥2 次)。
   * 已知差异对齐:旧实现不清 claimedByTaskId,收编后清——残留绑定会让换绑/自动结项误配。
   */
  async boardRelease(
    id: string,
    caller: TeamCaller,
    patch: { reason: string; suggestedTo?: string },
  ): Promise<{ item: BoardItem; revision: number; previousAssignee?: string }> {
    const team = this.requireActive()
    return this.enqueueMutation(() => {
      const res = this.withBoard(team, (state) =>
        boardReleaseOp(state, id, { by: caller, reason: patch.reason, suggestedTo: patch.suggestedTo }),
      )
      return { item: res.item, revision: team.boardRevision, previousAssignee: res.previousAssignee }
    })
  }

  /** 裁决(收编 V4.1;仅 Lead——boardCore assertLead 结构性拒绝非 Lead):retry=回池(failCount 不清零)/cancel=终止 */
  async boardAdjudicate(
    id: string,
    decision: 'cancel' | 'retry',
    caller: TeamCaller,
  ): Promise<{ item: BoardItem; revision: number }> {
    const team = this.requireActive()
    return this.enqueueMutation(() => {
      const res = this.withBoard(team, (state) => boardAdjudicateOp(state, id, decision, this.boardCallerOf(caller)))
      return { item: res.item, revision: team.boardRevision }
    })
  }

  // ---------------- 内部 ----------------

  private requireActive(): TeamRunState {
    if (!this.active) {
      throw new Error('当前没有活动团队。成队方式:use_team 激活固定团队,或 task/batch_task 带 as_teammate:true 组建临时团队。')
    }
    return this.active
  }

  private uniqueMemberName(base: string, roster: RosterEntry[]): string {
    if (!roster.some((e) => e.name === base)) return base
    let n = 2
    while (roster.some((e) => e.name === `${base}-${n}`)) n++
    return `${base}-${n}`
  }

  /** mutation 串行化:先变更内存/文件,成功后按需落盘 roster/board 快照(信箱操作与快照无关,跳过) */
  private enqueueMutation<T>(fn: () => T | Promise<T>, opts?: { persist?: boolean }): Promise<T> {
    const persist = opts?.persist !== false
    const result = this.writeQueue.then(fn)
    this.writeQueue = result.then(
      () => (persist ? this.persist().catch((err) => console.warn('【团队】运行态快照写入失败:', err)) : undefined),
      () => undefined,
    )
    // 变更通知(迭代 4 watchdog 订阅):persist 入队后串行触发;返回值仍是 mutation 本身的结果
    this.writeQueue = this.writeQueue.then(() => this.fireChange())
    return result
  }

  /** 纯落盘(花名册变更等同步操作后调用) */
  private enqueuePersist(): void {
    this.writeQueue = this.writeQueue.then(() =>
      this.persist().catch((err) => console.warn('【团队】运行态快照写入失败:', err)),
    )
    this.writeQueue = this.writeQueue.then(() => this.fireChange())
  }

  /** 快照:roster.json / board.json 自描述(含 runId/队名/时间戳,归档可读) */
  private async persist(): Promise<void> {
    const team = this.active
    if (!team) return
    const base = `${this.dir}/${team.runId}`
    await this.atomicWrite(
      `${base}/roster.json`,
      JSON.stringify({ runId: team.runId, name: team.name, createdAt: team.createdAt, roster: team.roster }, null, 2),
    )
    await this.atomicWrite(
      `${base}/board.json`,
      JSON.stringify({ runId: team.runId, boardRevision: team.boardRevision, board: team.board }, null, 2),
    )
    await this.atomicWrite(
      `${base}/snapshot.json`,
      JSON.stringify(
        { runId: team.runId, snapshot: team.snapshot, ledger: team.ledger, hostPid: team.hostPid, archivedAt: team.archivedAt },
        null,
        2,
      ),
    )
  }

  /** 原子写(tmp+rename;宿主无 renameFile 时退化直写) */
  private async atomicWrite(path: string, content: string): Promise<void> {
    if (this.fs.renameFile) {
      const tmp = `${path}.tmp`
      const write = await this.fs.writeFile(tmp, content)
      if (!write.success) throw new Error(write.error ?? '团队运行态写入失败')
      const renamed = await this.fs.renameFile(tmp, path)
      if (!renamed.success) throw new Error(renamed.error ?? '团队运行态改名失败')
      return
    }
    const write = await this.fs.writeFile(path, content)
    if (!write.success) throw new Error(write.error ?? '团队运行态写入失败')
  }
}

// ---------- 进程级单例访问器(双壳各自装配;仿 TeamTemplateService) ----------

let runtimeService: TeamRuntimeService | undefined

export function setTeamRuntimeService(svc: TeamRuntimeService): void {
  runtimeService = svc
}

/** 团队运行时访问器(未装配时返回 undefined,调用方降级或响亮报错) */
export function getTeamRuntimeService(): TeamRuntimeService | undefined {
  return runtimeService
}

/** 重置单例(主要用于测试) */
export function resetTeamRuntimeService(): void {
  runtimeService = undefined
}
