import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionBoardService,
  resetSessionBoardService,
  setSessionBoardService,
} from '../../src/services/board/SessionBoardService.ts'
import { BoardStore } from '../../src/services/board/boardStore.ts'
import { wireBoardAskBridge } from '../../src/services/board/boardAskBridge.ts'
import { executeBoard } from '../../src/services/board/boardTool.ts'
import { buildBoardProgressText } from '../../src/services/board/boardProjection.ts'
import { BoardError } from '../../src/services/board/boardTypes.ts'
import { getAskChannel, resetAskChannel, type AskRequestPayload } from '../../src/services/askChannel.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

/**
 * V3.2 ask↔条目四路联动 + V3.3 裁决三出口锁死 + V3.4 worker 发帖:
 * 挂起→blocked / 落定→unblock / 跳过→unblock(决策 7a') / 认领人死亡→ask 失效。
 */

async function setup(t: TestContext): Promise<{ svc: SessionBoardService; off: () => void }> {
  const dir = await mkdtemp(join(tmpdir(), 'board-ask-'))
  const svc = new SessionBoardService(new BoardStore(dir))
  setSessionBoardService(svc)
  resetAskChannel()
  const off = wireBoardAskBridge()
  t.after(async () => {
    off()
    resetAskChannel()
    resetSessionBoardService()
    await rm(dir, { recursive: true, force: true })
  })
  return { svc, off }
}

const tick = () => new Promise((r) => setTimeout(r, 25))

