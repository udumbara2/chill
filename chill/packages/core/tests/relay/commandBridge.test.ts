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
import type { CommandExecutorResult, CommandStateSnapshot } from '../../src/services/commands/commandSurface.ts'

/** M8 命令面桥测试环境（模式对齐 relayBridge.test.ts 的 makeBridgeEnv，仅保留 cmd.* 所需） */
function makeCmdBridgeEnv(over: { confirmed?: boolean; noExec?: boolean } = {}) {
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
  const posts: { path: string; body: { blob?: string; id?: number } }[] = []
  const http: RelayHttp = {
    request: async (method, path, opts = {}) => {
      if (method === 'POST') posts.push({ path, body: (opts.body ?? {}) as never })
      return { status: path.endsWith('/ack') ? 204 : 201, json: { id: 1 } }
    },
  }
  const alarms: string[] = []
  /** enqueue 闸门：chat.user 占链用（手动放行） */
  let releaseEnqueue: (() => void) | null = null
  const enqueued: string[] = []
  const execCalls: { cmd: string; args?: Record<string, unknown> }[] = []
  let execImpl: (cmd: string, args?: Record<string, unknown>) => Promise<CommandExecutorResult> = async () => ({
    ok: false,
    error: { code: 'unsupported', message: '未设' },
  })
  const stateImpl = (): CommandStateSnapshot => ({
    sessionId: 's-1',
    running: false,
    plan: true,
    model: { name: 'GLM-5.3', effort: 'high' },
    front: null,
    goal: null,
    ctx: { used: 48200, max: 200000 },
  })

  const bridge = new RelayBridge({
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
    enqueue: async (text): Promise<EnqueueResult> => {
      enqueued.push(text)
      await new Promise<void>((r) => {
        releaseEnqueue = r
      })
      return { content: `回复:${text}`, aborted: false }
    },
    resolveApproval: () => true,
    listPendingApprovals: () => [],
    onAlarm: (m) => alarms.push(m),
    ...(over.noExec ? {} : {
      executeCmd: async (cmd: string, args?: Record<string, unknown>) => {
        execCalls.push({ cmd, args })
        return execImpl(cmd, args)
      },
      getCommandState: stateImpl,
    }),
  })
  bridge.start()

  function phoneEnvelope(type: string, body: Record<string, unknown>, id?: string): BoxMessage {
    const env = makeEnvelope(type, peerBox, myBox, body)
    if (id) env.id = id
    return { id: posts.length + 100, blob: encryptEnvelope(secrets.keyM2D, myBox, 'm2d', env)! }
  }
  function readPostedEnvelopes(): Envelope[] {
    return posts
      .filter((p) => p.path === `/box/${peerBox}` && typeof p.body.blob === 'string')
      .map((p) => decryptEnvelope(secrets.keyD2M, peerBox, 'd2m', p.body.blob as string))
      .filter((d) => d.ok)
      .map((d) => (d as { ok: true; envelope: Envelope }).envelope)
  }
  const ackCount = () => posts.filter((p) => p.path.endsWith('/ack')).length
  async function feed(msg: BoxMessage): Promise<void> {
    msgHandler(msg)
    await new Promise((r) => setTimeout(r, 25))
  }
  return {
    bridge, phoneEnvelope, readPostedEnvelopes, ackCount, feed, alarms, enqueued, execCalls,
    setExec: (fn: typeof execImpl) => {
      execImpl = fn
    },
    releaseChain: () => {
      releaseEnqueue?.()
      releaseEnqueue = null
    },
  }
}

test('cmd.sync → ACK + cmd.state 全量（含 catalog）', async () => {
  const env = makeCmdBridgeEnv()
  await env.feed(env.phoneEnvelope('cmd.sync', {}))
  assert.equal(env.ackCount(), 1)
  const states = env.readPostedEnvelopes().filter((e) => e.type === 'cmd.state')
  assert.equal(states.length, 1)
  const body = states[0]!.body as { state: CommandStateSnapshot; catalog?: { id: string }[] }
  assert.equal(body.state.sessionId, 's-1')
  assert.equal(body.state.ctx?.used, 48200)
  assert.ok(body.catalog && body.catalog.length >= 10, '目录随 cmd.sync 附带')
  assert.ok(!body.catalog!.some((c) => c.id === 'model.list'), 'internal 选项源不出目录')
})

test('cmd.sync 幂等：同信封 id 重投不二次推', async () => {
  const env = makeCmdBridgeEnv()
  const msg = env.phoneEnvelope('cmd.sync', {}, 'dup-id-1')
  await env.feed(msg)
  await env.feed(msg)
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'cmd.state').length, 1)
})

