import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AskChannel, getAskChannel, resetAskChannel, type AskRequestPayload } from '../../src/services/askChannel.ts'
import { wireAskChannel, makeResolveAsk, makeListPendingAsks } from '../../src/services/relayEngineWiring.ts'
import type { RelayBridge } from '../../src/services/relay/RelayBridge.ts'
import type { AskUserOption } from '../../src/interfaces/IUserInputProvider.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

/** 监听一个事件（返回捕获的载荷与摘除函数） */
function capture<T = any>(event: string): { fired: () => T[]; off: () => void } {
  const captured: T[] = []
  const listener = (data: T) => captured.push(data)
  eventBus.on(event, listener)
  return {
    fired: () => captured,
    off: () => eventBus.off(event, listener),
  }
}

function freshChannel(): AskChannel {
  resetAskChannel()
  return getAskChannel()
}

const OPTS: AskUserOption[] = [
  { label: '批准并开始执行', description: '立即执行' },
  { label: '放弃本次规划', description: '丢弃' },
]

// ---------- AskChannel ----------

test('AskChannel: ask 登记并发 ASK_REQUESTED，回答后兑现回答文本', async () => {
  const ch = new AskChannel()
  const requested = capture<AskRequestPayload>(EVENTS.ASK_REQUESTED)
  const settled = capture(EVENTS.ASK_SETTLED)

  const p = ch.ask('选哪个？', OPTS, true, '也可直接输入')
  assert.equal(requested.fired().length, 1)
  const payload = requested.fired()[0]
  assert.equal(payload.question, '选哪个？')
  assert.deepEqual(payload.options, OPTS)
  assert.equal(payload.allowFreeText, true)
  assert.equal(payload.hint, '也可直接输入')
  assert.equal(typeof payload.id, 'string')
  assert.equal(ch.listPending().length, 1)

  assert.equal(ch.resolve(payload.id, '批准并开始执行', 'phone'), true)
  assert.equal(await p, '批准并开始执行')
  assert.deepEqual(settled.fired(), [{ id: payload.id, answer: '批准并开始执行', by: 'phone' }])
  assert.equal(ch.listPending().length, 0)
  requested.off()
  settled.off()
})

test('AskChannel: 先到先落——第二次 resolve 返 false，落定通告只发一次', async () => {
  const ch = new AskChannel()
  const settled = capture(EVENTS.ASK_SETTLED)
  const p = ch.ask('问题')
  const id = ch.listPending()[0].id
  assert.equal(ch.resolve(id, '第一答', 'phone'), true)
  assert.equal(ch.resolve(id, '迟到答', 'local'), false)
  assert.equal(await p, '第一答')
  assert.equal(settled.fired().length, 1)
  settled.off()
})

test('AskChannel: 无此挂起的 resolve 返 false（落空不炸）', () => {
  const ch = new AskChannel()
  assert.equal(ch.resolve('不存在的id', '答'), false)
})

// ---------- wireAskChannel（桥呈现面；AskChannel 常驻唯一入口由壳启动装配） ----------

function makeWireEnv() {
  const channel = freshChannel()
  const pushedRequests: AskRequestPayload[] = []
  const pushedResolved: { id: string; answer: string; by: string }[] = []
  const bridge = {
    pushAskRequest: (p: AskRequestPayload) => pushedRequests.push(p),
    pushAskResolved: (s: { id: string; answer: string; by: string }) => pushedResolved.push(s),
  } as unknown as RelayBridge
  return { channel, bridge, pushedRequests, pushedResolved }
}

test('wireAskChannel: ASK_REQUESTED → pushAskRequest；落定 → pushAskResolved（by 透传）', async () => {
  const env = makeWireEnv()
  const unsub = wireAskChannel(env.bridge)
  const p = env.channel.ask('选哪个？', OPTS)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(env.pushedRequests.length, 1)
  assert.equal(env.pushedRequests[0].question, '选哪个？')
  env.channel.resolve(env.pushedRequests[0].id, '批准并开始执行', 'local')
  assert.equal(await p, '批准并开始执行')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(env.pushedResolved, [{ id: env.pushedRequests[0].id, answer: '批准并开始执行', by: 'local' }])
  unsub()
})

test('wireAskChannel: 退订后不再转发', async () => {
  const env = makeWireEnv()
  const unsub = wireAskChannel(env.bridge)
  unsub()
  const p = env.channel.ask('问题')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(env.pushedRequests.length, 0)
  env.channel.resolve(env.channel.listPending()[0].id, '答')
  await p
  assert.equal(env.pushedResolved.length, 0)
})

