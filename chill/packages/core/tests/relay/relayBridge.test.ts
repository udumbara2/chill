import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge, type EnqueueResult } from '../../src/services/relay/RelayBridge.ts'
import {
  generateKeyPair,
  ecdhShared,
  deriveSecrets,
  mailboxIdFromPub,
  pairingMAC,
  encryptEnvelope,
  decryptEnvelope,
  makeEnvelope,
  type Envelope,
  type KeyPairB64,
} from '../../src/services/relay/envelope.ts'
import type { RelayTransport, RelayHttp, BoxMessage } from '../../src/services/relay/RelayTransport.ts'

/** 双端真实密钥的桥测试环境：手机侧用同一份派生物反向加解密 */
function makeBridgeEnv(over: { confirmed?: boolean; pairingToken?: string | null; currentSessionId?: string | null } = {}) {
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  const pairingToken = over.pairingToken === undefined ? 'pair-token' : over.pairingToken

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
  const enqueued: string[] = []
  const alarms: string[] = []
  const confirms: { device: string }[] = []
  /** M4：审批回答落定记录与挂起清单（测试注入） */
  const resolutions: { id: string; decision: 'approve' | 'reject'; allowSession?: boolean }[] = []
  let resolveResult = true
  let pendingApprovals: import('../../src/services/approvals.ts').ApprovalRequestPayload[] = []
  let recentSettled: import('../../src/services/approvals.ts').SettledApprovalRecord[] = []
  /** M5：权限模式测试注入（合法值校验与现状记录） */
  let currentMode = 'boundary'
  const modeSetCalls: { mode: string; by: string }[] = []
  /** M6：当前会话测试注入（发言即附着/兼容跟随路径的判定数据源） */
  let currentSessionId: string | null = over.currentSessionId === undefined ? 's-current' : over.currentSessionId
  const ensureCalls: string[] = []
  let ensureResult: 'ok' | 'busy' | 'notfound' = 'ok'
  /** M6b 'new' 分支测试旋钮 */
  let newSessionResult: 'ok' | 'busy' = 'ok'
  const newSessionCalls: number[] = []
  const bridge = new RelayBridge({
    transport,
    http,
    secrets,
    myBox,
    peerBox,
    deskPub: desk.publicKey,
    phonePub: phone.publicKey,
    deviceName: '测试电脑',
    pairingToken,
    confirmed: over.confirmed ?? true,
    enqueue: async (input): Promise<EnqueueResult> => {
      enqueued.push(input.text)
      return { content: `回复:${input.text}`, aborted: false }
    },
    resolveApproval: (id, decision, opts) => {
      resolutions.push({ id, decision, ...(opts?.allowSession === true ? { allowSession: true } : {}) })
      return resolveResult
    },
    listPendingApprovals: () => pendingApprovals,
    listRecentSettledApprovals: () => recentSettled,
    setPermissionMode: (mode: string, by: string) => {
      modeSetCalls.push({ mode, by })
      if (mode !== 'readonly' && mode !== 'boundary' && mode !== 'fullAccess') return false
      currentMode = mode
      return true
    },
    getPermissionMode: () => currentMode,
    // M6：当前会话 / 发言即激活守卫（测试注入）
    getActiveSessionId: () => currentSessionId,
    ensureActiveSession: async (id) => {
      ensureCalls.push(id)
      if (ensureResult === 'ok') currentSessionId = id
      return ensureResult
    },
    // M6b：'new' 分支（ok 时模拟新会话 id 诞生）
    ensureNewSession: async () => {
      newSessionCalls.push(1)
      if (newSessionResult === 'ok') currentSessionId = 's-newborn'
      return newSessionResult
    },
    onConfirmRequest: async (device) => {
      confirms.push({ device })
      return true
    },
    onAlarm: (m) => alarms.push(m),
  })
  bridge.start()

  /** 手机侧造一条 chat.user 投递（M6：可携带 sessionId = 发言目标会话） */
  function phoneSend(text: string, id?: string, sessionId?: string): BoxMessage {
    const env = makeEnvelope('chat.user', peerBox, myBox, sessionId !== undefined ? { text, sessionId } : { text })
    if (id) env.id = id
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  /** 手机侧造一条任意类型投递（M6 新信封测试用） */
  function phoneEnvelope(type: string, body: Record<string, unknown>, id?: string): BoxMessage {
    const env = makeEnvelope(type, peerBox, myBox, body)
    if (id) env.id = id
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  /** 手机侧读桌面投来的信封（解密最后一类投递） */
  function readPostedEnvelopes(): Envelope[] {
    return posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  }
  const acks = () => posts.filter((p) => p.path.endsWith('/ack')).map((p) => p.body.id)
  async function feed(msg: BoxMessage): Promise<void> {
    msgHandler(msg)
    // 串行链异步完成（enqueue + ack + 回投）；桥内链是微任务链，两轮 tick 足够
    await new Promise((r) => setTimeout(r, 20))
  }
  return {
    bridge,
    phoneSend,
    readPostedEnvelopes,
    acks,
    feed,
    enqueued,
    alarms,
    confirms,
    secrets,
    myBox,
    peerBox,
    pairingToken,
    resolutions,
    setResolveResult: (v: boolean) => {
      resolveResult = v
    },
    setPendingApprovals: (list: import('../../src/services/approvals.ts').ApprovalRequestPayload[]) => {
      pendingApprovals = list
    },
    setRecentSettled: (list: import('../../src/services/approvals.ts').SettledApprovalRecord[]) => {
      recentSettled = list
    },
    modeSetCalls,
    setCurrentMode: (m: string) => {
      currentMode = m
    },
    // M6 测试旋钮
    phoneEnvelope,
    ensureCalls,
    setEnsureResult: (r: 'ok' | 'busy' | 'notfound') => {
      ensureResult = r
    },
    setCurrentSessionId: (id: string | null) => {
      currentSessionId = id
    },
    // M6b 测试旋钮
    newSessionCalls,
    setNewSessionResult: (r: 'ok' | 'busy') => {
      newSessionResult = r
    },
  }
}

test('入向：chat.user 解密 → 注入引擎 → 回执 final 加密投手机信箱 → ACK', async () => {
  const env = makeBridgeEnv()
  await env.feed(env.phoneSend('帮我列目录'))
  assert.deepEqual(env.enqueued, ['帮我列目录'])
  const posted = env.readPostedEnvelopes()
  // M6 兼容路径：final 回执 + 轮末收编附着确认（attached.changed = 当前会话）
  assert.equal(posted.length, 2)
  assert.equal(posted[0].type, 'chat.event')
  assert.equal(posted[0].body['kind'], 'final')
  assert.equal(posted[0].body['text'], '回复:帮我列目录')
  assert.equal(posted[0].replyTo !== undefined, true)
  assert.equal(posted[1].type, 'session.event')
  assert.equal(posted[1].body['kind'], 'attached.changed')
  assert.equal(posted[1].body['sessionId'], 's-current')
  assert.equal(env.acks().length, 1) // 注入成功后 ACK
  assert.deepEqual(env.alarms, [])
})

test('去重：同信封 id 重投 → 只注入一次（第二次直接 ACK）', async () => {
  const env = makeBridgeEnv()
  const dup = env.phoneSend('重复消息', 'fixed-env-id')
  await env.feed(dup)
  await env.feed({ ...dup, id: dup.id + 1 }) // 服务器重投（新 msg id，同信封 id）
  assert.deepEqual(env.enqueued, ['重复消息'])
  assert.equal(env.acks().length, 2)
})

test('confirm 前：非 pair 信封丢弃+计数（不注入引擎、ACK 防重投）', async () => {
  const env = makeBridgeEnv({ confirmed: false })
  await env.feed(env.phoneSend('太早了'))
  assert.deepEqual(env.enqueued, [])
  assert.equal(env.bridge.getDroppedPreConfirm(), 1)
  assert.equal(env.acks().length, 1)
})

test('pair.hello：MAC 互验 → 壳侧确认 → 回投 pair.confirm → confirmed', async () => {
  const env = makeBridgeEnv({ confirmed: false })
  const hello = makeEnvelope('pair.hello', env.peerBox, env.myBox, {
    device: '测试手机',
    mac: pairingMAC(env.pairingToken!, env.bridge['deps'].deskPub, env.bridge['deps'].phonePub),
  })
  await env.feed({ id: 1, blob: encryptEnvelope(env.secrets.keyM2D, env.myBox, 'm2d', hello)! })
  assert.equal(env.confirms.length, 1)
  assert.equal(env.confirms[0].device, '测试手机')
  const posted = env.readPostedEnvelopes()
  assert.deepEqual(posted.map((e) => e.type), ['pair.confirm', 'mode.state']) // M5：确认即补推当前权限模式档
  assert.equal(posted[1].body['mode'], 'boundary')
  assert.equal(env.bridge.isConfirmed(), true)
  assert.equal(env.acks().length, 1)
})

test('pair.hello MAC 校验失败：fail-closed 报警，不 ACK 不确认（禁止静默重试）', async () => {
  const env = makeBridgeEnv({ confirmed: false })
  const evil = makeEnvelope('pair.hello', env.peerBox, env.myBox, { device: 'x', mac: 'forged' })
  await env.feed({ id: 1, blob: encryptEnvelope(env.secrets.keyM2D, env.myBox, 'm2d', evil)! })
  assert.equal(env.confirms.length, 0)
  assert.equal(env.bridge.isConfirmed(), false)
  assert.equal(env.acks().length, 0)
  assert.equal(env.alarms.length, 1)
  assert.ok(env.alarms[0].includes('MAC'))
})

test('解密失败（对向钥加密的反射密文）：报警不 ACK', async () => {
  const env = makeBridgeEnv()
  const reflected = makeEnvelope('chat.user', env.peerBox, env.myBox, { text: 'x' })
  // 用 d2m 钥加密（方向错）模拟反射/篡改
  const wire = encryptEnvelope(env.secrets.keyD2M, env.myBox, 'm2d', reflected)!
  await env.feed({ id: 9, blob: wire })
  assert.deepEqual(env.enqueued, [])
  assert.equal(env.acks().length, 0)
  assert.equal(env.alarms.length, 1)
})

test('注入失败：不 ACK 等重投（at-least-once）且报警', async () => {
  const env = makeBridgeEnv()
  env.bridge['deps'].enqueue = async () => {
    throw new Error('引擎忙碌')
  }
  await env.feed(env.phoneSend('会失败'))
  assert.equal(env.acks().length, 0)
  assert.equal(env.alarms.length, 1)
  assert.ok(env.alarms[0].includes('重投'))
})

test('hook deny 回执：deniedReason → chat.event(notice) 投手机', async () => {
  const env = makeBridgeEnv()
  env.bridge['deps'].enqueue = async (): Promise<EnqueueResult> => ({
    content: '',
    deniedReason: '含敏感指令',
    aborted: false,
  })
  await env.feed(env.phoneSend('危险指令'))
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 2) // M6：notice 回执 + 轮末收编附着确认
  assert.equal(posted[0].body['kind'], 'notice')
  assert.ok(String(posted[0].body['text']).includes('含敏感指令'))
  assert.equal(posted[1].body['kind'], 'attached.changed')
  assert.equal(env.acks().length, 1)
})


// ---------- M4：审批双通道 + 轮次状态 + 思维链 ----------

/** 手机侧造一条 approval.response 投递（extraBody：additive 字段注入，如 allowSession） */
function phoneApprovalResponse(env: ReturnType<typeof makeBridgeEnv>, approvalId: string, decision: 'approve' | 'reject', envId?: string, extraBody?: Record<string, unknown>): BoxMessage {
  const e = makeEnvelope('approval.response', env.peerBox, env.myBox, { id: approvalId, decision, ...(extraBody ?? {}) })
  if (envId) e.id = envId
  return { id: 500 + Math.floor(Math.random() * 1000), blob: encryptEnvelope(env.secrets.keyM2D, env.myBox, 'm2d', e)! }
}

test('M4 出向：pushApprovalRequest 构造 summary/timeoutAt 透传；未 confirmed 不推', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushApprovalRequest({
    toolCallId: 'tc-w1',
    kind: 'write',
    path: 'C:\\tmp\\a.txt',
    diffPreview: '+ hello',
    timeoutAt: 1735689600000,
    origin: { source: 'mobile' },
  })
  await new Promise((r) => setTimeout(r, 20))
  let posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1)
  assert.equal(posted[0].type, 'approval.request')
  assert.equal(posted[0].body['id'], 'tc-w1')
  assert.equal(posted[0].body['kind'], 'write')
  assert.ok(String(posted[0].body['summary']).includes('C:\\tmp\\a.txt'))
  assert.equal(posted[0].body['preview'], '+ hello')
  assert.equal(posted[0].body['timeoutAt'], 1735689600000)
  assert.equal(posted[0].body['sessionGrantable'], undefined) // 非桌面审批不带标记

  // 桌面操作审批（sessionGrantable）：additive 透传——手机据此渲染「本次会话放行」第三钮
  env.bridge.pushApprovalRequest({
    toolCallId: 'tc-d1',
    kind: 'command',
    command: '点击 (640, 480)',
    sessionGrantable: true,
    origin: { source: 'mobile' },
  })
  await new Promise((r) => setTimeout(r, 20))
  posted = env.readPostedEnvelopes()
  assert.equal(posted[1].type, 'approval.request')
  assert.equal(posted[1].body['sessionGrantable'], true)

  // 未 confirmed：推了白推（手机端确认前丢弃非 pair 信封）
  const env2 = makeBridgeEnv({ confirmed: false })
  env2.bridge.pushApprovalRequest({ toolCallId: 'tc-x', kind: 'command', command: 'ls', origin: { source: 'main' } })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env2.readPostedEnvelopes().length, 0)
})

