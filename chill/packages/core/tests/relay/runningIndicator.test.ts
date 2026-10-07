import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RelayBridge, type EnqueueResult } from '../../src/services/relay/RelayBridge.ts'
import { wireRunningTransitions, buildCatalogStateBody } from '../../src/services/relayEngineWiring.ts'
import { SessionRegistry } from '../../src/services/sessionRegistry/SessionRegistry.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { ChatEngine } from '../../src/engine/ChatEngine.ts'
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
 * 运行态标志（2026-10-04）回归：
 * - 桥推送不做镜像门控（后台会话也推——与 pushRoundSettled 的关键差异）/ 空 id no-op
 * - runningAll 生产时刻随行 + 纯快照形态（pushRunningSnapshot）+ 未注入省略（旧语义）
 * - wiring 双向转换（TURN_STARTED/SETTLED）+ 周期重申 interval 装拆
 * - buildCatalogStateBody 透传 runningSessionIds（注入=携带 / 缺省=省略）
 * - SessionRegistry.runningSessionIds 查询正确性（判定单源）
 */

interface Rig {
  bridge: RelayBridge
  setRunning: (ids: string[]) => void
  readDelivered: () => Envelope[]
  tick: () => Promise<void>
}

/** 真桥 + 内存 transport/http：可注入 getRunningSessionIds、可关闭 confirmed */
function makeRig(opts: { injectRunning?: boolean; confirmed?: boolean } = {}): Rig {
  const desk: KeyPairB64 = generateKeyPair()
  const phone: KeyPairB64 = generateKeyPair()
  const secrets = deriveSecrets(ecdhShared(desk.secretKey, phone.publicKey))
  const myBox = mailboxIdFromPub(desk.publicKey)
  const peerBox = mailboxIdFromPub(phone.publicKey)
  const msgHandler: (msg: BoxMessage) => void = () => {}
  const transport: RelayTransport = {
    connect: async () => {}, close: () => {}, connected: true,
    onMessage: (cb) => { void cb; void msgHandler }, onClose: () => {},
  }
  const posts: Array<{ path: string; body: { blob?: string }; status: number }> = []
  const http: RelayHttp = {
    request: async (method, p, o = {}) => {
      if (method === 'POST') {
        posts.push({ path: p, body: (o.body ?? {}) as never, status: p.endsWith('/ack') ? 204 : 201 })
        return { status: p.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
      }
      return { status: 200, json: {} }
    },
  }
  let runningIds: string[] = []
  const bridge = new RelayBridge({
    transport, http, secrets, myBox, peerBox,
    deskPub: desk.publicKey, phonePub: phone.publicKey,
    deviceName: '运行态测试', pairingToken: 't', confirmed: opts.confirmed ?? true,
    enqueue: async (): Promise<EnqueueResult> => ({ content: 'ok', aborted: false }),
    ...(opts.injectRunning ? { getRunningSessionIds: () => runningIds } : {}),
    onAlarm: () => {},
  })
  return {
    bridge,
    setRunning: (ids) => { runningIds = ids },
    readDelivered: () =>
      posts
        .filter((p) => p.status === 201 && typeof p.body.blob === 'string')
        .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
        .filter((d) => d.ok)
        .map((d) => (d as { ok: true; envelope: Envelope }).envelope),
    tick: () => new Promise<void>((r) => setTimeout(r, 15)),
  }
}

function runningBodies(envs: Envelope[]): Array<Record<string, unknown>> {
  return envs.filter((e) => e.type === 'session.event' && e.body['kind'] === 'running.changed').map((e) => e.body)
}

test('running.changed 全线形：非附着会话照发（无镜像门控）+ runningAll 生产时刻随行 + 空id no-op', async () => {
  const rig = makeRig({ injectRunning: true })

  // 后台会话（从未 attach——若走镜像门控此处将丢弃）启动轮：runningAll=发送时刻全集
  rig.setRunning(['s-bg', 's-fg'])
  rig.bridge.pushRunningChanged('s-bg', true)
  await rig.tick(); await rig.tick()
  let bodies = runningBodies(rig.readDelivered())
  assert.equal(bodies.length, 1, '非附着会话照发（后台会话是本功能的意义）')
  assert.equal(bodies[0]!['sessionId'], 's-bg')
  assert.equal(bodies[0]!['running'], true)
  assert.deepEqual(bodies[0]!['runningAll'], ['s-bg', 's-fg'])

  // 落定：快照随行更新
  rig.setRunning(['s-fg'])
  rig.bridge.pushRunningChanged('s-bg', false)
  await rig.tick(); await rig.tick()
  bodies = runningBodies(rig.readDelivered())
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[1]!['runningAll'], ['s-fg'])

  // 纯快照形态（周期重申载体）：无 sessionId/running，仅 runningAll
  rig.bridge.pushRunningSnapshot()
  await rig.tick(); await rig.tick()
  bodies = runningBodies(rig.readDelivered())
  assert.equal(bodies.length, 3)
  assert.equal(bodies[2]!['sessionId'], undefined, '纯快照不带 sessionId')
  assert.equal(bodies[2]!['running'], undefined, '纯快照不带 running')
  assert.deepEqual(bodies[2]!['runningAll'], ['s-fg'])

  // 空 sessionId no-op（TURN_SETTLED 对无 id 引擎载荷为 ''）
  const before = runningBodies(rig.readDelivered()).length
  rig.bridge.pushRunningChanged('', true)
  await rig.tick()
  assert.equal(runningBodies(rig.readDelivered()).length, before, '空 id 不发')
})