test('wireAskChannel: 手机回答经 makeResolveAsk 落定 by=phone，桥收到置灰通告', async () => {
  const env = makeWireEnv()
  wireAskChannel(env.bridge)
  const p = env.channel.ask('问题')
  await new Promise((r) => setTimeout(r, 10))
  const id = env.pushedRequests[0].id
  assert.equal(makeResolveAsk()(id, '手机答'), true)
  assert.equal(await p, '手机答')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(env.pushedResolved, [{ id, answer: '手机答', by: 'phone' }])
  // 先到先落：迟到回答返 false，不再转发（settle-guard 语义在 channel 层覆盖）
  assert.equal(makeResolveAsk()(id, '迟到答'), false)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(env.pushedResolved.length, 1)
})

test('makeListPendingAsks: 转发 AskChannel 真相源', () => {
  freshChannel()
  const ch = getAskChannel()
  void ch.ask('问题A')
  void ch.ask('问题B')
  const list = makeListPendingAsks()()
  assert.deepEqual(list.map((p) => p.question), ['问题A', '问题B'])
  ch.resolve(list[0].id, '答')
  assert.equal(makeListPendingAsks()().length, 1)
})

// ---------- 近期落定环（终态愈合重放的数据源） ----------

test('AskChannel: 落定环记录（payload/answer/by/settledAt 完整）', async () => {
  const ch = new AskChannel()
  const p = ch.ask('问题', OPTS)
  const id = ch.listPending()[0].id
  assert.equal(ch.resolve(id, '批准并开始执行', 'phone'), true)
  await p
  const ring = ch.listRecentSettled()
  assert.equal(ring.length, 1)
  assert.equal(ring[0].payload.id, id)
  assert.equal(ring[0].payload.question, '问题')
  assert.deepEqual(ring[0].payload.options, OPTS)
  assert.equal(ring[0].answer, '批准并开始执行')
  assert.equal(ring[0].by, 'phone')
  assert.equal(typeof ring[0].settledAt, 'number')
})

test('AskChannel: 落定环 cap 200 与 listPending 互不干挠', async () => {
  const ch = new AskChannel()
  for (let i = 0; i < 205; i++) {
    const p = ch.ask(`问题${i}`)
    ch.resolve(ch.listPending()[0].id, '答')
    await p
  }
  assert.equal(ch.listRecentSettled().length, 200)
  assert.equal(ch.listRecentSettled()[0].payload.question, '问题5')
  assert.equal(ch.listPending().length, 0)
})

// ---------- V3.2：attribution 只增（taskId/itemId 内部归因） + 失效收尾 ----------

test('V3.2 attribution:ask 透传 sessionId/taskId/itemId(只增;缺省不带键)', async () => {
  const ch = new AskChannel()
  const requested = capture<AskRequestPayload>(EVENTS.ASK_REQUESTED)
  const p = ch.ask('拍板?', undefined, true, undefined, { sessionId: 'sess-1', taskId: 'tc-1', itemId: 'b-1' })
  const payload = requested.fired()[0]!
  assert.equal(payload.sessionId, 'sess-1')
  assert.equal(payload.taskId, 'tc-1')
  assert.equal(payload.itemId, 'b-1')
  ch.resolve(payload.id, '答案')
  await p

  // 缺省归因:三键皆无(旧端兼容)
  const p2 = ch.ask('无归因?', undefined, true, undefined, undefined)
  const payload2 = requested.fired()[1]!
  assert.equal(payload2.sessionId, undefined)
  assert.equal(payload2.taskId, undefined)
  assert.equal(payload2.itemId, undefined)
  ch.resolve(payload2.id, 'x')
  await p2
})

test('V3.2 失效收尾:invalidate → resolved(cancelled)「该提问已失效」,挂起 Promise 落定;幂等', async () => {
  const ch = new AskChannel()
  const settled = capture(EVENTS.ASK_SETTLED)
  const requested = capture<AskRequestPayload>(EVENTS.ASK_REQUESTED)
  const p = ch.ask('已失效?', undefined, true, undefined, { sessionId: 's', itemId: 'b-1' })
  const id = requested.fired()[0]!.id

  assert.equal(ch.invalidate(id, '该提问已失效(认领人已死)'), true)
  const answer = await p
  assert.equal(answer, '该提问已失效(认领人已死)')
  assert.equal(settled.fired()[0]!.by, 'cancelled')
  // 幂等:二次失效 false;迟到回答 false(先到先落)
  assert.equal(ch.invalidate(id), false)
  assert.equal(ch.resolve(id, '迟到回答'), false)
  assert.equal(ch.listRecentSettled()[0]!.answer, '该提问已失效(认领人已死)')
})

