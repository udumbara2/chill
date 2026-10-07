/**
 * 共享看板 · 纯 mutation 状态机
 *
 * 纪律:纯函数(输入状态不被修改,每次操作产出新状态 + 变更结果)、无 Node I/O、不 import roster;
 *   caller 角色参数化({role:'lead'} | {role:'worker', assignee}),归属判定只看条目 assignee,零启发式;
 *   每次操作 revision++(全局 CAS 单调);result/note 超 4KB 截断并明示;
 *   归属约束/状态机拒绝一律抛 BoardError(结构化错误)。
 * 语义移植自 TeamRuntimeService 的 boardPost/Claim/Update/Remove/Release 与 syncOnTaskSettle 板半边
 * (team 运行时收编本实现是 V4.1 的事,本文件是并行新实现)。
 */

import {
  BoardError,
  capBoardText,
  type BoardAdjudication,
  type BoardCaller,
  type BoardItem,
  type BoardItemStatus,
  type BoardReleaseEntry,
  type BoardSettleOutcome,
  type BoardState,
} from './boardTypes'

const TERMINAL: ReadonlySet<BoardItemStatus> = new Set<BoardItemStatus>(['completed', 'cancelled'])

function makeItemId(): string {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function isTerminal(status: BoardItemStatus): boolean {
  return TERMINAL.has(status)
}

function requireItem(state: BoardState, itemId: string): BoardItem {
  const item = state.items.find((i) => i.id === itemId)
  if (!item) {
    const known = state.items.map((i) => i.id).join(', ') || '(空)'
    throw new BoardError('ITEM_NOT_FOUND', `看板条目 ${itemId} 不存在。现有条目: ${known}`, itemId)
  }
  return item
}

function assertOwnership(caller: BoardCaller, item: BoardItem, action: string): void {
  const ok = caller.role === 'lead' || (caller.role === 'worker' && item.assignee === caller.assignee)
  if (!ok) {
    throw new BoardError(
      'FORBIDDEN',
      `看板条目 ${item.id} ${item.assignee ? `由 ${item.assignee} 认领` : '尚无人认领'},仅认领人或 Lead 可${action}`,
      item.id,
    )
  }
}

function assertLead(caller: BoardCaller, action: string, itemId?: string): void {
  if (caller.role !== 'lead') {
    throw new BoardError('FORBIDDEN', `仅 Lead 可${action}`, itemId)
  }
}

function appendHistory(item: BoardItem, entry: BoardReleaseEntry): BoardItem {
  return { ...item, releaseHistory: [...(item.releaseHistory ?? []), entry] }
}

/** 建空板 */
export function createBoard(boardId: string, at: number = Date.now()): BoardState {
  return { boardId, revision: 0, items: [], createdAt: at, updatedAt: at }
}

/** 全量条目读(条目浅拷贝,防外部改写内存真相) */
export function read(state: BoardState): { revision: number; items: BoardItem[] } {
  return { revision: state.revision, items: state.items.map((i) => ({ ...i })) }
}

export interface PostInput {
  title: string
  description?: string
  batchId?: string
  createdBy: string
  note?: string
  /** 静默容忍声明(分钟;watchdog 停滞检测读它)——纯透传输入,V4.1 team 收编所需,零状态机变化 */
  stagnationAfter?: number
  /** 分解链(=清单项 id)——纯透传输入,零状态机变化(投影层消费) */
  parentTaskId?: string
}

/** 挂项:新条目 status=pending(人人可挂) */
export function post(
  state: BoardState,
  input: PostInput,
): { state: BoardState; item: BoardItem; revision: number; noteTruncated?: boolean } {
  if (!input.title || !input.title.trim()) {
    throw new BoardError('INVALID_INPUT', '看板挂项缺少 title')
  }
  const now = Date.now()
  const cappedNote = input.note !== undefined ? capBoardText(input.note) : undefined
  const item: BoardItem = {
    id: makeItemId(),
    title: input.title,
    description: input.description,
    status: 'pending',
    createdBy: input.createdBy,
    batchId: input.batchId,
    note: cappedNote?.value,
    stagnationAfter: input.stagnationAfter,
    parentTaskId: input.parentTaskId,
    createdAt: now,
    updatedAt: now,
  }
  const next = { ...state, items: [...state.items, item], revision: state.revision + 1, updatedAt: now }
  return { state: next, item, revision: next.revision, noteTruncated: cappedNote?.truncated }
}

/** 认领:仅 pending 可领 → in_progress;写 claimedAt;claim 原子防重(已认领/非 pending 一律报错) */
export function claim(
  state: BoardState,
  itemId: string,
  input: { assignee: string; claimedByTaskId?: string },
): { state: BoardState; item: BoardItem; revision: number } {
  if (!input.assignee || !input.assignee.trim()) {
    throw new BoardError('INVALID_INPUT', '认领缺少 assignee(工位名)', itemId)
  }
  const current = requireItem(state, itemId)
  if (current.status !== 'pending') {
    throw new BoardError(
      'NOT_CLAIMABLE',
      `看板条目 ${itemId} 不可认领(当前状态 ${current.status}${current.assignee ? `,已由 ${current.assignee} 认领` : ''})`,
      itemId,
    )
  }
  const now = Date.now()
  const items = state.items.map((i) =>
    i.id === itemId
      ? {
          ...i,
          status: 'in_progress' as const,
          assignee: input.assignee,
          claimedByTaskId: input.claimedByTaskId,
          claimedAt: now,
          updatedAt: now,
        }
      : i,
  )
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, item: items.find((i) => i.id === itemId)!, revision: next.revision }
}

