import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge } from '../../src/services/relay/RelayBridge.ts'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
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

/**
 * M1 引擎级验收（多会话并行规划五-4 第二层）：真 ChatEngine ×2 + 真桥——压轴断言
 * 「A 轮次进行中，B 的注入即刻开跑」在真引擎语义下成立（sendMessage running-throw
 * 的排队由入向链分键消化，两引擎轮次真并行）。
 */

interface EngineHeld {
  engine: ChatEngine
  /** FIFO 待决模型调用（首轮主调用 + 首轮自动标题等同引擎的后续调用） */
  pendingQueue: Array<{ resolve: (content: string) => void }>
}

function makeRealEngine(): EngineHeld {
  const held: EngineHeld = {
    engine: null as unknown as ChatEngine,
    pendingQueue: [],
  }
  const deps: ChatEngineDeps = {
    // 受控模型调用：挂起入队直到排空——压轴断言的数据源（真 sendMessage 轮次）
    modelCaller: {
      callOnce: () =>
        new Promise((resolve) => {
          held.pendingQueue.push({ resolve: (content: string) => resolve({ content }) })
        }),
    },
    modelInfo: { getModelsWithApiKeys: async () => [], getModelInfoByName: () => undefined } as never,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as never,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: false }),
    } as never,
    builtInToolExecutor: {} as never,
    mcpService: { getAggregatedOpenAITools: async () => [] } as never,
  }
  held.engine = new ChatEngine(deps)
  return held
}

/** 排空引擎的全部待决模型调用直至轮次落定（FIFO——主调用与标题调用按序放行） */
async function drainEngine(held: EngineHeld, reply: string, tick: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 2000
  while (held.engine.getSessionState().isRunning && Date.now() < deadline) {
    if (held.pendingQueue.length === 0) {
      await tick()
      continue
    }
    held.pendingQueue.shift()!.resolve(reply)
    await tick()
  }
  assert.equal(held.engine.getSessionState().isRunning, false, '排空后轮次落定')
}

test('M1 引擎级压轴：A 轮次进行中（真 sendMessage），B 注入即刻开跑——两引擎轮次真并行', async () => {
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  let msgHandler: (msg: BoxMessage) => void = () => {}
  const transport: RelayTransport = {
    connect: async () => {}, close: () => {}, connected: true,
    onMessage: (cb) => { msgHandler = cb }, onClose: () => {},
  }
  const posts: { path: string; body: { blob?: string } }[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') posts.push({ path, body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }
  const a = makeRealEngine()
  const b = makeRealEngine()
  const registry = new Map<string, ChatEngine>()
  let activeSessionId: string | null = null
  const alarms: string[] = []
  const bridge = new RelayBridge({
    transport, http, secrets, myBox, peerBox,
    deskPub: desk.publicKey, phonePub: phone.publicKey,
    deviceName: '引擎级测试', pairingToken: 't', confirmed: true,
    // M1 直寻装配（与 serveSessions.resolveEngine 同形）：id 命中注册表，否则回退活跃
    enqueue: (input) => {
      const hit = input.sessionId !== undefined ? registry.get(input.sessionId) : undefined
      const engine = hit ?? (activeSessionId !== null ? registry.get(activeSessionId)! : a.engine)
      return engine.enqueueExternalMessage(
        { text: input.text, origin: 'mobile', ...(input.clientId ? { clientId: input.clientId } : {}) },
      )
    },
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    getActiveSessionId: () => activeSessionId,
    ensureActiveSession: async (id) => {
      activeSessionId = id
      return 'ok' as const
    },
    ensureNewSession: async () => 'ok' as const,
    onAlarm: (m) => alarms.push(m),
  })
  bridge.start()
  try {
    // 会话 id 铸造（真引擎 ensureSessionId）后登记注册表——模拟 serve registry.open 的产物
    a.engine.ensureSessionId()
    b.engine.ensureSessionId()
    const sidA = a.engine.getSessionState().sessionId!
    const sidB = b.engine.getSessionState().sessionId!
    registry.set(sidA, a.engine)
    registry.set(sidB, b.engine)
    activeSessionId = sidA

    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))
    const phoneSend = (text: string, id: string, sessionId: string): void => {
      const env = makeEnvelope('chat.user', peerBox, myBox, { text, sessionId })
      env.id = id
      msgHandler({ id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! })
    }
    const waitUntil = async (cond: () => boolean, ms = 800): Promise<void> => {
      const deadline = Date.now() + ms
      while (!cond() && Date.now() < deadline) await tick()
      assert.ok(cond(), 'waitUntil 超时')
    }

    // A 发言 → 真 sendMessage 轮次开跑（主模型调用挂起中）
    phoneSend('A 的任务', 'env-ea', sidA)
    await waitUntil(() => a.engine.getSessionState().isRunning && a.pendingQueue.length >= 1)
    // 压轴：B 发言——必须即刻注入并开跑（旧全局入向链会排在 A 的整轮之后）
    phoneSend('B 的任务', 'env-eb', sidB)
    await waitUntil(() => b.engine.getSessionState().isRunning && b.pendingQueue.length >= 1)
    assert.equal(a.engine.getSessionState().isRunning, true, 'A 仍在跑（B 开跑时未被楔/未被打断）')

    // 放行排空：A 落定 → B 落定；两个 final 各自回执（含首轮自动标题的同引擎后续调用）
    await drainEngine(a, 'A 的回复', tick)
    await drainEngine(b, 'B 的回复', tick)
    const posted = posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
    const finals = posted.filter((e) => e.type === 'chat.event' && e.body['kind'] === 'final')
    assert.equal(finals.length, 2, '两会话各自 final 回执')
    assert.ok(finals.some((e) => e.replyTo === 'env-ea' && e.body['text'] === 'A 的回复'))
    assert.ok(finals.some((e) => e.replyTo === 'env-eb' && e.body['text'] === 'B 的回复'))
    assert.deepEqual(alarms, [], '零告警')
  } finally {
    bridge.stop()
    a.engine.dispose()
    b.engine.dispose()
  }
})