/** 联动是 void 异步链(事件桥→板 mutation→落盘):满负载下 25ms 不够,有界轮询断言 */
async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > 3000) throw new Error(`waitFor 超时: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function askFor(itemId: string, question: string): Promise<{ id: string; answer: Promise<string> }> {
  let id = ''
  const capture = (p: AskRequestPayload) => {
    id = p.id
  }
  eventBus.on(EVENTS.ASK_REQUESTED, capture)
  const answer = getAskChannel().ask(question, undefined, true, undefined, { sessionId: 'sess-1', itemId, taskId: 'tc-1' })
  await tick()
  eventBus.off(EVENTS.ASK_REQUESTED, capture)
  return { id, answer }
}

test('ask↔条目:挂起→blocked(reason=question 摘要);落定→unblock 回 in_progress', async (t) => {
  const { svc } = await setup(t)
  const b = await svc.post('sess-1', { title: '待拍板活', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: 'explore·A', claimedByTaskId: 'tc-1' })

  const { id, answer } = await askFor(b.id, '用方案 A 还是 B？\n补充说明')
  await waitFor(async () => (await svc.readBoard('sess-1')).items[0]!.status === 'blocked', '挂起→blocked')
  const blocked = (await svc.readBoard('sess-1')).items[0]!
  assert.equal(blocked.status, 'blocked') // 挂起→需拍板
  assert.equal(blocked.note, '用方案 A 还是 B？') // reason=question 摘要(首行)

  getAskChannel().resolve(id, '用方案 A')
  assert.equal(await answer, '用方案 A')
  await waitFor(async () => (await svc.readBoard('sess-1')).items[0]!.status === 'in_progress', '落定→unblock')
  const restored = (await svc.readBoard('sess-1')).items[0]!
  assert.equal(restored.status, 'in_progress') // 落定→解除回在办
})

test('ask↔条目:「跳过」回答同样 unblock(决策 7a\')', async (t) => {
  const { svc } = await setup(t)
  const b = await svc.post('sess-1', { title: '跳过拍板', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: 'explore·A', claimedByTaskId: 'tc-2' })
  const { id, answer } = await askFor(b.id, '要不要 X?')
  await waitFor(async () => (await svc.readBoard('sess-1')).items[0]!.status === 'blocked', '挂起→blocked')
  assert.equal((await svc.readBoard('sess-1')).items[0]!.status, 'blocked')

  getAskChannel().resolve(id, '跳过')
  assert.equal(await answer, '跳过')
  await waitFor(async () => (await svc.readBoard('sess-1')).items[0]!.status === 'in_progress', '跳过→unblock')
  assert.equal((await svc.readBoard('sess-1')).items[0]!.status, 'in_progress')
})

test('ask↔条目:认领人死亡 → 其挂起 ask 置失效(resolved cancelled),条目死亡回流', async (t) => {
  const { svc } = await setup(t)
  const b = await svc.post('sess-1', { title: '死人的问题', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: 'explore·A', claimedByTaskId: 'tc-3' })
  const { answer } = await askFor(b.id, '还能继续吗?')
  await waitFor(async () => (await svc.readBoard('sess-1')).items[0]!.status === 'blocked', '挂起→blocked')
  assert.equal((await svc.readBoard('sess-1')).items[0]!.status, 'blocked')

  // 死亡回流(failed):blocked 条目一并回 pending;挂起 ask 一并失效
  const settled = new Promise<{ by: string }>((res) => {
    const handler = (e: { by: string }) => {
      eventBus.off(EVENTS.ASK_SETTLED, handler)
      res(e)
    }
    eventBus.on(EVENTS.ASK_SETTLED, handler)
  })
  await svc.settleByTaskId('tc-3', 'failed')
  const result = await answer
  assert.match(result, /该提问已失效/)
  assert.equal((await settled).by, 'cancelled')
  const items = (await svc.readBoard('sess-1')).items
  assert.equal(items[0]!.status, 'pending') // 死亡回流回池
})

test('失效收尾幂等:invalidateByItems 只打命中的挂起 ask;无归因 ask 不误伤', async (t) => {
  await setup(t)
  const ch = getAskChannel()
  const p1 = ch.ask('命中?', undefined, true, undefined, { itemId: 'b-hit' })
  const p2 = ch.ask('无归因?', undefined, true, undefined, undefined)
  const p3 = ch.ask('别条目?', undefined, true, undefined, { itemId: 'b-other' })
  await tick()
  const hit = ch.invalidateByItems(['b-hit'])
  assert.deepEqual(hit.length, 1)
  assert.match(await p1, /该提问已失效/)
  // 其余仍挂起
  assert.equal(ch.listPending().length, 2)
  assert.deepEqual(ch.invalidateByItems(['b-hit']), []) // 幂等:二次失效零命中
  for (const p of ch.listPending()) ch.resolve(p.id, '收尾')
  await Promise.all([p2, p3])
})

test('V3.3 裁决锁死:adjudicate 仅 failed(待裁决);unblock 仅认领人或 Lead;failCount 不清零', async (t) => {
  const { svc } = await setup(t)
  const b = await svc.post('sess-1', { title: '裁决活', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: 'explore·A', claimedByTaskId: 't1' })
  // in_progress 不可裁决
  await assert.rejects(
    async () => svc.adjudicate('sess-1', b.id, 'retry', { role: 'lead' }),
    (err: unknown) => err instanceof BoardError && err.code === 'INVALID_STATE',
  )
  // 两败→failed(待裁决);unblock 对非 blocked 拒
  await svc.settleByTaskId('t1', 'failed')
  await svc.claim('sess-1', b.id, { assignee: 'explore·A', claimedByTaskId: 't2' })
  await svc.settleByTaskId('t2', 'failed')
  let item = (await svc.readBoard('sess-1')).items[0]!
  assert.equal(item.status, 'failed')
  assert.equal(item.failCount, 2)
  await assert.rejects(
    async () => svc.unblock('sess-1', b.id, { role: 'lead' }),
    (err: unknown) => err instanceof BoardError && err.code === 'INVALID_STATE',
  )
  // worker 不可裁决(仅 Lead)
  await assert.rejects(
    async () => svc.adjudicate('sess-1', b.id, 'retry', { role: 'worker', assignee: 'explore·A' }),
    (err: unknown) => err instanceof BoardError && err.code === 'FORBIDDEN',
  )
  // retry 回池:failCount 不清零(裁决语义已锁)
  item = await svc.adjudicate('sess-1', b.id, 'retry', { role: 'lead' })
  assert.equal(item.status, 'pending')
  assert.equal(item.failCount, 2)
})

test('V3.3 三出口:ask 回答/跳过→in_progress(上面两测);Lead read 再裁决=会话一句话通道', async (t) => {
  const { svc } = await setup(t)
  // Lead 经板工具 read(只读探查)→ adjudicate(裁决)——"会话一句话=先 read 再裁决"的工具通路
  const b = await svc.post('sess-1', { title: '会话裁决活', createdBy: 'lead' })
  await svc.claim('sess-1', b.id, { assignee: 'explore·A', claimedByTaskId: 't9' })
  await svc.settleByTaskId('t9', 'failed')
  await svc.claim('sess-1', b.id, { assignee: 'explore·A', claimedByTaskId: 't8' })
  await svc.settleByTaskId('t8', 'failed') // → failed 待裁决
  const read = await executeBoard(JSON.stringify({ action: 'read', id: b.id, __origin: { source: 'main', sessionId: 'sess-1' } }), undefined, 'sess-1')
  assert.equal(read.success, true)
  assert.match(read.data!, /待裁决/)
  const adj = await executeBoard(JSON.stringify({ action: 'adjudicate', id: b.id, decision: 'cancel', __origin: { source: 'main', sessionId: 'sess-1' } }), undefined, 'sess-1')
  assert.equal(adj.success, true)
  assert.equal((await svc.readBoard('sess-1')).items[0]!.status, 'cancelled')
})

test('V3.4 worker 发帖:条目=待认领(发帖提议进展行来源)', async (t) => {
  const { svc } = await setup(t)
  const res = await executeBoard(
    JSON.stringify({
      action: 'post',
      title: 'worker 挂的新活',
      description: '需要有人接手',
      __origin: { source: 'subagent', taskId: 'tc-w1', subagentType: 'explore' },
    }),
    { source: 'subagent', taskId: 'tc-w1', subagentType: 'explore' },
    'sess-1',
  )
  assert.equal(res.success, true)
  const item = (await svc.readBoard('sess-1')).items[0]!
  assert.equal(item.status, 'pending') // 发帖即待认领
  assert.equal(item.createdBy, 'explore·A') // 挂项人=本工位
  // 进展行来源=发帖说明(note 优先于 description)
  assert.equal(buildBoardProgressText(item), '发帖提议：需要有人接手')
  const withNote = { ...item, note: '提议先做接口' }
  assert.equal(buildBoardProgressText(withNote), '发帖提议：提议先做接口')
})