test('M4 出向：pushApprovalResolved 发 approval.resolved（手机卡片置灰触发）', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushApprovalResolved({ toolCallId: 'tc-r1', approved: true, by: 'local' })
  await new Promise((r) => setTimeout(r, 20))
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1)
  assert.equal(posted[0].type, 'approval.resolved')
  assert.deepEqual(posted[0].body, { id: 'tc-r1', approved: true, by: 'local' })
})

test('M4 入向：approval.response → resolveApproval 落定 + ACK；decision 映射正确', async () => {
  const env = makeBridgeEnv()
  await env.feed(phoneApprovalResponse(env, 'tc-a1', 'approve'))
  assert.deepEqual(env.resolutions, [{ id: 'tc-a1', decision: 'approve' }])
  assert.equal(env.acks().length, 1)

  await env.feed(phoneApprovalResponse(env, 'tc-a2', 'reject'))
  assert.deepEqual(env.resolutions[1], { id: 'tc-a2', decision: 'reject' })
  assert.equal(env.acks().length, 2)
})

test('M4 入向：allowSession additive 映射（手机「本次会话放行」）——approve 携带则透传，reject 携带则门掉', async () => {
  const env = makeBridgeEnv()
  // approve + allowSession:true → opts 透传（落定 allowSession 与 CLI [s]/桌面 UI 同源）
  await env.feed(phoneApprovalResponse(env, 'tc-s1', 'approve', undefined, { allowSession: true }))
  assert.deepEqual(env.resolutions[0], { id: 'tc-s1', decision: 'approve', allowSession: true })
  // approve 不带 allowSession → 无 opts（普通批准，旧手机形态不变）
  await env.feed(phoneApprovalResponse(env, 'tc-s2', 'approve', undefined, { allowSession: false }))
  assert.deepEqual(env.resolutions[1], { id: 'tc-s2', decision: 'approve' })
  // reject + allowSession（无意义组合）→ 门掉，不透传
  await env.feed(phoneApprovalResponse(env, 'tc-s3', 'reject', undefined, { allowSession: true }))
  assert.deepEqual(env.resolutions[2], { id: 'tc-s3', decision: 'reject' })
  assert.equal(env.acks().length, 3)
})

