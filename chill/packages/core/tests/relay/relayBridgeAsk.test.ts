import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge, type EnqueueResult } from '../../src/services/relay/RelayBridge.ts'
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  encryptEnvelope,
  decryptEnvelope,
  makeEnvelope,
  type Envelope,
  type KeyPairB64,
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport.ts'
import type { AskRequestPayload, SettledAskRecord } from '../../src/services/askChannel.ts'

/** M4e 桥测试环境（镜像 relayBridge.test.ts 的 makeBridgeEnv，扩展 ask 依赖注入） */
function makeBridgeEnv(over: { confirmed?: boolean; blockEnqueue?: boolean; onEnqueue?: (bridge: RelayBridge) => void } = {}) {
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)

  let msgHandler: (msg: BoxMessage) => void = () => {}
  const transport: RelayTransport = {
    connect: async () => {},
    close: () => {},
    connected: true,
    onMessage: (cb) => {
      msgHandler = cb
    },
    onClose: () => {},
  }
  const posts: { path: string; token: string; body: { blob?: string; id?: number } }[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') posts.push({ path, token: opts.token ?? '', body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }
  const askResolutions: { id: string; answer: string; decisions?: unknown }[] = []
  let resolveAskResult = true
  let pendingAsks: AskRequestPayload[] = []
  let recentSettledAsks: SettledAskRecord[] = []
  let bridge!: RelayBridge
  bridge = new RelayBridge({
    transport,
    http,
    secrets,
    myBox,
    peerBox,
    deskPub: desk.publicKey,
    phonePub: phone.publicKey,
    deviceName: '测试电脑',
    pairingToken: 'pair-token',
    confirmed: over.confirmed ?? true,
    enqueue: over.blockEnqueue
      ? () => new Promise<EnqueueResult>(() => {}) // 永不兑现：轮次阻塞在链上（快速路径死锁场景）
      : async (text): Promise<EnqueueResult> => {
          over.onEnqueue?.(bridge) // 模拟引擎产出（思维链/工具等经 wiring 推桥）
          return { content: `回复:${text}`, aborted: false }
        },
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    resolveAsk: (id, answer, decisions) => {
      askResolutions.push(decisions === undefined ? { id, answer } : { id, answer, decisions })
      return resolveAskResult
    },
    listPendingAsks: () => pendingAsks,
    listRecentSettledAsks: () => recentSettledAsks,
    onAlarm: () => {},
  })
  bridge.start()

  function phoneSendAskResponse(id: string, answer: string, envId?: string, decisions?: unknown): BoxMessage {
    const env = makeEnvelope('ask.response', peerBox, myBox, { id, answer, ...(decisions !== undefined ? { decisions } : {}) })
    if (envId) env.id = envId
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function phoneSendSync(): BoxMessage {
    const env = makeEnvelope('chat.sync', peerBox, myBox, {})
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function phoneSendChat(text: string): BoxMessage {
    const env = makeEnvelope('chat.user', peerBox, myBox, { text })
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function readPostedEnvelopes(): Envelope[] {
    return posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  }
  async function feed(msg: BoxMessage): Promise<void> {
    msgHandler(msg)
    await new Promise((r) => setTimeout(r, 20))
  }
  return {
    bridge,
    phoneSendAskResponse,
    phoneSendSync,
    phoneSendChat,
    readPostedEnvelopes,
    feed,
    askResolutions,
    setResolveAskResult: (v: boolean) => {
      resolveAskResult = v
    },
    setPendingAsks: (list: AskRequestPayload[]) => {
      pendingAsks = list
    },
    setRecentSettledAsks: (list: SettledAskRecord[]) => {
      recentSettledAsks = list
    },
  }
}

test('ask.response 快速路径：链被轮次阻塞时回答仍立即落定（防"提问等待自己"死锁）', async () => {
  const env = makeBridgeEnv({ blockEnqueue: true })
  // 先让一条 chat.user 把串行链楔死（enqueue 永不兑现）
  const chatEnv = makeEnvelope('chat.user', '', '', { text: '长任务' })
  void chatEnv // 链阻塞由 blockEnqueue 保证；ask.response 不依赖链
  await env.feed(env.phoneSendAskResponse('ask-1', '批准并开始执行'))
  assert.deepEqual(env.askResolutions, [{ id: 'ask-1', answer: '批准并开始执行' }])
})

test('ask.response 落空（resolve 返 false）→ 回发 ask.resolved(cancelled) 终态', async () => {
  const env = makeBridgeEnv()
  env.setResolveAskResult(false)
  await env.feed(env.phoneSendAskResponse('ask-9', '迟到的回答'))
  const posted = env.readPostedEnvelopes()
  const cancelled = posted.filter((e) => e.type === 'ask.resolved')
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].body['id'], 'ask-9')
  assert.equal(cancelled[0].body['by'], 'cancelled')
})

test('ask.response 重投去重：同一信封不双兑现', async () => {
  const env = makeBridgeEnv()
  const msg = env.phoneSendAskResponse('ask-2', '答', 'env-dup-1')
  await env.feed(msg)
  await env.feed(env.phoneSendAskResponse('ask-2', '答', 'env-dup-1')) // 同 env.id 重投
  assert.equal(env.askResolutions.length, 1)
})

test('出向：pushAskRequest/pushAskResolved 信封手机可解密且字段正确', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushAskRequest({
    id: 'ask-3',
    question: '选哪个？',
    options: [{ label: '甲', description: '选甲' }],
    allowFreeText: true,
    hint: '也可直接输入',
  })
  env.bridge.pushAskResolved({ id: 'ask-3', answer: '甲', by: 'phone' })
  await new Promise((r) => setTimeout(r, 30))
  const posted = env.readPostedEnvelopes()
  const req = posted.find((e) => e.type === 'ask.request')
  const res = posted.find((e) => e.type === 'ask.resolved')
  assert.ok(req)
  assert.equal(req.body['id'], 'ask-3')
  assert.equal(req.body['question'], '选哪个？')
  assert.deepEqual(req.body['options'], [{ label: '甲', description: '选甲' }])
  assert.equal(req.body['allowFreeText'], true)
  assert.equal(req.body['hint'], '也可直接输入')
  assert.ok(res)
  assert.deepEqual(res.body, { id: 'ask-3', answer: '甲', by: 'phone' })
})

