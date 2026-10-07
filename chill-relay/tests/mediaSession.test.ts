/**
 * mediaSession.test.ts — v2 分片追加会话：offset 语义/409 再同步/Range GET/TTL 分层/配额重构/v1 兼容。
 * 会话即文件：.part 长度即真相（重启零恢复）；rename 先于完成应答。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import {
  startMediaServer,
  cleanupStaticDir,
  api,
  makePairDirect,
  type TestServer,
  type Paired,
} from './helpers.js'

// 小限额：字节率 1MB/min / 单文件 200B / 总量 2KB（多测试共享服务器——预算须覆盖全部用例）
let srv: TestServer & { staticDir: string }
let pair: Paired

const n = (c: string): string => c.repeat(32) + '.bin'
const mediaPath = (name: string): string => join(srv.staticDir, 'media', name)
const partPath = (name: string): string => join(srv.staticDir, 'media', name + '.part')

/** 带 offset/total 头的分片 PUT（真实 content-length） */
async function putChunk(
  name: string,
  offset: number,
  total: number,
  body: Buffer,
): Promise<{ status: number; json: any }> {
  const r = await api(srv, 'PUT', `/media/${name}`, {
    token: pair.secrets.writeToken,
    rawBody: body,
  })
  return r
}

before(async () => {
  srv = await startMediaServer({
    mediaPerMin: 100_000,
    mediaBytesPerMin: 1 << 20,
    mediaMaxFileBytes: 200,
    mediaMaxTotalBytes: 2048,
    mediaTtlMs: 1000,
    mediaPartTtlMs: 500,
  })
  pair = makePairDirect(srv)
})
after(async () => {
  await srv.close()
  cleanupStaticDir(srv.staticDir)
})

test('v2 快乐路径：创建→追加→完成（rename 先于应答；current 递增；complete:true）', async () => {
  const name = n('a')
  const c1 = Buffer.alloc(60, 1)
  const c2 = Buffer.alloc(60, 2)
  const c3 = Buffer.alloc(20, 3)
  // api() 不支持自定义 header——直接用 httpRequest
  const r1 = await rawPut(name, 0, 140, c1)
  assert.equal(r1.status, 201)
  assert.equal(r1.json.current, 60, '创建后 current=60')
  const r2 = await rawPut(name, 60, 140, c2)
  assert.equal(r2.status, 201)
  assert.equal(r2.json.current, 120)
  const r3 = await rawPut(name, 120, 140, c3)
  assert.equal(r3.status, 201)
  assert.equal(r3.json.complete, true, '达总量即完成')
  assert.equal(r3.json.url, `/static/media/${name}`)
  assert.ok(existsSync(mediaPath(name)), '成品 .bin 存在')
  assert.ok(!existsSync(partPath(name)), '.part 已 rename')
  assert.equal(statSync(mediaPath(name)).size, 140)
})

test('v2 409 再同步：偏移不匹配返回服务端当前长度（响应丢失重复片自愈）', async () => {
  const name = n('b')
  await rawPut(name, 0, 120, Buffer.alloc(60, 1))
  // 客户端误以为从 30 开始（落后于服务端）→ 409 + current=60 → 跳续
  const r = await rawPut(name, 30, 120, Buffer.alloc(60, 1))
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'offset_mismatch')
  assert.equal(r.json.current, 60)
  // 客户端领先（offset=90 > 服务端 60）→ 同样 409
  const rAhead = await rawPut(name, 90, 120, Buffer.alloc(30, 1))
  assert.equal(rAhead.status, 409)
  assert.equal(rAhead.json.current, 60)
  // 从服务端真实偏移续传 → 完成
  const r2 = await rawPut(name, 60, 120, Buffer.alloc(60, 2))
  assert.equal(r2.status, 201)
  assert.equal(r2.json.complete, true)
})

test('v2 无会话：offset>0 但 .part 不存在 → 409 no_session', async () => {
  const r = await rawPut(n('c'), 50, 100, Buffer.alloc(10, 1))
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'no_session')
  assert.equal(r.json.current, 0)
})

test('v2 成品已存在：offset=0 创建同名 → 409 exists（客户端换名）', async () => {
  const name = n('d')
  await rawPut(name, 0, 30, Buffer.alloc(30, 1))
  const r = await rawPut(name, 0, 30, Buffer.alloc(30, 2))
  assert.equal(r.status, 409)
  assert.equal(r.json.error, 'exists')
})