test('M4 入向：resolve 返 false（失效审批）→ 回发 approval.resolved cancelled（僵尸卡不可能）', async () => {
  const env = makeBridgeEnv()
  env.setResolveResult(false)
  await env.feed(phoneApprovalResponse(env, 'tc-stale', 'approve'))
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1)
  assert.equal(posted[0].type, 'approval.resolved')
  assert.deepEqual(posted[0].body, { id: 'tc-stale', approved: false, by: 'cancelled' })
  assert.equal(env.acks().length, 1)
})

test('M4 入向：approval.response 重投去重（同信封 id 只落定一次）', async () => {
  const env = makeBridgeEnv()
  const dup = phoneApprovalResponse(env, 'tc-dup', 'approve', 'fixed-resp-id')
  await env.feed(dup)
  await env.feed({ ...dup, id: dup.id + 1 })
  assert.equal(env.resolutions.length, 1)
  assert.equal(env.acks().length, 2)
})

test('M4 重连再同步：resyncPendingApprovals 按清单重推（同 toolCallId 收敛）；未 confirmed 不推', async () => {
  const env = makeBridgeEnv()
  env.setPendingApprovals([
    { toolCallId: 'tc-p1', kind: 'write', path: 'C:\\a.txt', origin: { source: 'main' } },
    { toolCallId: 'tc-p2', kind: 'command', command: 'npm test', purpose: '跑测试', origin: { source: 'main' } },
  ])
  env.bridge.resyncPendingApprovals()
  await new Promise((r) => setTimeout(r, 20))
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 2)
  assert.equal(posted[0].body['id'], 'tc-p1')
  assert.equal(posted[1].body['id'], 'tc-p2')
  assert.ok(String(posted[1].body['summary']).includes('npm test'))
  assert.ok(String(posted[1].body['summary']).includes('跑测试'))
})