test('出向：pushAskRequest 超预算截断——手机必达但有界（实测回归：148 条提案全量清单超 64KB 线上预算被静默丢弃）', async () => {
  const env = makeBridgeEnv()
  // 50KB 中文字符 ≈ 150KB UTF-8 → 远超 45KB 明文预算 / 64KB 线上预算
  const huge = '大'.repeat(50 * 1024)
  env.bridge.pushAskRequest({ id: 'ask-big', question: huge, options: [{ label: '跳过本轮', description: '' }] })
  await new Promise((r) => setTimeout(r, 30))
  const posted = env.readPostedEnvelopes()
  const req = posted.find((e) => e.type === 'ask.request')
  // 信封必须真实过线（可解密）而非被静默丢弃
  assert.ok(req, '超预算 ask.request 必须仍产出可解密信封')
  const q = String(req.body['question'])
  assert.ok(q.endsWith('（已截断，完整内容请在桌面查看）'), '截断标注收尾')
  // 明文字节有界（≤45KB 预算），手机端解密渲染不会被超大卡片拖垮
  assert.ok(Buffer.byteLength(q, 'utf8') <= 45 * 1024, `question 字节有界，实际 ${Buffer.byteLength(q, 'utf8')}`)
  // 选项与自由文本标志不因截断丢失
  assert.deepEqual(req.body['options'], [{ label: '跳过本轮', description: '' }])
})

test('出向：小载荷 question 原样不截断（无标注）', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushAskRequest({ id: 'ask-small', question: '选哪个？' })
  await new Promise((r) => setTimeout(r, 30))
  const req = env.readPostedEnvelopes().find((e) => e.type === 'ask.request')
  assert.ok(req)
  assert.equal(req.body['question'], '选哪个？')
})

test('resyncPendingAsks：从真相源重推未决提问（同 id 收敛）', async () => {
  const env = makeBridgeEnv()
  env.setPendingAsks([
    { id: 'ask-5', question: '未决甲' },
    { id: 'ask-6', question: '未决乙', options: [{ label: '好', description: '' }] },
  ])
  env.bridge.resyncPendingAsks()
  await new Promise((r) => setTimeout(r, 30))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'ask.request')
  assert.deepEqual(posted.map((e) => e.body['question']), ['未决甲', '未决乙'])
})