test('v2 创建重启：offset=0 且 .part 已有 → truncate 重写（显式重启语义）', async () => {
  const name = n('e')
  await rawPut(name, 0, 100, Buffer.alloc(50, 1))
  // 手机 App 被杀后重试——新名或同名均可；同名=显式重启
  const r = await rawPut(name, 0, 100, Buffer.alloc(80, 9))
  assert.equal(r.status, 201)
  assert.equal(r.json.current, 80, 'truncate 后从 0 写入 80')
  const r2 = await rawPut(name, 80, 100, Buffer.alloc(20, 9))
  assert.equal(r2.json.complete, true)
  assert.equal(statSync(mediaPath(name)).size, 100)
})

test('v2 流中硬闸：会话累计超声明总量 → 413 清场', async () => {
  const name = n('f')
  // 声明 total=50，但 chunked 分两次发 60B（content-length 头由 httpRequest 正确设置——
  // 改用 noContentLength 手写流：声明 total=50，一次 body 60B → 流中超限）
  const r = await rawPutNoLen(name, 0, 50, [Buffer.alloc(30, 1), Buffer.alloc(30, 1)])
  assert.ok(r.status === 413 || r.status === null, `status=${r.status}`)
  assert.ok(await waitGone(partPath(name)), '超限清场')
  assert.ok(!existsSync(mediaPath(name)), '无成品')
})

test('v1 兼容：无 Media-Offset 头 = 整包行为原样（小文件走 v1 快路）', async () => {
  const name = n('1')
  const r = await api(srv, 'PUT', `/media/${name}`, {
    token: pair.secrets.writeToken,
    rawBody: Buffer.alloc(20, 7),
  })
  assert.equal(r.status, 201)
  assert.equal((r.json as Record<string, unknown>).url, `/static/media/${name}`)
  assert.equal(statSync(mediaPath(name)).size, 20, 'v1 整包语义不变')
})

test('Range GET：206 切片流（Content-Range/精确字节）；畸形头忽略→200 全量', async () => {
  const name = n('2')
  await rawPut(name, 0, 100, Buffer.alloc(100, 5))
  // bytes=10-19 → 10 字节
  const r1 = await fetch(`${srv.base}/static/media/${name}`, { headers: { range: 'bytes=10-19' } })
  assert.equal(r1.status, 206)
  assert.equal(r1.headers.get('content-range'), `bytes 10-19/100`)
  assert.equal((await r1.arrayBuffer()).byteLength, 10)
  // 开区间 bytes=90- → 10 字节
  const r2 = await fetch(`${srv.base}/static/media/${name}`, { headers: { range: 'bytes=90-' } })
  assert.equal(r2.status, 206)
  assert.equal((await r2.arrayBuffer()).byteLength, 10)
  // 超出 → 416
  const r3 = await fetch(`${srv.base}/static/media/${name}`, { headers: { range: 'bytes=200-' } })
  assert.equal(r3.status, 416)
  // 畸形 → 忽略 → 200 全量
  const r4 = await fetch(`${srv.base}/static/media/${name}`, { headers: { range: 'bytes=abc' } })
  assert.equal(r4.status, 200)
  assert.equal((await r4.arrayBuffer()).byteLength, 100)
  // 多区间不支持 → 忽略 → 200 全量
  const r5 = await fetch(`${srv.base}/static/media/${name}`, { headers: { range: 'bytes=0-1,5-6' } })
  assert.equal(r5.status, 200)
})

test('.part 不可 GET（名形正则天然拒）', async () => {
  const name = n('3')
  await rawPut(name, 0, 100, Buffer.alloc(50, 1))
  assert.ok(existsSync(partPath(name)))
  const r = await api(srv, 'GET', `/static/media/${name}.part`)
  assert.equal(r.status, 404)
})

test('TTL 分层：.part 用 partTtl（500ms），成品用 ttl（1000ms）', async () => {
  const name = n('4')
  await rawPut(name, 0, 100, Buffer.alloc(50, 1))
  assert.ok(existsSync(partPath(name)))
  // 回拨 .part 600ms（>partTtl 500ms，<ttl 1000ms）→ 触发清扫应删 .part、不删成品
  const past = new Date(Date.now() - 600)
  utimesSync(partPath(name), past, past)
  // 同目录放一个成品也回拨 600ms（<1000ms 成品不应被删）
  const doneName = n('5')
  await rawPut(doneName, 0, 30, Buffer.alloc(30, 1))
  utimesSync(mediaPath(doneName), past, past)
  srv.setNow(Date.now() + 50)
  await rawPut(n('6'), 0, 10, Buffer.alloc(10, 1)) // 触发清扫（成功上传顺带）
  assert.ok(!existsSync(partPath(name)), '.part 按 partTtl 清扫')
  assert.ok(existsSync(mediaPath(doneName)), '成品不受 partTtl 影响（600 < 1000）')
})