test('M4 终态愈合：resync 在未决重推后重放"请求+落定"对（保序：先建卡再置灰）', async () => {
  const env = makeBridgeEnv()
  env.setPendingApprovals([{ toolCallId: 'tc-pend', kind: 'write', path: 'C:\\p.txt', origin: { source: 'main' } }])
  env.setRecentSettled([
    {
      payload: { toolCallId: 'tc-done', kind: 'command', command: 'npm run build', origin: { source: 'main' } },
      approved: true,
      by: 'local',
      settledAt: Date.now(),
    },
  ])
  env.bridge.resyncPendingApprovals()
  await new Promise((r) => setTimeout(r, 30))
  const posted = env.readPostedEnvelopes()
  assert.deepEqual(
    posted.map((e) => `${e.type}:${String(e.body['id'])}`),
    ['approval.request:tc-pend', 'approval.request:tc-done', 'approval.resolved:tc-done'],
  )
  assert.equal(posted[2].body['approved'], true)
  assert.equal(posted[2].body['by'], 'local')
})

test('M6 附着门控：未附着 pushStreamChunk/pushToolEvent 不出向；附着会话出向同锚 kind=tool/reasoning', async () => {
  const env = makeBridgeEnv()
  // 未附着：静默丢弃（M6 门控 = 内容所属会话 === attachedSessionId）
  env.bridge.pushStreamChunk({ sessionId: 's-any', kind: 'delta', text: '不该发' })
  env.bridge.pushStreamChunk({ sessionId: 's-any', kind: 'reasoning', text: '不该发' })
  env.bridge.pushToolEvent('s-any', '不该发', 'tc-x')
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(env.readPostedEnvelopes().length, 0)

  // 手机轮（携带 sessionId = s-m6，发言即附着）：enqueue 期间经广播/工具通道喂入
  env.setCurrentSessionId('s-m6')
  env.bridge['deps'].enqueue = async (text): Promise<EnqueueResult> => {
    env.bridge.pushStreamChunk({ sessionId: 's-m6', kind: 'reasoning', text: '先想一下' })
    env.bridge.pushToolEvent('s-m6', '思考中…', 'tc-1')
    env.bridge.pushToolEvent('s-m6', '调用工具 Write…', 'tc-2', { name: 'Write', status: 'running' })
    // 非附着会话的内容被门控丢弃（并行/串台防护）
    env.bridge.pushStreamChunk({ sessionId: 's-other', kind: 'delta', text: '串台内容' })
    env.bridge.pushToolEvent('s-other', '串台工具', 'tc-9')
    return { content: `回复:${text}`, aborted: false }
  }
  await env.feed(env.phoneSend('干活', undefined, 's-m6'))
  const posted = env.readPostedEnvelopes()
  // attached.changed 确认先行 + tool 两条（即时出向）+ reasoning 聚合轮末冲刷一条 + M4f 关闭快照 + final（FIFO 保序）
  const kinds = posted.map((p) => `${p.type}:${String(p.body['kind'])}${p.body['closed'] === true ? ':closed' : ''}`)
  assert.deepEqual(kinds, [
    'session.event:attached.changed',
    'chat.event:tool',
    'chat.event:tool',
    'chat.event:reasoning',
    'chat.event:reasoning:closed',
    'chat.event:final',
  ])
  const chatEvents = posted.filter((p) => p.type === 'chat.event')
  const anchor = chatEvents[chatEvents.length - 1].replyTo
  assert.ok(anchor !== undefined)
  assert.ok(chatEvents.every((p) => p.replyTo === anchor))
  assert.ok(chatEvents.every((p) => p.body['sessionId'] === 's-m6')) // M6 会话归属戳
  assert.ok(chatEvents.every((p) => String(p.body['text']).includes('串台') === false))
  assert.equal(chatEvents[0].body['text'], '思考中…')
  assert.equal(chatEvents[0].body['toolCallId'], 'tc-1')
  assert.equal(chatEvents[1].body['text'], '调用工具 Write…')
  assert.deepEqual(chatEvents[1].body['detail'], { name: 'Write', status: 'running' })
  assert.equal(chatEvents[2].body['text'], '先想一下')
})


test('M4 竞态护栏：已推送过终态的审批，迟到 response 的 resolve 失败不再回发 cancelled', async () => {
  const env = makeBridgeEnv()
  // 手机批准后终态已推送（by=phone approved）→ resolvedPushed 记录
  env.bridge.pushApprovalResolved({ toolCallId: 'tc-late', approved: true, by: 'phone' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env.readPostedEnvelopes().length, 1)

  // 超时重试产生的第二个 response：resolve 返 false（已定落），但不得再发 cancelled 覆盖真实终态
  env.setResolveResult(false)
  await env.feed(phoneApprovalResponse(env, 'tc-late', 'reject'))
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1) // 仍然只有最初那条 resolved(approved)
  assert.deepEqual(posted[0].body, { id: 'tc-late', approved: true, by: 'phone' })
  assert.equal(env.acks().length, 1) // 迟到 response 照常 ACK
})