test('M4e 终态愈合：resync 在未决重推后重放"请求+落定"对（保序：先建卡再置灰）', async () => {
  const env = makeBridgeEnv()
  env.setPendingAsks([{ id: 'ask-pend', question: '未决' }])
  env.setRecentSettledAsks([
    { payload: { id: 'ask-done', question: '已落定' }, answer: '好', by: 'local', settledAt: Date.now() },
  ])
  env.bridge.resyncPendingAsks()
  await new Promise((r) => setTimeout(r, 30))
  const posted = env.readPostedEnvelopes()
  assert.deepEqual(
    posted.map((e) => `${e.type}:${String(e.body['id'])}`),
    ['ask.request:ask-pend', 'ask.request:ask-done', 'ask.resolved:ask-done'],
  )
  assert.equal(posted[2].body['answer'], '好')
  assert.equal(posted[2].body['by'], 'local')
})

test('chat.sync 订阅信号：ACK + 触发未决审批/提问重推（幂等，无需去重）', async () => {
  const env = makeBridgeEnv()
  env.setPendingAsks([{ id: 'ask-7', question: '未决提问' }])
  await env.feed(env.phoneSendSync())
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'ask.request')
  assert.deepEqual(posted.map((e) => e.body['question']), ['未决提问'])
})

test('chat.sync 快速路径：链被挂起轮次楔死时仍立即重推（实测击穿场景回归）', async () => {
  const env = makeBridgeEnv({ blockEnqueue: true })
  env.setPendingAsks([{ id: 'ask-8', question: '卡死恢复提问' }])
  // 先用一条 chat.user 把入向链楔死（enqueue 永不兑现，模拟挂起提问阻塞的轮次）
  await env.feed(env.phoneSendChat('长任务'))
  // 链仍阻塞时 chat.sync 到达 → 快速路径立即重推，不排队
  await env.feed(env.phoneSendSync())
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'ask.request')
  assert.deepEqual(posted.map((e) => e.body['question']), ['卡死恢复提问'])
})

test('M4f 思考关闭快照：轮末补发该节拍全文（丢分片愈合的数据源），保序在 final 前', async () => {
  const env = makeBridgeEnv({
    onEnqueue: (b) => {
      b.pushReasoning('用户要 3 条水果的无序列表') // 分片 1
      b.pushReasoning('，用横杠开头。简单直接的输出。') // 分片 2
    },
  })
  await env.feed(env.phoneSendChat('发我 3 条水果的无序列表，用横杠开头'))
  await new Promise((r) => setTimeout(r, 300)) // 让 200ms 聚合定时器落定
  const posted = env.readPostedEnvelopes()
  const snaps = posted.filter((e) => e.type === 'chat.event' && e.body['kind'] === 'reasoning' && e.body['closed'] === true)
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0].body['text'], '用户要 3 条水果的无序列表，用横杠开头。简单直接的输出。')
  const kinds = posted.map((e) => `${String(e.body['kind'])}${e.body['closed'] === true ? ':closed' : ''}`)
  assert.ok(kinds.indexOf('reasoning:closed') > -1 && kinds.indexOf('reasoning:closed') < kinds.lastIndexOf('final'))
})

test('M4f advanceBeat：旧节拍关闭快照随节拍前进发出，末节拍轮末发出（每节至多一次）', async () => {
  const env = makeBridgeEnv({
    onEnqueue: (b) => {
      b.pushReasoning('节拍零的思考')
      b.advanceBeat()
      b.pushReasoning('节拍一的思考')
    },
  })
  await env.feed(env.phoneSendChat('两节拍任务'))
  await new Promise((r) => setTimeout(r, 300))
  const snaps = env
    .readPostedEnvelopes()
    .filter((e) => e.type === 'chat.event' && e.body['kind'] === 'reasoning' && e.body['closed'] === true)
  assert.equal(snaps.length, 2)
  assert.deepEqual(
    snaps.map((e) => [e.body['beat'], e.body['text']]),
    [
      [0, '节拍零的思考'],
      [1, '节拍一的思考'],
    ],
  )
})

// ---------- 点选裁决卡（ask.request.card / ask.response.decisions additive 透传） ----------

const TRIAGE_CARD = {
  digest: '待确认 3 条 / 2 簇',
  clusters: [
    { id: 'C26', name: 'C26 模型行为与步数低效', count: 2, recent: 2, difficulty: '低', latest: '2026-09-25' },
    { id: '__ungrouped__', name: '未分组', count: 1, recent: 0, latest: '2026-09-20' },
  ],
}

