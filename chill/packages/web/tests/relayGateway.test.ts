/**
 * relay 网关契约测试（W1《WebUI中继支持》A2-5）
 *
 * 分层：
 * 1. 网关层（伪传输工厂 + 临时锁文件）：租约抢占/owner 记录与释放/最后连接全拆/
 *    预览守卫/事件广播；
 * 2. 端到端（真实 daemon dist/serve.js + 裸 WS 客户端）：relay:* 安全方法面
 *    （status/resolve-path/stat-file/transport-close）在 dispatch 表真实可达。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import type { NodeRelayBoxTransportEvents } from '@assistant-ai/core'
import { RelayGateway, type TransportLike } from '../src/relay/relayGateway'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'chill-relaygw-test-'))
}

/** 伪传输：捕获事件回调供测试驱动 */
class FakeTransport implements TransportLike {
  events: NodeRelayBoxTransportEvents | null = null
  closed = false
  connected = true
  async connect(events: NodeRelayBoxTransportEvents): Promise<void> {
    this.events = events
  }
  close(): void {
    this.closed = true
    this.connected = false
  }
}

interface Harness {
  gateway: RelayGateway
  transports: FakeTransport[]
  events: Array<{ n: string; d: unknown }>
  root: string
  clients: Set<object>
}

function makeGateway(root: string, opts: { isPreview?: () => boolean; ownerId?: string } = {}): Harness {
  const transports: FakeTransport[] = []
  const events: Array<{ n: string; d: unknown }> = []
  const clients = new Set<object>()
  const gateway = new RelayGateway({
    broadcast: (n, d) => events.push({ n, d }),
    hasClients: () => clients.size > 0,
    lockPath: join(root, 'relay.lock'),
    sessionsDir: join(root, 'sessions'),
    listProjects: async () => [],
    isPreview: opts.isPreview ?? (() => false),
    ownerId: opts.ownerId,
    transportFactory: () => {
      const t = new FakeTransport()
      transports.push(t)
      return t
    },
  })
  return { gateway, transports, events, root, clients }
}

/** 轮询等待条件成立（异步版——被等待的工作常在微任务里推进，同步阻塞会死锁事件循环） */
async function waitFor(cond: () => boolean, ms = 2000, what = '条件'): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------- 1. 网关层 ----------