test('M4 死锁回归：approval.response 不排在被审批阻塞的轮次后面（快速路径立即落定）', async () => {
  const env = makeBridgeEnv()
  let releaseRound: (r: EnqueueResult) => void = () => {}
  const roundGate = new Promise<EnqueueResult>((res) => {
    releaseRound = res
  })
  env.bridge['deps'].enqueue = () => roundGate // 轮次挂起（模拟" enqueue 在等审批"）

  const feedPromise = env.feed(env.phoneSend('触发审批'))
  await new Promise((r) => setTimeout(r, 50)) // 确认轮次已阻塞在 enqueue

  // 轮次仍阻塞时送达审批回答：若走串行链会排在轮次后（死锁，只能等 5 分钟超时）；
  // 快速路径必须立即落定
  await env.feed(phoneApprovalResponse(env, 'tc-blocked', 'approve'))
  assert.deepEqual(env.resolutions, [{ id: 'tc-blocked', decision: 'approve' }])

  releaseRound({ content: '完成', aborted: false })
  await feedPromise
})


// ---------- M4b：节拍（beat） ----------

test('M4b 节拍：beat 生产时捕获随缓冲携带——advanceBeat 后冲刷的旧缓冲仍带旧序号', async () => {
  const env = makeBridgeEnv()
  env.bridge['deps'].enqueue = async (): Promise<EnqueueResult> => {
    env.bridge.pushReasoning('第一拍的思考') // beat 0 产生，进缓冲（200ms 窗口内不立即发）
    env.bridge.pushDelta('第一拍的正文')
    env.bridge.advanceBeat() // 先冲刷（带 beat 0）再自增
    env.bridge.pushReasoning('第二拍的思考') // beat 1
    env.bridge.pushDelta('第二拍的正文')
    return { content: '最终回复', aborted: false }
  }
  await env.feed(env.phoneSend('两拍任务'))
  const posted = env.readPostedEnvelopes().filter((p) => p.type === 'chat.event') // M6：轮末收编附着确认（session.event）不参与节拍断言
  const seq = posted.map((p) => `${String(p.body['kind'])}@${String(p.body['beat'])}${p.body['closed'] === true ? ':closed' : ''}`)
  assert.deepEqual(seq, [
    'delta@0',
    'reasoning@0',
    'reasoning@0:closed', // M4f：节拍前进时旧节拍思考关闭快照（全文兜底）
    'delta@1',
    'reasoning@1',
    'reasoning@1:closed', // M4f：轮末末节拍思考关闭快照（保序在 final 前）
    'final@1', // final 在调用时刻捕获当前 beat
  ])
  assert.equal(posted[1].body['text'], '第一拍的思考')
  assert.equal(posted[2].body['text'], '第一拍的思考') // 关闭快照 = 该节拍全文
  assert.equal(posted[4].body['text'], '第二拍的思考')
  assert.equal(posted[5].body['text'], '第二拍的思考')
  assert.equal(posted[0].body['text'], '第一拍的正文')
  assert.equal(posted[3].body['text'], '第二拍的正文')
})

test('M4b 节拍：advanceBeat 未附着门控（无附着且无跟随轮时不自增）；新一轮归 0', async () => {
  const env = makeBridgeEnv()
  env.bridge.advanceBeat() // 未附着：no-op
  await env.feed(env.phoneSend('第一轮'))
  let posted = env.readPostedEnvelopes().filter((p) => p.type === 'chat.event')
  assert.ok(posted.every((p) => p.body['beat'] === 0)) // 第一轮全部 beat 0

  env.bridge.advanceBeat() // 轮次外（上一轮已结束）：冲刷空缓冲 no-op 后自增（附着仍在），不影响下一轮归零
  await env.feed(env.phoneSend('第二轮'))
  posted = env.readPostedEnvelopes().filter((p) => p.type === 'chat.event')
  const secondRound = posted.filter((p) => p.replyTo === posted[posted.length - 1].replyTo)
  assert.ok(secondRound.every((p) => p.body['beat'] === 0)) // 第二轮重新从 0 开始
})

test('M5 mode.set：合法值写真相源（by=phone）；非法值 fail-closed 回推当前 mode.state', async () => {
  const env = makeBridgeEnv()
  const mk = (mode: string, n: number): BoxMessage => ({
    id: 900 + n,
    blob: encryptEnvelope(env.secrets.keyM2D, env.myBox, 'm2d', makeEnvelope('mode.set', env.peerBox, env.myBox, { mode }))!,
  })
  await env.feed(mk('fullAccess', 1))
  assert.deepEqual(env.modeSetCalls, [{ mode: 'fullAccess', by: 'phone' }])
  // 非法值：不写真相源 + 回推当前档愈合手机视图
  await env.feed(mk('godmode', 2))
  assert.equal(env.modeSetCalls.length, 2)
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'mode.state')
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body['mode'], 'fullAccess') // 当前真相（非法值未写入）
})

test('M5 resyncModeState：补推当前档；confirmed 门控', async () => {
  const env = makeBridgeEnv()
  env.setCurrentMode('fullAccess')
  env.bridge.resyncModeState()
  await new Promise((r) => setTimeout(r, 20))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'mode.state')
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body['mode'], 'fullAccess')

  const env2 = makeBridgeEnv({ confirmed: false })
  env2.bridge.resyncModeState()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env2.readPostedEnvelopes().length, 0)
})


// ---------- M6：附着模型 / 目录对账 / 历史分页 ----------

test('M6 session.attach：请求-确认制（每次都回 attached.changed，含附着未变的重 announce）', async () => {
  const env = makeBridgeEnv()
  assert.equal(env.bridge.getAttachedSessionId(), null)

  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-a' }))
  let posted = env.readPostedEnvelopes()
  assert.equal(env.bridge.getAttachedSessionId(), 's-a')
  assert.deepEqual(posted.map((e) => `${e.type}:${String(e.body['kind'])}:${String(e.body['sessionId'])}`), [
    'session.event:attached.changed:s-a',
  ])
  assert.equal(env.acks().length, 1)

  // 重 announce（附着未变）：仍回确认（手机未收到确认前显示"同步中"，不假落定）
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-a' }))
  posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 2)
  assert.equal(posted[1].body['sessionId'], 's-a')

  // 脱离：attach null → 确认 null
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: null }))
  posted = env.readPostedEnvelopes()
  assert.equal(env.bridge.getAttachedSessionId(), null)
  assert.equal(posted[2].body['sessionId'], null)
})