test('V3.2 invalidate:不存在/已落定皆 false,不误伤', async () => {
  const ch = new AskChannel()
  assert.equal(ch.invalidate('ghost'), false)
  const requested = capture<AskRequestPayload>(EVENTS.ASK_REQUESTED)
  const p = ch.ask('正常?', undefined, true, undefined, { itemId: 'b-2' })
  const id = requested.fired()[0]!.id
  ch.resolve(id, '正常回答')
  await p
  assert.equal(ch.invalidate(id), false) // 已落定
})

// ---------- 点选裁决卡（ask.request.card / ask.response.decisions additive 通道） ----------

const TRIAGE_CARD = {
  digest: '待确认 3 条 / 2 簇',
  clusters: [
    { id: 'C26', name: 'C26 模型行为与步数低效', count: 2, recent: 2, difficulty: '低' as const, latest: '2026-09-25' },
    { id: '__ungrouped__', name: '未分组', count: 1, recent: 0, latest: '2026-09-20' },
  ],
}

test('裁决卡: ask 第 6 参 extra 自供 id 与 card（Promise<string> 形状不变）', async () => {
  const ch = new AskChannel()
  const requested = capture<AskRequestPayload>(EVENTS.ASK_REQUESTED)
  const p = ch.ask('开庭', undefined, true, '提示', undefined, { id: 'court-1', card: TRIAGE_CARD })
  const payload = requested.fired()[0]!
  assert.equal(payload.id, 'court-1')
  assert.deepEqual(payload.card, TRIAGE_CARD)
  ch.resolve('court-1', 'y C26', 'phone')
  assert.equal(await p, 'y C26') // 落定产出仍是纯文本
  // 不带 extra 的旧调用：id 仍自动生成、无 card 键（既有调用点零改动语义）
  const p2 = ch.ask('旧式提问')
  const payload2 = requested.fired()[1]!
  assert.notEqual(payload2.id, 'court-1')
  assert.equal(payload2.card, undefined)
  ch.resolve(payload2.id, 'x')
  await p2
  requested.off()
})

test('裁决卡: resolve 第 4 参 decisions 存落定环；takeSettledDecisions 消费式读取（取走即清）', async () => {
  const ch = new AskChannel()
  const p = ch.ask('开庭', undefined, true, undefined, undefined, { id: 'court-2', card: TRIAGE_CARD })
  const decisions = [{ action: 'confirm' as const, clusterId: 'C26' }, { action: 'close' as const, title: '记忆提示时机' }]
  ch.resolve('court-2', 'y C26 del 1', 'phone', decisions)
  await p
  const ring = ch.listRecentSettled()
  assert.equal(ring.length, 1)
  assert.deepEqual(ring[0].decisions, decisions)
  assert.deepEqual(ch.takeSettledDecisions('court-2'), decisions)
  assert.equal(ch.takeSettledDecisions('court-2'), undefined, '二次读取已消费')
  assert.equal(ch.takeSettledDecisions('不存在的id'), undefined)
  // 无 decisions 的落定：读取返回 undefined
  const p2 = ch.ask('普通')
  ch.resolve(ch.listPending()[0].id, '答')
  await p2
  assert.equal(ch.takeSettledDecisions(ch.listRecentSettled()[1].payload.id), undefined)
})

test('裁决卡: reannounce 重发 ASK_REQUESTED（同 payload 同 id；已落定/不存在幂等 false）', async () => {
  const ch = new AskChannel()
  const requested = capture<AskRequestPayload>(EVENTS.ASK_REQUESTED)
  const p = ch.ask('开庭', undefined, true, undefined, undefined, { id: 'court-3', card: TRIAGE_CARD })
  assert.equal(requested.fired().length, 1)
  assert.equal(ch.reannounce('court-3'), true)
  assert.equal(requested.fired().length, 2)
  assert.deepEqual(requested.fired()[1], requested.fired()[0], '重推载荷逐字一致（手机端同 id 幂等收敛）')
  assert.equal(ch.reannounce('ghost'), false)
  ch.resolve('court-3', '答')
  await p
  assert.equal(ch.reannounce('court-3'), false, '已落定不再重推')
  requested.off()
})