test('网关：start 获租约；他端抢占 held-by-other；预览守卫', async () => {
  const root = tempRoot()
  try {
    const a = makeGateway(root, { ownerId: 'web:test-a' })
    assert.equal(await a.gateway.start(), 'started')
    assert.equal(existsSync(join(root, 'relay.lock')), true, '锁文件落盘')
    const owner = JSON.parse(readFileSync(join(root, 'relay.lock'), 'utf8')).owner as string
    assert.equal(owner, 'web:test-a', '持有者标识=注入值')

    const b = makeGateway(root, { ownerId: 'web:test-b' })
    assert.equal(await b.gateway.start(), 'held-by-other', '同锁他端 → 让位')

    const p = makeGateway(root, { isPreview: () => true })
    assert.equal(await p.gateway.start(), 'preview-no-relay', '体验形态不连')

    await a.gateway.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('网关：transportConnect 记录 owner；owner 断开 → 关传输+退租+广播 lease-lost', async () => {
  const root = tempRoot()
  try {
    const h = makeGateway(root)
    await h.gateway.start()
    const connA: object = {}
    const connB: object = {}
    h.clients.add(connA)
    h.clients.add(connB)

    await h.gateway.transportConnect(connA, { relayUrl: 'ws://127.0.0.1:1/box', mailboxId: 'm1', readToken: 'rt' })
    // 传输事件经 broadcast 透传
    h.transports[0].events!.onMessage({ id: 1, blob: 'AA' })
    assert.deepEqual(h.events[h.events.length - 1], { n: 'relay:transport-message', d: { id: 1, blob: 'AA' } })

    // owner 断开（另一标签仍在）→ 拆传输+退租+告知其余标签
    h.clients.delete(connA)
    h.gateway.onClientClose(connA, false)
    await waitFor(() => h.transports[0].closed, 1000, '传输关闭')
    await waitFor(() => h.events.some((e) => e.n === 'relay:lease-lost'), 1000, 'lease-lost 广播')
    await waitFor(() => !existsSync(join(root, 'relay.lock')), 1000, '租约已释放（无僵尸锁）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('网关：最后一条连接断开 → 全拆（双保险）；旁观者断开不触发', async () => {
  const root = tempRoot()
  try {
    const h = makeGateway(root)
    await h.gateway.start()
    const connA: object = {}
    h.clients.add(connA)
    await h.gateway.transportConnect(connA, { relayUrl: 'ws://127.0.0.1:1/box', mailboxId: 'm1', readToken: 'rt' })

    // 旁观者断开（owner 未断、非最后）→ 无动作
    h.gateway.onClientClose({}, false)
    assert.equal(h.transports[0].closed, false)

    // 最后一条断开 → 全拆
    h.clients.delete(connA)
    h.gateway.onClientClose(connA, true)
    await waitFor(() => h.transports[0].closed && !existsSync(join(root, 'relay.lock')), 1500, '全拆（传输关+退租）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('网关：stop 幂等；dispatch 注册面完整（15 方法中的无连接依赖项）', async () => {
  const root = tempRoot()
  try {
    const h = makeGateway(root)
    const d = new Map<string, (...args: unknown[]) => unknown>()
    h.gateway.registerDispatch(d)
    for (const name of [
      'relay:start',
      'relay:stop',
      'relay:status',
      'relay:http-request',
      'relay:http-get-binary',
      'relay:http-put-binary',
      'relay:read-file-slice',
      'relay:stat-file',
      'relay:resolve-path',
      'relay:ca-fp',
      'relay:ca-cert',
      'relay:devices-get',
      'relay:devices-set',
      'relay:transport-close',
      'relay:catalog-state',
    ]) {
      assert.ok(d.has(name), `dispatch 缺 ${name}`)
    }
    // relay:transport-connect 由 serve.ts 特判（owner 追踪），不在 dispatch 表
    assert.equal(d.has('relay:transport-connect'), false)

    assert.equal(await h.gateway.start(), 'started')
    await h.gateway.stop()
    await h.gateway.stop()
    const status = (await (d.get('relay:status') as () => Promise<unknown>)()) as { running: boolean }
    assert.equal(status.running, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------- 2. 端到端（真实 daemon） ----------

test('e2e：daemon 的 relay:* 安全方法面真实可达（status/resolve-path/stat-file/ca-fp/transport-close）', async () => {
  const root = tempRoot()
  let daemon: ChildProcess | null = null
  try {
    const port = 47610 + Math.floor(Math.random() * 200)
    daemon = spawn(process.execPath, [join(process.cwd(), 'dist', 'serve.js'), '--user-data', root, '--port', String(port), '--no-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    daemon.stdout.on('data', (c) => { out += c })
    daemon.stderr.on('data', (c) => { out += c })
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      if (/token=([\w-]+)/.test(out)) break
      if (daemon.exitCode !== null) throw new Error(`daemon 未就绪：\n${out}`)
    }
    const token = out.match(/token=([\w-]+)/)![1]!

    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
    await new Promise<void>((r, rej) => {
      ws.once('open', r)
      ws.once('error', rej)
    })
    const call = (id: string, m: string, ...a: unknown[]): Promise<{ ok: boolean; r?: unknown; e?: string }> =>
      new Promise((resolve) => {
        const onMsg = (data: unknown): void => {
          const f = JSON.parse(String(data)) as { t: string; id?: string; ok?: boolean; r?: unknown; e?: string }
          if (f.t === 'res' && f.id === id) {
            ws.off('message', onMsg)
            resolve({ ok: !!f.ok, r: f.r, e: f.e })
          }
        }
        ws.on('message', onMsg)
        ws.send(JSON.stringify({ t: 'req', id, m, a }))
      })

    // status（本 daemon 未 start → 不持租约；holder 反映真实全局锁，机器上可能有 CLI/Electron 在线——只验形状）
    const s1 = await call('1', 'relay:status')
    assert.equal(s1.ok, true)
    const st1 = s1.r as { running: boolean; holder: string | null; connected: boolean }
    assert.equal(st1.running, false)
    assert.equal(st1.connected, false)
    assert.ok(st1.holder === null || typeof st1.holder === 'string', 'holder 形状合法')

    // resolve-path：~ 展开为绝对路径
    const s2 = await call('2', 'relay:resolve-path', { input: '~/x.txt' })
    assert.equal(s2.ok, true)
    const rp = s2.r as { path: string; homeDir: string }
    assert.ok(rp.path.length > rp.homeDir.length, '~ 已展开为绝对路径')

    // stat-file：存在与不存在
    const tmpFile = join(root, 'probe.txt')
    writeFileSync(tmpFile, 'hello', 'utf8')
    const s3 = await call('3', 'relay:stat-file', { path: tmpFile })
    assert.equal(s3.ok, true)
    const st = s3.r as { size: number; isFile: boolean }
    assert.equal(st.size, 5)
    assert.equal(st.isFile, true)
    const s4 = await call('4', 'relay:stat-file', { path: join(root, 'nope.txt') })
    assert.equal(s4.r, null)

    // ca-fp：指纹形状（非空字符串）
    const s5 = await call('5', 'relay:ca-fp', { caPath: tmpFile })
    assert.equal(s5.ok, true)
    assert.ok(typeof (s5.r as { caFP: string }).caFP === 'string' && (s5.r as { caFP: string }).caFP.length > 10)

    // transport-close（无传输时幂等 ok）
    const s6 = await call('6', 'relay:transport-close')
    assert.deepEqual(s6.r, { ok: true })

    // transport-connect 特判路径：连不上 → 错误帧如实返回（不崩 daemon）
    const s7 = await call('7', 'relay:transport-connect', { relayUrl: 'ws://127.0.0.1:1', mailboxId: 'm', readToken: 't' })
    assert.equal(s7.ok, false, '连不上如实报错')
    assert.ok(String(s7.e).length > 0)
    // daemon 仍活着（错误不杀宿主）
    const s8 = await call('8', 'relay:status')
    assert.equal(s8.ok, true)

    ws.close()
    await new Promise((r) => setTimeout(r, 200))
  } finally {
    daemon?.kill('SIGINT')
    await new Promise((r) => setTimeout(r, 300))
    rmSync(root, { recursive: true, force: true })
  }
})