test('未注入 getRunningSessionIds：增量照发、runningAll 省略、纯快照 no-op（旧语义兼容）', async () => {
  const rig = makeRig()
  rig.bridge.pushRunningChanged('s-a', true)
  await rig.tick(); await rig.tick()
  const bodies = runningBodies(rig.readDelivered())
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0]!['runningAll'], undefined, '未注入→runningAll 省略')

  rig.bridge.pushRunningSnapshot()
  await rig.tick(); await rig.tick()
  assert.equal(runningBodies(rig.readDelivered()).length, 1, '纯快照 no-op')
})

test('confirmed 门控：未确认配对前 running.changed/纯快照均不出站', async () => {
  const rig = makeRig({ injectRunning: true, confirmed: false })
  rig.setRunning(['s-a'])
  rig.bridge.pushRunningChanged('s-a', true)
  rig.bridge.pushRunningSnapshot()
  await rig.tick(); await rig.tick()
  assert.equal(runningBodies(rig.readDelivered()).length, 0, 'confirmed=false → 两形态均静默（继承 pushSessionEvent 门控）')
})

test('wiring 双向转换 + 周期重申 interval 装拆', async () => {
  const calls: Array<{ sessionId?: string; running?: boolean; snapshot?: boolean }> = []
  const duck = {
    pushRunningChanged: (id: string, running: boolean) => calls.push({ sessionId: id, running }),
    pushRunningSnapshot: () => calls.push({ snapshot: true }),
  } as Pick<RelayBridge, 'pushRunningChanged' | 'pushRunningSnapshot'>
  const off = wireRunningTransitions(duck, { reassertMs: 30 })

  eventBus.emit(EVENTS.TURN_STARTED, { sessionId: 's-1' })
  eventBus.emit(EVENTS.TURN_SETTLED, { sessionId: 's-1' })
  eventBus.emit(EVENTS.TURN_SETTLED, { sessionId: '' }) // 无 id 引擎：防御性跳过
  eventBus.emit(EVENTS.TURN_STARTED, { sessionId: 's-2' })
  assert.deepEqual(
    calls.filter((c) => !c.snapshot),
    [
      { sessionId: 's-1', running: true },
      { sessionId: 's-1', running: false },
      { sessionId: 's-2', running: true },
    ],
    'STARTED→true / SETTLED→false / 空 id 跳过',
  )

  await new Promise((r) => setTimeout(r, 45))
  assert.ok(calls.some((c) => c.snapshot), 'interval 到期触发周期纯快照重申')

  const countAtOff = calls.length
  off()
  eventBus.emit(EVENTS.TURN_STARTED, { sessionId: 's-3' })
  await new Promise((r) => setTimeout(r, 45))
  assert.equal(calls.length, countAtOff, '退订后 interval 与事件订阅均清理（无泄漏触发）')
})

test('buildCatalogStateBody：注入→runningSessionIds 携带；缺省→省略', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chill-running-test-'))
  try {
    const deps = {
      sessionsDir: dir,
      listProjects: async () => [],
      getActiveSessionId: () => null,
    }
    const withInjected = await buildCatalogStateBody(
      { ...deps, getRunningSessionIds: () => ['s-x'] },
      { sessions: {} },
    )
    assert.deepEqual(withInjected.runningSessionIds, ['s-x'], '注入→快照字段在场')

    const without = await buildCatalogStateBody(deps, { sessions: {} })
    assert.equal(without.runningSessionIds, undefined, '缺省→字段省略（旧语义）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SessionRegistry.runningSessionIds：只过滤 isRunning（判定单源）', () => {
  const mkEngine = (id: string, running: boolean): ChatEngine =>
    ({
      getSessionState: () => ({ sessionId: id, isRunning: running }),
      ensureSessionId: () => {},
      subscribeActiveSessionChanged: () => () => {},
      dispose: () => {},
    }) as unknown as ChatEngine
  const prepared = [mkEngine('s-run', true), mkEngine('s-idle', false), mkEngine('s-run2', true)]
  let idx = 0
  const reg = new SessionRegistry({ createEngine: () => prepared[idx++]! })
  assert.deepEqual(new SessionRegistry({ createEngine: () => prepared[0]! }).runningSessionIds(), [], '空注册表→空集')
  for (let i = 0; i < prepared.length; i++) reg.create()
  const running = reg.runningSessionIds().sort()
  assert.deepEqual(running, ['s-run', 's-run2'], '只返回 isRunning 引擎的 id')
  assert.equal(reg.runningSessionIds().length, 2, '闲置引擎不计')
})