test('裁决卡: pushAskRequest 透传 card（两态序列化——带卡/不带卡信封均可解密往返）', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushAskRequest({ id: 'ask-card', question: '开庭', card: TRIAGE_CARD })
  env.bridge.pushAskRequest({ id: 'ask-plain', question: '纯文本提问' })
  await new Promise((r) => setTimeout(r, 30))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'ask.request')
  assert.equal(posted.length, 2)
  assert.deepEqual(posted[0].body['card'], TRIAGE_CARD, 'card 逐字过线')
  assert.equal(posted[1].body['card'], undefined, '无卡提问不携带 card 键（旧端线形零变化）')
})

test('裁决卡: resync 重推随记录透传 card（重推路径复用 pushAskRequest 零改动）', async () => {
  const env = makeBridgeEnv()
  env.setPendingAsks([{ id: 'ask-court', question: '开庭', card: TRIAGE_CARD }])
  env.bridge.resyncPendingAsks()
  await new Promise((r) => setTimeout(r, 30))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'ask.request')
  assert.equal(posted.length, 1)
  assert.deepEqual(posted[0].body['card'], TRIAGE_CARD)
})

test('裁决卡: ask.response 的 decisions 形状校验后透传 resolveAsk 第三参', async () => {
  const env = makeBridgeEnv()
  const decisions = [
    { action: 'confirm', clusterId: 'C26' },
    { action: 'close', title: '记忆提示时机' },
  ]
  await env.feed(env.phoneSendAskResponse('ask-d1', 'y C26 del 1', undefined, decisions))
  assert.deepEqual(env.askResolutions, [{ id: 'ask-d1', answer: 'y C26 del 1', decisions }])
})

test('裁决卡: 畸形 decisions 整体丢弃（undefined 走文本回退），不误放半坏数据', async () => {
  const env = makeBridgeEnv()
  // 动作词表外
  await env.feed(env.phoneSendAskResponse('ask-d2', 'y C26', undefined, [{ action: 'bogus', clusterId: 'C26' }]))
  assert.deepEqual(env.askResolutions, [{ id: 'ask-d2', answer: 'y C26' }])
  // clusterId/title 双缺失
  await env.feed(env.phoneSendAskResponse('ask-d3', 'y C26', undefined, [{ action: 'confirm' }]))
  assert.deepEqual(env.askResolutions[1], { id: 'ask-d3', answer: 'y C26' })
  // 非数组
  await env.feed(env.phoneSendAskResponse('ask-d4', 'y C26', undefined, 'not-an-array'))
  assert.deepEqual(env.askResolutions[2], { id: 'ask-d4', answer: 'y C26' })
})

test('归因透传: pushAskRequest 携带 sessionId（有归因带字段/无归因不带——手机端分流呈现的归因源）', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushAskRequest({ id: 'ask-a1', question: '会话内请示', sessionId: 'sess-001' } as AskRequestPayload)
  env.bridge.pushAskRequest({ id: 'ask-a2', question: '全局请示（开庭等）' } as AskRequestPayload)
  await new Promise((r) => setTimeout(r, 50)) // 出向 FIFO 异步冲刷
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'ask.request')
  assert.equal(posted.length, 2)
  const withAttr = posted.find((e) => e.body['id'] === 'ask-a1')!
  assert.equal(withAttr.body['sessionId'], 'sess-001')
  const withoutAttr = posted.find((e) => e.body['id'] === 'ask-a2')!
  assert.equal('sessionId' in withoutAttr.body, false) // additive 语义：无归因不带字段
})

test('归因透传: pushApprovalRequest 携带 origin.sessionId（有归因带/无归因不带）', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushApprovalRequest({
    toolCallId: 'apr-1',
    kind: 'write',
    summary: '会话内审批',
    origin: { source: 'main', sessionId: 'sess-002' },
  } as never)
  env.bridge.pushApprovalRequest({
    toolCallId: 'apr-2',
    kind: 'command',
    summary: '无归因审批',
    origin: { source: 'main' },
  } as never)
  await new Promise((r) => setTimeout(r, 50))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'approval.request')
  assert.equal(posted.length, 2)
  assert.equal(posted.find((e) => e.body['id'] === 'apr-1')!.body['sessionId'], 'sess-002')
  assert.equal('sessionId' in posted.find((e) => e.body['id'] === 'apr-2')!.body, false)
})