/**
 * 换绑任务键(V3.1 拉活续跑:意图条目→新执行绑定;照 TeamRuntimeService.resumeMember 换绑先例)。
 * 仅数据改绑不动状态机;要求条目在途(in_progress/blocked)且无旧绑定或旧绑定由调用方判定。
 * 这不改 6 态语义——claimedByTaskId 本就是"认领时的任务绑定",换绑是它的既有生命周期(V1 注释即言)。
 */
export function rebindClaim(
  state: BoardState,
  itemId: string,
  claimedByTaskId: string,
): { state: BoardState; item: BoardItem; revision: number } {
  const current = requireItem(state, itemId)
  if (current.status !== 'in_progress' && current.status !== 'blocked') {
    throw new BoardError('INVALID_STATE', `看板条目 ${itemId} 不可换绑(当前状态 ${current.status})`, itemId)
  }
  if (!claimedByTaskId || !claimedByTaskId.trim()) {
    throw new BoardError('INVALID_INPUT', '换绑需要非空任务键', itemId)
  }
  const now = Date.now()
  const items = state.items.map((i) => (i.id === itemId ? { ...i, claimedByTaskId, updatedAt: now } : i))
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, item: items.find((i) => i.id === itemId)!, revision: next.revision }
}

export interface UpdatePatch {
  note?: string
  result?: string
  stagnationAfter?: number
}

/** 更新进展/结果/静默容忍:仅认领人或 Lead;note=最新进展(4KB 截断同 result) */
export function update(
  state: BoardState,
  itemId: string,
  patch: UpdatePatch,
  caller: BoardCaller,
): { state: BoardState; item: BoardItem; revision: number; noteTruncated?: boolean; resultTruncated?: boolean } {
  const current = requireItem(state, itemId)
  assertOwnership(caller, current, '更新')
  const now = Date.now()
  const cappedNote = patch.note !== undefined ? capBoardText(patch.note) : undefined
  const cappedResult = patch.result !== undefined ? capBoardText(patch.result) : undefined
  const items = state.items.map((i) => {
    if (i.id !== itemId) return i
    const nextItem: BoardItem = { ...i, updatedAt: now }
    if (cappedNote) nextItem.note = cappedNote.value
    if (cappedResult) nextItem.result = cappedResult.value
    if (patch.stagnationAfter !== undefined) nextItem.stagnationAfter = patch.stagnationAfter
    return nextItem
  })
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return {
    state: next,
    item: items.find((i) => i.id === itemId)!,
    revision: next.revision,
    noteTruncated: cappedNote?.truncated,
    resultTruncated: cappedResult?.truncated,
  }
}

/**
 * 退回归领池:仅 in_progress 可退回;仅认领人或 Lead(by='lead' 或 by===assignee);
 * 回 pending + 清 assignee/claimedAt/claimedByTaskId + releaseHistory 留痕。
 */