test('cmd.request fast（model.list）：串行链被运行轮占据时即时返回（D2 回归锚点）', async () => {
  const env = makeCmdBridgeEnv()
  env.setExec(async () => ({ ok: true, data: { options: [{ name: 'GLM-5.3' }] } }))
  // 占链：chat.user 的 enqueue 挂在闸门上不放行
  await env.feed(env.phoneEnvelope('chat.user', { text: '慢轮次' }))
  assert.equal(env.enqueued.length, 1)
  // fast 命令：不等链放行即应答
  await env.feed(env.phoneEnvelope('cmd.request', { id: 'req-1', cmd: 'model.list' }))
  const results = env.readPostedEnvelopes().filter((e) => e.type === 'cmd.result')
  assert.equal(results.length, 1, '链仍被占，fast 命令已应答')
  assert.equal((results[0]!.body as { ok: boolean }).ok, true)
  env.releaseChain()
  await new Promise((r) => setTimeout(r, 25))
})

test('cmd.request serial（model.set）：排队到运行轮结束后执行并回流 cmd.state', async () => {
  const env = makeCmdBridgeEnv()
  env.setExec(async () => ({ ok: true, data: {} }))
  await env.feed(env.phoneEnvelope('chat.user', { text: '慢轮次' }))
  await env.feed(env.phoneEnvelope('cmd.request', { id: 'req-2', cmd: 'model.set', args: { name: 'Kimi-K3' } }))
  // 链未放行：不应有 result
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'cmd.result').length, 0)
  env.releaseChain()
  await new Promise((r) => setTimeout(r, 40))
  const posted = env.readPostedEnvelopes()
  const result = posted.find((e) => e.type === 'cmd.result')
  assert.ok(result, '链放行后 serial 命令应答')
  assert.equal((result!.body as { replyTo: string }).replyTo, 'req-2')
  assert.deepEqual(env.execCalls, [{ cmd: 'model.set', args: { name: 'Kimi-K3' } }])
  // 成功执行后必推 cmd.state（三保底之一）
  assert.ok(posted.some((e) => e.type === 'cmd.state'), '执行后推送 cmd.state')
})

test('cmd.request 未知命令 fail-closed 回 unsupported', async () => {
  const env = makeCmdBridgeEnv()
  await env.feed(env.phoneEnvelope('cmd.request', { id: 'req-3', cmd: 'nope' }))
  const result = env.readPostedEnvelopes().find((e) => e.type === 'cmd.result')
  assert.ok(result)
  const body = result!.body as { ok: boolean; error: { code: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'unsupported')
})

test('cmd.request 参数非法 fail-closed 回 invalid_args（不触达执行器）', async () => {
  const env = makeCmdBridgeEnv()
  await env.feed(env.phoneEnvelope('cmd.request', { id: 'req-4', cmd: 'plan.set', args: { on: 'yes' } }))
  const result = env.readPostedEnvelopes().find((e) => e.type === 'cmd.result')
  assert.ok(result)
  const body = result!.body as { ok: boolean; error: { code: string } }
  assert.equal(body.error.code, 'invalid_args')
  assert.equal(env.execCalls.length, 0)
})

test('M1 dormant：executeCmd 未装配 → 诚实 unsupported，不抛错', async () => {
  const env = makeCmdBridgeEnv({ noExec: true })
  await env.feed(env.phoneEnvelope('cmd.request', { id: 'req-5', cmd: 'turn.stop' }))
  assert.equal(env.execCalls.length, 0)
  const result = env.readPostedEnvelopes().find((e) => e.type === 'cmd.result')
  assert.ok(result, '仍应有诚实应答')
  const body = result!.body as { ok: boolean; error: { code: string; message: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'unsupported')
  assert.match(body.error.message, /未装配/)
})

test('未知信封类型：静默 ACK 忽略，无报警（D8 数据前向兼容）', async () => {
  const env = makeCmdBridgeEnv()
  await env.feed(env.phoneEnvelope('cmd.progress', { anything: 1 }))
  assert.equal(env.ackCount(), 1)
  assert.equal(env.alarms.length, 0)
  assert.equal(env.readPostedEnvelopes().length, 0)
})

test('未配对确认：cmd.* 进链路径被 pre-confirm 丢弃计数，不执行', async () => {
  const env = makeCmdBridgeEnv({ confirmed: false })
  await env.feed(env.phoneEnvelope('cmd.request', { id: 'req-6', cmd: 'turn.stop' }))
  assert.equal(env.execCalls.length, 0)
  assert.equal(env.readPostedEnvelopes().filter((e) => e.type === 'cmd.result').length, 0)
})