test('M6 本地轮镜像：附着后 pushStreamChunk 出向（无 replyTo 锚、带 sessionId 归属戳）；他会话丢弃', async () => {
  const env = makeBridgeEnv()
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-watch' }))
  env.readPostedEnvelopes() // 清确认

  // 本地轮（桌面 TUI 发起）：delta/reasoning 经被动流入口流入
  env.bridge.pushStreamChunk({ sessionId: 's-watch', kind: 'delta', text: '本地轮正文' })
  env.bridge.pushStreamChunk({ sessionId: 's-watch', kind: 'reasoning', text: '本地轮思考' })
  env.bridge.pushStreamChunk({ sessionId: 's-other', kind: 'delta', text: '别会话的不发' })
  // 等待聚合窗口（200ms）冲刷
  await new Promise((r) => setTimeout(r, 300))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'chat.event')
  assert.deepEqual(posted.map((p) => String(p.body['kind'])), ['delta', 'reasoning'])
  assert.ok(posted.every((p) => p.replyTo === undefined)) // 本地镜像轮无 replyTo 锚
  assert.ok(posted.every((p) => p.body['sessionId'] === 's-watch'))
})

test('M6 catalog.sync：known 为空 → full 全量应答（同 replyTo 归组）', async () => {
  const env = makeBridgeEnv()
  env.bridge['deps'].buildCatalogState = async (known) => {
    assert.deepEqual(known, {})
    return {
      projects: [{ id: 'p1', name: '项目p1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', order: 1 }],
      sessions: [{ id: 's1', title: '会话1', projectId: 'p1', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', preview: '预览' }],
      activeSessionId: 's1',
      projectsRev: 'rev1',
      full: true,
    }
  }
  const req = env.phoneEnvelope('catalog.sync', {})
  await env.feed(req)
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1)
  assert.equal(posted[0].type, 'catalog.state')
  assert.equal(posted[0].body['full'], true)
  assert.equal(posted[0].body['projectsRev'], 'rev1')
  assert.equal((posted[0].body['sessions'] as unknown[]).length, 1)
  assert.equal(posted[0].replyTo !== undefined, true)
  assert.equal(env.acks().length, 1)
})

test('M6 catalog.sync：增量应答（deletes 携带消失会话；超 45KB 预算自动分 chunk，同 replyTo 归组）', async () => {
  const env = makeBridgeEnv()
  // 造 300 条 × ~200B 的 sessions（约 60KB 总量）触发分片
  const bigSessions = Array.from({ length: 300 }, (_, i) => ({
    id: `s-${i}`,
    title: `会话标题${i}`.padEnd(60, '长'),
    projectId: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    preview: `预览内容${i}`.padEnd(60, '长'),
  }))
  env.bridge['deps'].buildCatalogState = async () => ({
    projects: [],
    sessions: bigSessions,
    deletes: ['s-gone'],
    activeSessionId: null,
    projectsRev: 'rev2',
    full: false,
  })
  await env.feed(env.phoneEnvelope('catalog.sync', { projectsRev: 'rev1', sessions: {} }))
  const posted = env.readPostedEnvelopes().filter((e) => e.type === 'catalog.state')
  assert.ok(posted.length >= 2) // 超预算 → 多 chunk
  const chunks = posted.map((p) => p.body['chunks'])
  assert.ok(chunks.every((c) => c === posted.length))
  assert.deepEqual(posted.map((p) => p.body['chunk']), posted.map((_, i) => i)) // 0 起单调
  const replyTos = new Set(posted.map((p) => p.replyTo))
  assert.equal(replyTos.size, 1) // 同 replyTo 归组
  // 全量 sessions 分片后并集完整；chunk 0 携带 deletes
  const merged = posted.flatMap((p) => p.body['sessions'] as { id: string }[])
  assert.equal(merged.length, 300)
  assert.deepEqual(posted[0].body['deletes'], ['s-gone'])
  // 每片明文都在预算内（分片的意义）
  const { PLAINTEXT_BUDGET_BYTES } = await import('../../src/services/relay/envelope.ts')
  for (const p of posted) {
    assert.ok(new TextEncoder().encode(JSON.stringify(p.body)).length <= PLAINTEXT_BUDGET_BYTES)
  }
})

test('M6 history.request：分页应答 history.page（replyTo=请求信封归组；before/limit 透传闭包）', async () => {
  const env = makeBridgeEnv()
  const seen: { sessionId: string; before?: string; limit?: number }[] = []
  env.bridge['deps'].pageHistory = async (sessionId, before, limit) => {
    seen.push({ sessionId, ...(before !== undefined ? { before } : {}), ...(limit !== undefined ? { limit } : {}) })
    return {
      sessionId,
      messages: [{ msgKey: 'user:2026-09-10T00:00:00.000Z', role: 'user', kind: 'text', ts: '2026-09-10T00:00:00.000Z', text: '早' }],
      done: true,
    }
  }
  const req = env.phoneEnvelope('history.request', { sessionId: 's-h', before: 'user:2026-09-10T00:00:05.000Z', limit: 10 })
  await env.feed(req)
  assert.deepEqual(seen, [{ sessionId: 's-h', before: 'user:2026-09-10T00:00:05.000Z', limit: 10 }])
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1)
  assert.equal(posted[0].type, 'history.page')
  assert.equal(posted[0].body['sessionId'], 's-h')
  assert.equal(posted[0].body['done'], true)
  assert.equal((posted[0].body['messages'] as unknown[]).length, 1)
  assert.ok(typeof posted[0].replyTo === 'string' && posted[0].replyTo!.length > 0) // replyTo=请求信封 id 归组
  assert.equal(env.acks().length, 1)
})