export function release(
  state: BoardState,
  itemId: string,
  input: { by: string; reason: string; suggestedTo?: string },
): { state: BoardState; item: BoardItem; revision: number; previousAssignee?: string } {
  const current = requireItem(state, itemId)
  if (!input.reason || !input.reason.trim()) {
    throw new BoardError('INVALID_INPUT', '退回必须填写原因', itemId)
  }
  if (current.status !== 'in_progress') {
    throw new BoardError('INVALID_STATE', `看板条目 ${itemId} 仅"进行中"可退回(当前状态 ${current.status})`, itemId)
  }
  if (input.by !== 'lead' && input.by !== current.assignee) {
    throw new BoardError(
      'FORBIDDEN',
      `看板条目 ${itemId} 由 ${current.assignee ?? '无人'} 认领,仅认领人或 Lead 可退回`,
      itemId,
    )
  }
  const now = Date.now()
  const previousAssignee = current.assignee
  const items = state.items.map((i) => {
    if (i.id !== itemId) return i
    return {
      ...appendHistory(i, { by: input.by, reason: input.reason, suggestedTo: input.suggestedTo, at: now }),
      status: 'pending' as const,
      assignee: undefined,
      claimedAt: undefined,
      claimedByTaskId: undefined,
      updatedAt: now,
    }
  })
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, item: items.find((i) => i.id === itemId)!, revision: next.revision, previousAssignee }
}

/** 删除条目:仅 Lead */
export function remove(state: BoardState, itemId: string, caller: BoardCaller): { state: BoardState; revision: number } {
  requireItem(state, itemId)
  assertLead(caller, '删除看板条目', itemId)
  const now = Date.now()
  const items = state.items.filter((i) => i.id !== itemId)
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, revision: next.revision }
}

/**
 * 受阻(状态机入 blocked 的口;规格列了 unblock 未列 block,状态机必须有进 blocked 的转移,故补此操作):
 * 仅认领人或 Lead;仅 in_progress → blocked;reason 写入 note=受阻原因。
 */
export function block(
  state: BoardState,
  itemId: string,
  input: { reason: string },
  caller: BoardCaller,
): { state: BoardState; item: BoardItem; revision: number } {
  const current = requireItem(state, itemId)
  assertOwnership(caller, current, '置为需拍板')
  if (current.status !== 'in_progress') {
    throw new BoardError('INVALID_STATE', `看板条目 ${itemId} 仅"进行中"可置为需拍板(当前状态 ${current.status})`, itemId)
  }
  const now = Date.now()
  const capped = capBoardText(input.reason ?? '')
  const items = state.items.map((i) =>
    i.id === itemId ? { ...i, status: 'blocked' as const, note: capped.value, updatedAt: now } : i,
  )
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, item: items.find((i) => i.id === itemId)!, revision: next.revision }
}

/** 解除受阻:blocked → in_progress(ask 回答/跳过/Lead 拍板共用);仅认领人或 Lead */
export function unblock(state: BoardState, itemId: string, caller: BoardCaller): { state: BoardState; item: BoardItem; revision: number } {
  const current = requireItem(state, itemId)
  assertOwnership(caller, current, '解除需拍板')
  if (current.status !== 'blocked') {
    throw new BoardError('INVALID_STATE', `看板条目 ${itemId} 仅"需拍板"可解除(当前状态 ${current.status})`, itemId)
  }
  const now = Date.now()
  const items = state.items.map((i) =>
    i.id === itemId ? { ...i, status: 'in_progress' as const, updatedAt: now } : i,
  )
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, item: items.find((i) => i.id === itemId)!, revision: next.revision }
}

/** 裁决(failed=待裁决条目;仅 Lead):cancel=cancelled 终态 / retry=pending 回池(failCount 不清零) */
export function adjudicate(
  state: BoardState,
  itemId: string,
  decision: BoardAdjudication,
  caller: BoardCaller,
): { state: BoardState; item: BoardItem; revision: number } {
  const current = requireItem(state, itemId)
  assertLead(caller, '裁决看板条目', itemId)
  if (current.status !== 'failed') {
    throw new BoardError('INVALID_STATE', `看板条目 ${itemId} 仅"待裁决"可裁决(当前状态 ${current.status})`, itemId)
  }
  const now = Date.now()
  const items = state.items.map((i) => {
    if (i.id !== itemId) return i
    const entry: BoardReleaseEntry = {
      by: 'lead',
      reason: decision === 'cancel' ? '裁决:取消,条目终止' : '裁决:重试,条目回流认领池(失败计数保留)',
      at: now,
    }
    const withHistory = appendHistory(i, entry)
    if (decision === 'cancel') {
      return { ...withHistory, status: 'cancelled' as const, updatedAt: now }
    }
    return {
      ...withHistory,
      status: 'pending' as const,
      assignee: undefined,
      claimedAt: undefined,
      claimedByTaskId: undefined,
      updatedAt: now,
    }
  })
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, item: items.find((i) => i.id === itemId)!, revision: next.revision }
}

