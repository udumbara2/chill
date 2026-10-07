import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import type { SessionBoardStore } from '../../src/services/board/boardStore.ts'
import type { BoardState } from '../../src/services/board/boardTypes.ts'

/**
 * SessionBoardStore 端口契约测试（UI IPC store 的 core 侧替身）：
 * electron 测试设施缺失（packages/electron 无 test script），故在 core 侧锁定端口契约——
 * ElectronIPCBoardStore 只要把 load/save/exists/archiveBoard 四口按本契约转发到主进程
 * BoardStore 即自动获得同语义（该替身额外走 JSON 结构化克隆往返,模拟 IPC 序列化边界）。
 */
class IpcShapedStore implements SessionBoardStore {
  /** 模拟主进程侧的落盘（结构化克隆=JSON 往返,undefined 字段丢失——与 ipcRenderer.invoke 同边界） */
  private disk = new Map<string, string>()
  calls: string[] = []

  private clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v ?? null)) as T
  }

  async load(boardId: string): Promise<BoardState | undefined> {
    this.calls.push(`load:${boardId}`)
    const raw = this.disk.get(boardId)
    return raw ? this.clone(JSON.parse(raw)) : undefined
  }

  async save(state: BoardState): Promise<void> {
    this.calls.push(`save:${state.boardId}`)
    this.disk.set(state.boardId, JSON.stringify(this.clone(state)))
  }

  async exists(boardId: string): Promise<boolean> {
    this.calls.push(`exists:${boardId}`)
    return this.disk.has(boardId)
  }

  async archiveBoard(boardId: string, reason: string): Promise<BoardState> {
    this.calls.push(`archive:${boardId}:${reason}`)
    const raw = this.disk.get(boardId)
    if (!raw) throw new Error('board not found')
    const state = JSON.parse(raw) as BoardState
    for (const item of state.items) {
      if (item.status === 'completed' || item.status === 'cancelled') continue
      item.status = 'cancelled'
      item.releaseHistory = [
        ...(item.releaseHistory ?? []),
        { by: 'system', reason: `看板归档:${reason}`, at: Date.now() },
      ]
      item.updatedAt = Date.now()
    }
    state.archivedAt = Date.now()
    state.archiveReason = reason
    this.disk.set(boardId, JSON.stringify(state))
    return this.clone(state)
  }
}

async function setup(t: TestContext): Promise<{ svc: SessionBoardService; store: IpcShapedStore }> {
  const store = new IpcShapedStore()
  const svc = new SessionBoardService(store)
  setSessionBoardService(svc)
  t.after(() => resetSessionBoardService())
  return { svc, store }
}

test('端口契约:save/load 经 JSON 克隆往返语义不变(IPC 序列化边界)', async (t) => {
  const { svc, store } = await setup(t)
  await svc.post('sess-1', { title: '挂项', createdBy: 'lead', note: '进展' })
  await svc.claim('sess-1', (await svc.readBoard('sess-1')).items[0]!.id, { assignee: 'explore·A', claimedByTaskId: 'tc-1' })
  assert.ok(store.calls.some((c) => c.startsWith('save:sess-1')))

  svc.reset() // 只留"主进程侧"落盘
  const restored = await svc.readBoard('sess-1')
  assert.equal(restored.items.length, 1)
  assert.equal(restored.items[0]!.assignee, 'explore·A')
  assert.equal(restored.items[0]!.status, 'in_progress')
  assert.equal(svc.workstationOf('sess-1', 'tc-1'), 'explore·A')
})

test('端口契约:exists/archive 语义(在途留痕、归档标记)', async (t) => {
  const { svc, store } = await setup(t)
  assert.equal(await store.exists('sess-1'), false)
  await svc.post('sess-1', { title: '在途', createdBy: 'lead' })
  assert.equal(await store.exists('sess-1'), true)

  await svc.archive('sess-1', '会话删除')
  assert.ok(store.calls.includes('archive:sess-1:会话删除'))
  const board = await svc.readBoard('sess-1')
  assert.equal(board.items[0]!.status, 'cancelled')
  assert.match(board.items[0]!.releaseHistory!.at(-1)!.reason, /看板归档:会话删除/)
})

test('端口契约:settle 桥按 claimedByTaskId 结项(绑定键过克隆边界仍在)', async (t) => {
  const { svc, store } = await setup(t)
  await svc.autoPostAndClaim({ sessionId: 'sess-1', batchId: 'b1', taskId: 'tc-1', subagentType: 'explore', title: '活' })
  assert.ok(store.calls.some((c) => c.startsWith('save:')))
  await svc.settleByTaskId('tc-1', 'completed', { result: '交付' })
  const items = (await svc.readBoard('sess-1')).items
  assert.equal(items[0]!.status, 'completed')
  assert.match(items[0]!.result!, /自动结项:认领人任务交付/)
})