test('M6 发言即附着+激活：目标 ≠ 当前会话 → 先切（ensureActiveSession）再注入，附着确认先行', async () => {
  const env = makeBridgeEnv() // 当前 = s-current
  await env.feed(env.phoneSend('在旧会话里续聊', undefined, 's-old'))
  assert.deepEqual(env.ensureCalls, ['s-old']) // 切换守卫被调用
  assert.deepEqual(env.enqueued, ['在旧会话里续聊']) // 切换成功后注入
  const posted = env.readPostedEnvelopes()
  // attached.changed(s-old) 确认 + final
  assert.equal(posted[0].type, 'session.event')
  assert.equal(posted[0].body['kind'], 'attached.changed')
  assert.equal(posted[0].body['sessionId'], 's-old')
  assert.equal(posted[posted.length - 1].body['kind'], 'final')
  assert.equal(env.bridge.getAttachedSessionId(), 's-old')
})

test('M6 发言即附着：守卫拒绝（busy）→ 诚实 notice"桌面正忙，无法切换会话"，不注入不假消息', async () => {
  const env = makeBridgeEnv()
  env.setEnsureResult('busy')
  await env.feed(env.phoneSend('忙时插入', undefined, 's-old'))
  assert.deepEqual(env.enqueued, []) // 未注入
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1)
  assert.equal(posted[0].type, 'chat.event')
  assert.equal(posted[0].body['kind'], 'notice')
  assert.equal(posted[0].body['text'], '桌面正忙，无法切换会话')
  assert.equal(env.acks().length, 1) // 回答已消费：ACK（重投只会再撞守卫）
  assert.equal(env.bridge.getAttachedSessionId(), null) // 附着未被切换
})

test('M6 发言即附着：会话不存在（notfound）→ notice 告知；同会话发言不重复确认附着', async () => {
  const env = makeBridgeEnv()
  env.setEnsureResult('notfound')
  await env.feed(env.phoneSend('找不存在的', undefined, 's-ghost'))
  assert.deepEqual(env.enqueued, [])
  const posted = env.readPostedEnvelopes()
  assert.equal(posted[0].body['text'], '该会话不存在或已被桌面删除')

  // 目标 = 当前会话：不调守卫、附着切到当前并确认一次；同会话再发言不重复确认
  const env2 = makeBridgeEnv()
  await env2.feed(env2.phoneSend('第一条', undefined, 's-current'))
  assert.deepEqual(env2.ensureCalls, []) // 目标已是当前会话，无需切换
  assert.equal(env2.bridge.getAttachedSessionId(), 's-current')
  const events1 = env2.readPostedEnvelopes().filter((e) => e.type === 'session.event')
  assert.equal(events1.length, 1)
  await env2.feed(env2.phoneSend('第二条', undefined, 's-current'))
  const events2 = env2.readPostedEnvelopes().filter((e) => e.type === 'session.event')
  assert.equal(events2.length, 1) // 附着未变，不重复确认
})

test('M6 兼容路径：旧端 chat.user 无 sessionId → 跟随当前会话镜像，轮次落定收编附着并确认', async () => {
  const env = makeBridgeEnv({ currentSessionId: 's-legacy' })
  env.bridge['deps'].enqueue = async (text): Promise<EnqueueResult> => {
    // 旧端轮次：流式经被动流入口（sessionId 现读当前会话）
    env.bridge.pushStreamChunk({ sessionId: 's-legacy', kind: 'delta', text: '旧端轮增量' })
    return { content: `回复:${text}`, aborted: false }
  }
  await env.feed(env.phoneSend('旧端发言'))
  const posted = env.readPostedEnvelopes()
  const kinds = posted.map((p) => `${p.type}:${String(p.body['kind'])}`)
  assert.deepEqual(kinds, ['chat.event:delta', 'chat.event:final', 'session.event:attached.changed'])
  assert.equal(posted[2].body['sessionId'], 's-legacy') // 落定后收编附着
  assert.equal(env.bridge.getAttachedSessionId(), 's-legacy')
})

test('M6 owner 易主：announceAttachReset 推 attached.changed(null)，实例内幂等（重连不重推）', async () => {
  const env = makeBridgeEnv()
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-x' }))
  const baseline = env.readPostedEnvelopes().length // 附着确认已在（readPostedEnvelopes 为累积读）

  env.bridge.announceAttachReset()
  await new Promise((r) => setTimeout(r, 20))
  let posted = env.readPostedEnvelopes()
  assert.equal(posted.length, baseline + 1)
  assert.equal(posted[baseline].type, 'session.event')
  assert.equal(posted[baseline].body['kind'], 'attached.changed')
  assert.equal(posted[baseline].body['sessionId'], null)
  assert.equal(env.bridge.getAttachedSessionId(), null)

  // 重连再调：实例内幂等，不重复推（防与手机热重连的重 announce 对打）
  env.bridge.announceAttachReset()
  await new Promise((r) => setTimeout(r, 20))
  posted = env.readPostedEnvelopes()
  assert.equal(posted.length, baseline + 1)
})