test('次数帽只计创建：追加片不消耗 mediaPerMin', async () => {
  const s2 = await startMediaServer({ mediaPerMin: 2, mediaBytesPerMin: 1 << 20, mediaMaxFileBytes: 200 })
  try {
    const p2 = makePairDirect(s2)
    const name = n('7')
    // 创建 1 次 + 追加 3 次（追加不计数——若按 v1 逐 PUT 计数，4 次 > 2 会 429）
    for (let i = 0; i < 4; i++) {
      const r = await rawPutOn(s2, p2, name, i * 50, 200, Buffer.alloc(50, i))
      assert.equal(r.status, 201, `chunk ${i} 不应被次数帽拦截`)
    }
    // 第 2 个新会话创建 → 201（已用 1 次创建，配额 2）
    const r2 = await rawPutOn(s2, p2, n('8'), 0, 10, Buffer.alloc(10, 1))
    assert.equal(r2.status, 201)
    // 第 3 个新会话创建 → 429（配额耗尽——追加不占、创建占）
    const r3 = await rawPutOn(s2, p2, n('a'), 0, 10, Buffer.alloc(10, 1))
    assert.equal(r3.status, 429)
  } finally {
    await s2.close()
    cleanupStaticDir(s2.staticDir)
  }
})

test('字节频控：分片按增量记账（独立服务，1MB 窗内 200B 会话分 4 片全过）', async () => {
  const s2 = await startMediaServer({ mediaPerMin: 100_000, mediaBytesPerMin: 1 << 20, mediaMaxFileBytes: 200 })
  try {
    const p2 = makePairDirect(s2)
    const name = n('9')
    for (let i = 0; i < 4; i++) {
      const r = await rawPutOn(s2, p2, name, i * 50, 200, Buffer.alloc(50, i))
      assert.equal(r.status, 201)
    }
    assert.equal(statSync(join(s2.staticDir, 'media', name)).size, 200)
  } finally {
    await s2.close()
    cleanupStaticDir(s2.staticDir)
  }
})

// ---------- 辅助：带 Media-Offset/Media-Total 头的 raw PUT ----------

function rawPut(
  name: string,
  offset: number,
  total: number,
  body: Buffer,
): Promise<{ status: number; json: any }> {
  return rawPutOn(srv, pair, name, offset, total, body)
}

function rawPutOn(
  s: TestServer & { staticDir: string },
  p: Paired,
  name: string,
  offset: number,
  total: number,
  body: Buffer,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      new URL(`/media/${name}`, s.base),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${p.secrets.writeToken}`,
          'media-offset': String(offset),
          'media-total': String(total),
          'content-length': String(body.length),
        },
      },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: any = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            /* no body */
          }
          resolve({ status: r.statusCode ?? 0, json: parsed })
        })
      },
    )
    req.on('error', () => resolve({ status: 0, json: null }))
    req.end(body)
  })
}

/** chunked 无 content-length（谎报场景：流中总量硬闸靶） */
function rawPutNoLen(
  name: string,
  offset: number,
  total: number,
  parts: Buffer[],
): Promise<{ status: number | null; json: any }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      new URL(`/media/${name}`, srv.base),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${pair.secrets.writeToken}`,
          'media-offset': String(offset),
          'media-total': String(total),
          'transfer-encoding': 'chunked',
        },
      },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: any = null
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            /* no body */
          }
          resolve({ status: r.statusCode ?? null, json: parsed })
        })
      },
    )
    req.on('error', () => resolve({ status: null, json: null }))
    for (const p of parts) req.write(p)
    req.end()
  })
}

/** 轮询等待文件消失（Windows 句柄异步关闭容忍） */
async function waitGone(p: string): Promise<boolean> {
  for (let i = 0; i < 25 && existsSync(p); i++) {
    await new Promise((r) => setTimeout(r, 40))
  }
  return !existsSync(p)
}