/** 撤单(用户撤单/会话删除/归档清场):任意非终态 → cancelled 留痕 */
export function cancelItem(
  state: BoardState,
  itemId: string,
  input: { by: string; reason: string },
): { state: BoardState; item: BoardItem; revision: number } {
  const current = requireItem(state, itemId)
  if (isTerminal(current.status)) {
    throw new BoardError('INVALID_STATE', `看板条目 ${itemId} 已是终态(${current.status}),不可撤单`, itemId)
  }
  const now = Date.now()
  const items = state.items.map((i) => {
    if (i.id !== itemId) return i
    return {
      ...appendHistory(i, { by: input.by, reason: input.reason || '撤单', at: now }),
      status: 'cancelled' as const,
      updatedAt: now,
    }
  })
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, item: items.find((i) => i.id === itemId)!, revision: next.revision }
}

// ---------------- 结项 / 死亡回流 ----------------

function freezeOrReflow(item: BoardItem, now: number): BoardItem {
  // 交付失败:失败记录 + failCount++;≥2 置 failed(待裁决)停留,否则回流认领池
  const failCount = (item.failCount ?? 0) + 1
  const stuck = failCount >= 2
  const withCount: BoardItem = { ...item, failCount, updatedAt: now }
  const withHistory = appendHistory(withCount, {
    by: 'system',
    reason: stuck ? `交付失败(第 ${failCount} 次),失败待裁决` : `交付失败(第 ${failCount} 次),条目自动回流认领池`,
    at: now,
  })
  if (stuck) return { ...withHistory, status: 'failed' }
  return {
    ...withHistory,
    status: 'pending',
    assignee: undefined,
    claimedAt: undefined,
    claimedByTaskId: undefined,
  }
}

function deathReflow(item: BoardItem, outcome: BoardSettleOutcome, now: number): BoardItem {
  // 非交付失败的死亡回流:blocked 附「认领人已死」记录,进行中沿用 team 措辞
  const reason =
    item.status === 'blocked'
      ? '认领人已死,受阻条目自动回流认领池'
      : `认领人任务${outcome === 'failed' ? '失败' : '被取消'},条目自动回流认领池`
  const withHistory = appendHistory({ ...item, updatedAt: now }, { by: 'system', reason, at: now })
  return {
    ...withHistory,
    status: 'pending',
    assignee: undefined,
    claimedAt: undefined,
    claimedByTaskId: undefined,
  }
}

function autoDeliver(item: BoardItem, resultText: string | undefined, now: number): BoardItem {
  // 自动结项(认领人任务交付):result 标注「(自动结项:认领人任务交付)」
  const body = resultText ?? ''
  const capped = capBoardText(body)
  return {
    ...item,
    status: 'completed',
    result: `${capped.value}\n(自动结项:认领人任务交付)`,
    updatedAt: now,
  }
}

/**
 * 死亡回流引擎(纯):死掉的工位(们)的 in_progress 与 blocked 条目一并回 pending;
 * failedIds(交付失败的条目,仅限 in_progress 时刻)走 failCount 通道,≥2 停留 failed 待裁决。
 */
function applyDeathReflow(
  items: BoardItem[],
  opts: { targets: (item: BoardItem) => boolean; failedIds: ReadonlySet<string>; outcome: BoardSettleOutcome; now: number },
): { items: BoardItem[]; reflowedIds: string[]; frozenIds: string[] } {
  const reflowedIds: string[] = []
  const frozenIds: string[] = []
  const next = items.map((i) => {
    if (!opts.targets(i)) return i
    const isFailedDelivery = opts.outcome === 'failed' && opts.failedIds.has(i.id) && i.status === 'in_progress'
    const updated = isFailedDelivery ? freezeOrReflow(i, opts.now) : deathReflow(i, opts.outcome, opts.now)
    if (updated.status === 'failed') frozenIds.push(i.id)
    else reflowedIds.push(i.id)
    return updated
  })
  return { items: next, reflowedIds, frozenIds }
}