test('M6 session.event 出向：pushSessionEvent 各 kind 透传（confirmed 门控）', async () => {
  const env = makeBridgeEnv({ confirmed: false })
  env.bridge.pushSessionEvent({ kind: 'session.deleted', sessionId: 's-d' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env.readPostedEnvelopes().length, 0) // 未配对不推

  const env2 = makeBridgeEnv()
  env2.bridge.pushSessionEvent({ kind: 'history.invalidated', sessionId: 's-h' })
  env2.bridge.pushSessionEvent({ kind: 'metadata.upsert', session: { id: 's-m', title: 't', projectId: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', preview: '' } })
  env2.bridge.pushSessionEvent({ kind: 'active.changed', sessionId: 's-m' })
  await new Promise((r) => setTimeout(r, 20))
  const posted = env2.readPostedEnvelopes()
  assert.deepEqual(
    posted.map((e) => `${e.type}:${String(e.body['kind'])}`),
    ['session.event:history.invalidated', 'session.event:metadata.upsert', 'session.event:active.changed'],
  )
  assert.equal((posted[1].body['session'] as { id: string }).id, 's-m')
})

test('M6 快速路径：session.attach/catalog.sync/history.request 不排在被审批楔死的轮次后', async () => {
  const env = makeBridgeEnv()
  let releaseRound: (r: EnqueueResult) => void = () => {}
  const roundGate = new Promise<EnqueueResult>((res) => {
    releaseRound = res
  })
  env.bridge['deps'].enqueue = () => roundGate // 轮次挂起（模拟等审批）
  env.bridge['deps'].buildCatalogState = async () => ({
    projects: [], sessions: [], activeSessionId: 's-current', projectsRev: 'r', full: true,
  })
  env.bridge['deps'].pageHistory = async (sessionId) => ({ sessionId, messages: [], done: true })

  const feedPromise = env.feed(env.phoneSend('触发长轮次'))
  await new Promise((r) => setTimeout(r, 50)) // 轮次已阻塞在 enqueue

  // 链后还有一条普通消息排队，三个 M6 信封必须全部走快速路径立即应答
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-fast' }))
  await env.feed(env.phoneEnvelope('catalog.sync', {}))
  await env.feed(env.phoneEnvelope('history.request', { sessionId: 's-fast' }))
  const posted = env.readPostedEnvelopes()
  assert.deepEqual(posted.map((p) => p.type), ['session.event', 'catalog.state', 'history.page'])
  assert.equal(env.bridge.getAttachedSessionId(), 's-fast')

  releaseRound({ content: '完成', aborted: false })
  await feedPromise
})


// ---------- M6b：chat.user sessionId='new' 分支 ----------

test("M6b 'new' 分支：守卫过 → 轮前附着到新会话（attached.changed 先于轮内流式）→ 注入执行", async () => {
  const env = makeBridgeEnv()
  env.bridge['deps'].enqueue = async (input): Promise<EnqueueResult> => {
    env.enqueued.push(input.text) // 覆盖默认实现后手动记账（默认闭包才被 env.enqueued 捕获）
    // 轮中流式：附着已在轮前切到 s-newborn，门控放行
    env.bridge.pushStreamChunk({ sessionId: 's-newborn', kind: 'delta', text: '新会话首轮增量' })
    return { content: `回复:${input.text}`, aborted: false }
  }
  await env.feed(env.phoneSend('第一句话', undefined, 'new'))
  assert.equal(env.newSessionCalls.length, 1) // 守卫被调用
  assert.deepEqual(env.enqueued, ['第一句话']) // 注入发生
  assert.deepEqual(env.ensureCalls, []) // 'new' 不走旧会话切换守卫
  const posted = env.readPostedEnvelopes()
  const kinds = posted.map((p) => `${p.type}:${String(p.body['kind'])}`)
  assert.deepEqual(kinds, ['session.event:attached.changed', 'chat.event:delta', 'chat.event:final'])
  assert.equal(posted[0].body['sessionId'], 's-newborn') // 轮前附着确认先行
  assert.equal(env.bridge.getAttachedSessionId(), 's-newborn')
  // 轮内 delta 带新会话归属戳
  assert.equal(posted[1].body['sessionId'], 's-newborn')
})

test("M6b 'new' 分支：守卫忙 → 诚实 notice'桌面正忙，无法新建会话'，不注入、附着不动", async () => {
  const env = makeBridgeEnv()
  env.setNewSessionResult('busy')
  await env.feed(env.phoneSend('忙时新建', undefined, 'new'))
  assert.deepEqual(env.enqueued, [])
  const posted = env.readPostedEnvelopes()
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body['kind'], 'notice')
  assert.equal(posted[0].body['text'], '桌面正忙，无法新建会话')
  assert.equal(env.bridge.getAttachedSessionId(), null)
  assert.equal(env.acks().length, 1)
})

test('M6c presence.ping：立即回 presence.pong（快速路径，不碰引擎）；重复 id 幂等', async () => {
  const env = makeBridgeEnv()
  await env.feed(env.phoneEnvelope('presence.ping', {}, 'ping-1'))
  const posted = env.readPostedEnvelopes()
  assert.deepEqual(posted.map((e) => e.type), ['presence.pong'])
  assert.equal(env.enqueued.length, 0) // 不碰引擎
  assert.equal(env.acks().length, 1)
  // 重投同 id：去重后仍 ACK，不产生第二个 pong（信箱重投幂等）
  await env.feed(env.phoneEnvelope('presence.ping', {}, 'ping-1'))
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'presence.pong').length, 1)
})

test('M6c round.settled：附着会话的轮落定通告出向；非附着会话不发', async () => {
  const env = makeBridgeEnv()
  env.bridge.pushRoundSettled('s-current') // 未附着：不发
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'session.event').length, 0)
  // 经 attach 建立附着后发
  await env.feed(env.phoneEnvelope('session.attach', { sessionId: 's-current' }))
  env.bridge.pushRoundSettled('s-current')
  env.bridge.pushRoundSettled('s-other') // 非附着会话：不发
  await new Promise((r) => setTimeout(r, 20))
  const events = env.readPostedEnvelopes().filter((e) => e.type === 'session.event' && e.body['kind'] === 'round.settled')
  assert.equal(events.length, 1)
  assert.equal(events[0]!.body['sessionId'], 's-current')
})
