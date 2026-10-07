#!/usr/bin/env node
/**
 * M1 daemon 冒烟脚本：拉起 serve → 协议级验证（Host 头 / token 门禁 / kv / 会话列表 / stub 如实拒绝）
 * 用法：node scripts/smoke.mjs   （在非家目录运行）
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import WebSocket from 'ws'

const daemon = spawn(process.execPath, ['dist/serve.js', '--no-open'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
daemon.stdout.on('data', (c) => { out += c })
daemon.stderr.on('data', (c) => { process.stderr.write(c) })
daemon.on('exit', (code, sig) => { console.error(`[smoke] daemon 已退出 code=${code} sig=${sig}`) })

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
await sleep(1200)

const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/)
if (!m) {
  console.error('冒烟失败：未解析到启动 URL。daemon 输出：\n' + out)
  daemon.kill()
  process.exit(1)
}
const port = Number(m[1])
const token = m[2]
let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// ---------- HTTP：正常 Host 头拿占位页 ----------
const page = await new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port, path: '/', agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => {
    let b = ''
    res.on('data', (c) => (b += c))
    res.on('end', () => resolve({ status: res.statusCode, body: b }))
  })
  req.on('error', (e) => { console.error('[smoke] HTTP 请求错误:', e.message); process.exit(1) })
  req.end()
})
check('HTTP 占位页 200', page.status === 200 && page.body.includes('chill web'))

// ---------- HTTP：恶意 Host 头 → 403（防 DNS rebinding） ----------
const evil = await new Promise((resolve) => {
  const req = request({ host: '127.0.0.1', port, path: '/', agent: false, headers: { host: 'evil.example.com' } }, (res) => {
    res.resume()
    res.on('end', () => resolve(res.statusCode))
  })
  req.on('error', () => resolve(-1))
  req.end()
})
check('恶意 Host 头被拒 403', evil === 403)

// ---------- WS：无 token → 拒绝 ----------
const noToken = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode))
  ws.on('open', () => { ws.close(); resolve('opened') })
})
check('WS 无 token 被拒 401', noToken === 401)

// ---------- WS：带 token → kv 快照 + 请求/响应 ----------
const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
await once(ws, 'open')
const pending = new Map()
let snapshot = null
ws.on('message', (raw) => {
  const f = JSON.parse(String(raw))
  if (f.t === 'ev' && f.n === 'kv:snapshot') snapshot = f.d
  if (f.t === 'res' && pending.has(f.id)) {
    const { resolve, reject } = pending.get(f.id)
    pending.delete(f.id)
    f.ok ? resolve(f.r) : reject(new Error(f.e))
  }
})
let seq = 0
function call(mname, ...a) {
  const id = `smoke-${seq++}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ t: 'req', id, m: mname, a }))
  })
}
await sleep(300)
check('连接即推 kv 快照', snapshot !== null && typeof snapshot === 'object')

await call('kv:set', 'web_smoke_key', 'hello-m1')
check('kv:set/kv:get 往返', (await call('kv:get', 'web_smoke_key')) === 'hello-m1')

const userData = await call('app:get-user-data-path')
check('app:get-user-data-path', userData?.success === true && typeof userData.path === 'string')

const sessions = await call('session:list-meta')
check('session:list-meta（读真实 ~/.chill/sessions）', sessions?.success === true, `records=${sessions?.records?.length ?? '?'}`)

const search = await call('session:search', 'chill')
check('session:search', search?.success === true)

const pid = await call('app:main-pid')
check('app:main-pid = daemon pid', pid?.pid === daemon.pid)

// stub 如实拒绝
let stubErr = ''
const writeOutside = await call('file:write', '/tmp/x', 'y')
check('file:write 白名单外拒绝', writeOutside?.success === false, writeOutside?.error ?? '')

// 白名单外读取拒绝
const outside = await call('file:read', 'C:/Windows/win.ini')
check('fs 白名单外拒绝', outside?.success === false)

await call('kv:remove', 'web_smoke_key')
ws.close()
daemon.kill('SIGINT')
await sleep(600)
console.log(failures === 0 ? '\n冒烟全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