export interface SettleResult {
  state: BoardState
  item: BoardItem
  revision: number
  resultTruncated?: boolean
  reflowedIds: string[]
  frozenIds: string[]
}

/**
 * 条目结项:completed=交付结项(写 result);failed/cancelled=死亡回流——
 * 该 assignee 的 in_progress 与 blocked 条目一并回 pending(blocked 附「认领人已死」记录);
 * failed 的条目(仅 in_progress 时刻)记失败记录 + failCount++,≥2 置 failed 待裁决停留(不再回流)。
 */
export function settle(
  state: BoardState,
  itemId: string,
  outcome: BoardSettleOutcome,
  opts?: { result?: string },
): SettleResult {
  const current = requireItem(state, itemId)
  if (current.status !== 'in_progress' && current.status !== 'blocked') {
    throw new BoardError('INVALID_STATE', `看板条目 ${itemId} 不可结项(当前状态 ${current.status})`, itemId)
  }
  const now = Date.now()
  if (outcome === 'completed') {
    const capped = opts?.result !== undefined ? capBoardText(opts.result) : undefined
    const items = state.items.map((i) => {
      if (i.id !== itemId) return i
      const nextItem: BoardItem = { ...i, status: 'completed', updatedAt: now }
      if (capped) nextItem.result = capped.value
      return nextItem
    })
    const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
    return {
      state: next,
      item: items.find((i) => i.id === itemId)!,
      revision: next.revision,
      resultTruncated: capped?.truncated,
      reflowedIds: [],
      frozenIds: [],
    }
  }
  const dead = current.assignee ? new Set([current.assignee]) : new Set<string>()
  const failedIds = new Set([itemId])
  const { items, reflowedIds, frozenIds } = applyDeathReflow(state.items, {
    targets: (i) =>
      i.id === itemId || (!!i.assignee && dead.has(i.assignee) && (i.status === 'in_progress' || i.status === 'blocked')),
    failedIds,
    outcome,
    now,
  })
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return {
    state: next,
    item: items.find((i) => i.id === itemId)!,
    revision: next.revision,
    reflowedIds,
    frozenIds,
  }
}

export interface OnTaskSettleResult {
  state: BoardState
  revision: number
  /** 自动结项的条目(completed 路径) */
  settledIds: string[]
  reflowedIds: string[]
  frozenIds: string[]
}

/**
 * 任务 settle 的看板批量钩子(claimedByTaskId 数据匹配,零启发式;lead 认领无绑定不动):
 * - completed:绑定本任务的 in_progress 条目自动结项,result 标注「(自动结项:认领人任务交付)」;
 * - failed/cancelled:绑定工位死亡回流——该 assignee 的 in_progress 与 blocked 一并回 pending;
 *   failed 时绑定的 in_progress 条目=交付失败(失败记录 + failCount++,≥2 置 failed 待裁决)。
 */
export function onTaskSettle(
  state: BoardState,
  taskId: string,
  outcome: BoardSettleOutcome,
  opts?: { result?: string },
): OnTaskSettleResult {
  const bound = state.items.filter((i) => i.claimedByTaskId === taskId)
  const now = Date.now()
  if (outcome === 'completed') {
    const settledIds: string[] = []
    const items = state.items.map((i) => {
      if (i.claimedByTaskId !== taskId || i.status !== 'in_progress') return i
      settledIds.push(i.id)
      return autoDeliver(i, opts?.result, now)
    })
    const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
    return { state: next, revision: next.revision, settledIds, reflowedIds: [], frozenIds: [] }
  }
  const dead = new Set(bound.map((i) => i.assignee).filter((a): a is string => !!a))
  const failedIds = new Set(bound.filter((i) => i.status === 'in_progress').map((i) => i.id))
  const boundIds = new Set(bound.filter((i) => i.status === 'in_progress' || i.status === 'blocked').map((i) => i.id))
  const { items, reflowedIds, frozenIds } = applyDeathReflow(state.items, {
    targets: (i) =>
      boundIds.has(i.id) || (!!i.assignee && dead.has(i.assignee) && (i.status === 'in_progress' || i.status === 'blocked')),
    failedIds,
    outcome,
    now,
  })
  const next = { ...state, items, revision: state.revision + 1, updatedAt: now }
  return { state: next, revision: next.revision, settledIds: [], reflowedIds, frozenIds }
}
