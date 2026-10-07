#!/usr/bin/env node
/**
 * M1 浏览器自动验收 v2：daemon + 无头 Edge(CDP 驱动) + 轮询探针 + DOM 断言
 *
 * 为什么 CDP 而非 --dump-dom：boot 链含真实 WS 网络往返，--virtual-time-budget
 * 与真实网络互斥（实测截断点随机）；CDP 允许真实等待 + 精确取值。
 *
 * 用法：node scripts/browser-check.mjs   （前置：dist/serve.js 与 packages/dist 已构建）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const CDP_PORT = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 拉起 daemon（trace 开） ----------
const daemon = spawn(process.execPath, ['dist/serve.js', '--port', '5290'], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CHILL_WEB_TRACE: '1' },
})
let daemonOut = ''
daemon.stdout.on('data', (c) => { daemonOut += c })
daemon.stderr.on('data', (c) => { process.stderr.write(c) })
await sleep(2000)
const m = daemonOut.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/)
if (!m) { console.error('daemon 未就绪：' + daemonOut); process.exit(1) }
const url = `http://127.0.0.1:${m[1]}/?token=${m[2]}`
console.log(`daemon: ${url}`)

// ---------- 无头 Edge（CDP） ----------
const profile = mkdtempSync(join(tmpdir(), 'edge-chill-'))
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
await sleep(2500)

// ---------- CDP 极简客户端 ----------
const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json())
const cdp = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let seq = 0
const pendingCd = new Map()
const consoleErrors = []   // 浏览器侧 console.error / 未捕获异常（TDZ 等 bug 的本地复现通道）
cdp.on('message', (raw) => {
  const f = JSON.parse(String(raw))
  if (f.id && pendingCd.has(f.id)) { pendingCd.get(f.id)(f); pendingCd.delete(f.id); return }
  if (f.method === 'Runtime.exceptionThrown') {
    const d = f.params?.exceptionDetails
    consoleErrors.push('EXC: ' + String(d?.exception?.description ?? d?.text ?? '').split('\n').slice(0, 4).join(' | '))
  }
  if (f.method === 'Runtime.consoleAPICalled' && f.params?.type === 'error') {
    const args = (f.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    consoleErrors.push('LOG: ' + args.slice(0, 900))
  }
})
function send(method, params = {}, sessionId) {
  const id = ++seq
  return new Promise((resolve) => {
    pendingCd.set(id, resolve)
    const msg = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    cdp.send(JSON.stringify(msg))
  })
}
const target = await send('Target.createTarget', { url })
const sessionResp = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })
const sessionId = sessionResp.result.sessionId
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
  return r.result?.result?.value
}
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Page.navigate', { url }, sessionId)

// ---------- 轮询直到会话数据加载（真实等待：挂载 → 列表数据到达） ----------
const deadline = Date.now() + 45000
let probe = '', appHtmlLen = 0, pageText = ''
while (Date.now() < deadline) {
  await sleep(800)
  probe = (await evalJs(`document.body.getAttribute('data-probe')`)) ?? ''
  appHtmlLen = (await evalJs(`document.getElementById('app')?.innerHTML.length || 0`)) ?? 0
  pageText = (await evalJs(`document.body.innerText`)) ?? ''
  // 完成判据：应用挂载 + 会话列表数据已填充（暂无会话消失 = session:list-meta 已回填）
  // 注：侧栏可能处于折叠态（persisted）——innerText 看不见但 DOM 在；折叠也算通过
  const hasNewChatBtn = (await evalJs(`!![...document.querySelectorAll('button')].find(b => b.textContent?.includes('新建对话'))`)) ?? false
  const listVisibleLoaded = !pageText.includes('暂无会话')
  const sessionCount = ((await evalJs(`document.querySelectorAll('.session-item').length`)) ?? 0)
  const listCollapsedWithSession = sessionCount > 0
  if (appHtmlLen > 3000 && hasNewChatBtn && (listVisibleLoaded || listCollapsedWithSession)) { pageText += ' [list-loaded]'; break }
  if (probe.startsWith('mainerr:')) break
}

// ---------- 断言 ----------
const hasNewChat = !!((await evalJs(`!![...document.querySelectorAll('button')].find(b => b.textContent?.includes('新建对话'))`)) ?? false)
const listLoaded = pageText.includes('[list-loaded]')
const sessionCount = (pageText.match(/\n/g) ?? []).length
let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

check('boot 探针到达 mainloaded', probe === 'mainloaded-ok', `probe=${probe}`)
check('Vue 应用已挂载（#app 内容规模）', appHtmlLen > 3000, `${appHtmlLen} 字符`)
check('侧栏渲染（含"新建对话"）', hasNewChat)
check('会话列表数据已加载（非空态）', listLoaded)

// ---------- 终验一步：点开第一个历史会话 → 消息区渲染（"阅读"验收） ----------
const beforeLen = appHtmlLen
const clicked = (await evalJs(`(() => {
  const el = document.querySelector('.session-item') || document.querySelector('[class*="session-item"]')
  if (!el) return false
  el.click()
  return true
})()`)) ?? false
// 会话行渲染可能晚于应用挂载（boot 恢复异步链）——重试窗口 30s（覆盖 boot 恢复全程）
let clickRetried = clicked
if (!clickRetried) {
  const retryDeadline = Date.now() + 30000
  while (Date.now() < retryDeadline) {
    await sleep(1000)
    clickRetried = ((await evalJs(`(() => {
      const el = document.querySelector('.session-item') || document.querySelector('[class*="session-item"]')
      if (!el) return false
      el.click()
      return true
    })()`)) ?? false)
    if (clickRetried) break
  }
}
let opened = false, openedLen = 0
const openDeadline = Date.now() + 15000
while (Date.now() < openDeadline) {
  await sleep(800)
  openedLen = (await evalJs(`document.getElementById('app')?.innerHTML.length || 0`)) ?? 0
  const txt = (await evalJs(`document.body.innerText`)) ?? ''
  // 打开判据：消息区 DOM 显著增长（主判据）；输入区文本为辅证（启发式，不同会话内容差异大故不强制）
  if (openedLen > beforeLen + 2000) { opened = true; break }
}
check('点开历史会话 → 阅读视图渲染', (clickRetried || clicked) && opened, (clickRetried || clicked) ? (opened ? '阅读视图已渲染' : `${openedLen} 字符`) : '未找到会话条目')

if (failures > 0) {
  const traces = daemonOut.split('\n').filter((l) => l.includes('[web-trace]'))
  console.log(`\n[debug] daemon 轨迹末 12 行（共 ${traces.length}）：\n` + traces.slice(-12).join('\n'))
  console.log('\n[debug] 页面文本前 600 字：\n' + pageText.slice(0, 600))
  console.log('\n[debug] 侧栏按钮候选：\n' + JSON.stringify(await evalJs(`[...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(t => t && t.length < 20).slice(0, 20)`)))
  console.log('\n[debug] 会话行候选（class 含 session/chat/conv）：\n' + JSON.stringify(await evalJs(`[...document.querySelectorAll('[class*="session"],[class*="conversation"],[class*="chat-item"]')].slice(0,8).map(e => ({ cls: e.className.toString().slice(0,60), txt: (e.textContent||'').slice(0,30) }))`)))
}

// ---------- 浏览器控制台体检（去重呈现；预期降级噪音 vs 真 bug 分层） ----------
const uniq = [...new Set(consoleErrors)]
const tdz = uniq.filter((l) => l.includes('before initialization') || l.includes('ReferenceError'))
const degraded = uniq.filter((l) => l.includes('里程碑启用'))
const others = uniq.filter((l) => !tdz.includes(l) && !degraded.includes(l))
console.log(`\n[console] 预期降级提示（M2+ 消失）: ${degraded.length} 类`)
console.log(`[console] 真 bug（ReferenceError/TDZ）: ${tdz.length} 类`)
for (const t of tdz) console.log('  ⚠ ' + t)
console.log(`[console] 其他错误: ${others.length} 类`)
for (const o of others.slice(0, 6)) console.log('  · ' + o)
if (tdz.length > 0) failures++

// ---------- 可选终验：真实对话回合（CHAT_CHECK=1；花真实 token，等价人工验收） ----------
if (process.env.CHAT_CHECK === '1' && failures === 0 && !probe.startsWith('mainerr:')) {
  console.log('\n[chat] 发起真实对话回合…')
  const typed = (await evalJs(`(() => {
    const ta = document.querySelector('.input-area textarea') || document.querySelector('textarea')
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '请只回复两个字：收到')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)) ?? false
  const beforeTextLen = pageText.length
  await sleep(400)
  const clickedSend = (await evalJs(`(() => {
    const btn = document.querySelector('.send-btn') || [...document.querySelectorAll('button')].find(b => (b.title ?? '').includes('发送'))
    if (!btn) return false
    btn.click()
    return true
  })()`)) ?? false
  let replied = false, replyText = ''
  const chatDeadline = Date.now() + 90000
  while (Date.now() < chatDeadline) {
    await sleep(1500)
    const txt = (await evalJs(`document.body.innerText`)) ?? ''
    if (txt.includes('收到')) { replied = true; replyText = txt.slice(0, 50); pageText = txt; break }
    if (txt.length < beforeTextLen - 500 && !txt.includes('正在')) { /* 列表重绘兜底 */ }
  }
  check('真实对话回合（输入→发送→助手回复）', clicked && replied, clicked ? (replied ? '回复已抵达' : '90s 未见图文回复') : '未找到输入框/发送键')
  void typed
}

// ---------- 清理（容忍失败：Edge 句柄释放有延迟；CJK 路径下 rmSync 有已知崩性） ----------
try { await send('Target.closeTarget', { targetId: target.result.targetId }) } catch { /* 忽略 */ }
try { cdp.close() } catch { /* 忽略 */ }
edge.kill()
try { rmSync(profile, { recursive: true, force: true }) } catch { /* 临时目录由系统清理 */ }
daemon.kill('SIGINT')
await sleep(500)
console.log(failures === 0 ? '\n浏览器验收全部通过 ✅' : `\n${failures} 项失败 ❌`)
process.exit(failures === 0 ? 0 : 1)
