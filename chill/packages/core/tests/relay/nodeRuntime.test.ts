import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import {
  NodeRelayBoxTransport,
  relayNodeHttpRequest,
  relayNodeHttpGetBinary,
  relayNodeHttpPutBinary,
  FileRelayLockStore,
  RelayLeaseHost,
} from '../../src/implementations/relayNodeRuntime.ts'

/**
 * W1 A1 回归：Node relay 运行时四件套（自 electron 迁移/提炼后的行为钉死）。
 * ① 传输回环（auth 头/消息往返/close 码）；② HTTP 三件（JSON 请求/Bearer、二进制 GET+Range、
 * 分片 PUT 头+409 current）；③ 锁库原子写读删；④ LeaseHost 生命周期（抢占互斥/租约丢失一次性
 * 回调+停心跳/幂等停/预览守卫）。
 */

/** 轮询等待条件成立（防时序 flake） */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('NodeRelayBoxTransport：回环——Bearer 头、消息往返、close 码透传', async () => {
  let gotAuth: string | undefined
  const received: string[] = []
  let clientClosed = -1
  const wss = new WebSocketServer({ port: 0 }, () => {
    // 服务器就绪后连接
  })
  const port = (wss.address() as { port: number }).port

  wss.on('connection', (ws: WebSocket, req: { url?: string; headers: Record<string, string | string[] | undefined> }) => {
    gotAuth = String(req.headers.authorization ?? '')
    assert.ok(req.url?.includes('/box/t-box1'), `URL 应含邮箱号：${req.url}`)
    ws.on('message', () => {
      /* 客户端不发包——读长连纯接收向 */
    })
    // 推两条 box 消息
    ws.send(JSON.stringify({ id: 1, blob: 'AAAA' }))
    ws.send(JSON.stringify({ id: 2, blob: 'BBBB' }))
    // 稍后带码关闭
    setTimeout(() => ws.close(4000, 'replaced'), 80)
  })

  const t = new NodeRelayBoxTransport(`ws://127.0.0.1:${port}`, 't-box1', 'tok-123')
  const messages: Array<{ id: number; blob: string }> = []
  await t.connect({
    onMessage: (m) => messages.push(m),
    onClose: (code) => {
      clientClosed = code
    },
    onError: () => {},
  })
  await waitFor(() => messages.length >= 2)
  await waitFor(() => clientClosed !== -1)

  assert.equal(gotAuth, 'Bearer tok-123', '读 token 经 Bearer 头携带')
  assert.deepEqual(messages, [
    { id: 1, blob: 'AAAA' },
    { id: 2, blob: 'BBBB' },
  ])
  assert.equal(clientClosed, 4000, 'close 码透传（渲染层退避重连的依据）')
  assert.equal(t.connected, false)
  wss.close()
})

test('relayNodeHttp 三件：JSON 请求+Bearer、二进制 GET+Range、分片 PUT 头+409 current', async () => {
  const seen: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        range: req.headers.range,
        offset: req.headers['media-offset'],
        total: req.headers['media-total'],
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (req.url === '/pair/tokens') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 't-ok' }))
      } else if (req.url === '/media/x.bin') {
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ current: 4096 }))
      } else {
        const bin = Buffer.from('hello-binary')
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(bin)
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`

  // ① JSON POST + Bearer + body
  const r1 = await relayNodeHttpRequest({ method: 'POST', relayUrl: base, path: '/pair/tokens', token: 'op-key', body: { a: 1 } })
  assert.equal(r1.status, 201)
  assert.deepEqual(r1.json, { token: 't-ok' })
  assert.equal(seen[0]!.auth, 'Bearer op-key')
  assert.equal(seen[0]!.body, JSON.stringify({ a: 1 }))

  // ② 二进制 GET + Range
  const r2 = await relayNodeHttpGetBinary({ relayUrl: base, path: '/file.bin', range: 'bytes=0-4' })
  assert.equal(r2.status, 200)
  assert.equal(r2.base64, Buffer.from('hello-binary').toString('base64'))
  assert.equal(seen[1]!.range, 'bytes=0-4')

  // ③ 分片 PUT：media-offset/total 头 + 409 current 透传
  const r3 = await relayNodeHttpPutBinary({
    relayUrl: base,
    path: '/media/x.bin',
    token: 'w-token',
    offset: 2048,
    total: 8192,
    base64: Buffer.from('chunk-bytes').toString('base64'),
  })
  assert.equal(r3.status, 409)
  assert.deepEqual(r3.json, { current: 4096 })
  assert.equal(seen[2]!.auth, 'Bearer w-token')
  assert.equal(seen[2]!.offset, '2048')
  assert.equal(seen[2]!.total, '8192')
  assert.equal(seen[2]!.body, 'chunk-bytes')

  server.close()
})

test('FileRelayLockStore：写读删 + 损坏容错（null）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chill-lockstore-'))
  try {
    const p = join(dir, 'relay.lock')
    const store = new FileRelayLockStore(p)
    assert.equal(await store.read(), null, '不存在 → null')
    await store.write({ owner: 'web:123', heartbeatAt: 111 })
    assert.ok(existsSync(p), '锁文件落盘')
    assert.deepEqual(await store.read(), { owner: 'web:123', heartbeatAt: 111 })
    await store.remove()
    assert.equal(await store.read(), null, '删除后 → null')
    // 损坏内容 → null（宁缺勿崩）
    const fs = await import('node:fs')
    fs.writeFileSync(p, 'not-json{', 'utf8')
    assert.equal(await store.read(), null)
    await store.remove()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RelayLeaseHost：抢占互斥、租约丢失一次性回调+停心跳、幂等停、预览守卫', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chill-leasehost-'))
  try {
    const lockPath = join(dir, 'relay.lock')
    const lostCalls: number[] = []
    const a = new RelayLeaseHost({
      lockStore: new FileRelayLockStore(lockPath),
      ownerId: 'web:1',
      heartbeatMs: 15,
      onLeaseLost: () => lostCalls.push(Date.now()),
    })
    // 预览守卫优先于一切
    const preview = new RelayLeaseHost({
      lockStore: new FileRelayLockStore(lockPath),
      ownerId: 'web:9',
      isPreviewGuard: () => true,
    })
    assert.equal(await preview.start(), 'preview-no-relay', '预览形态不连')
    assert.equal(preview.isRunning(), false)

    assert.equal(await a.start(), 'started')
    assert.equal(a.isRunning(), true)
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).owner, 'web:1')

    // 他端抢占 → held-by-other（心跳鲜活）
    const b = new RelayLeaseHost({ lockStore: new FileRelayLockStore(lockPath), ownerId: 'web:2' })
    assert.equal(await b.start(), 'held-by-other')

    // 模拟被接管：他端覆写锁 → A 的 renew 失败 → onLeaseLost 一次性 + 停心跳
    const foreign = new FileRelayLockStore(lockPath)
    await foreign.write({ owner: 'cli:99', heartbeatAt: Date.now() })
    await waitFor(() => lostCalls.length === 1)
    await new Promise((r) => setTimeout(r, 60)) // 多等几轮心跳窗口，确认不再重复
    assert.equal(lostCalls.length, 1, 'onLeaseLost 恰好一次（停心跳后不再空转）')
    assert.equal(a.isRunning(), false, '心跳已停')

    // 幂等停（已停再停不炸；退租只删自己的锁——当前是 cli:99，不误删）
    await a.stop()
    await a.stop()
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).owner, 'cli:99', '不误删他端锁')

    // 停止后 holder 可查
    assert.equal(await a.currentHolder(), 'cli:99')
    await foreign.remove()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
