/**
 * chill web —— Web 宿主 daemon 入口（WebUI 规划 M1.1/M1.2）
 *
 * 职责（能力宿主，无引擎无视图）：
 * - 静态服务：127.0.0.1 绑定 + 端口顺延（照抄 electron-main 先例）+ Host 头校验（防 DNS rebinding）
 * - WS 通道：token 门禁 + 请求/响应/事件三帧 + HostAPI 分发
 * - 家目录降级：写边界 = serve 启动目录；家目录启动静默降级只读（--allow-home 显式提升，对齐 Codex 高风险目录降级先例）
 *
 * 安全模型：静态资产 = 代码（Host 头校验即可）；数据全走 token 门禁的 WS。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { WebSocketServer, type WebSocket } from 'ws'
import { NodePathProvider, registerInstance, watchVersionToken, TaskStore, SchedulerService, NodeFileSystemProvider, setSessionTaskCleaner } from '@assistant-ai/core'
import { parseFrame, resFrame, evFrame } from './wsChannel'
import { createDispatch } from './hostApiServer'
import { KvGateway } from './capabilities/kvGateway'
import { WebSecureStorage } from './capabilities/secureStorage'
import { FsGateway } from './capabilities/fsGateway'
import { SessionsGateway } from './capabilities/sessionsGateway'
import { SessionLeases } from './capabilities/sessionLeases'
import { RemoteConfigsGateway } from './capabilities/remoteConfigsGateway'
import { isModelProxyPath, handleModelProxy } from './capabilities/modelProxy'
import { NodeToolsGateway } from './capabilities/nodeToolsGateway'
import { CodeExecGateway } from './capabilities/codeExecGateway'
import { McpGateway } from './capabilities/mcpGateway'
import { WatchGateway } from './capabilities/watchGateway'
import { AssetsGateway } from './capabilities/assetsGateway'
import { DialogsGateway } from './capabilities/dialogsGateway'
import { SubagentGateway } from './capabilities/subagentGateway'
import { NodeHookProcessRunner } from '@assistant-ai/core'

const require = createRequire(import.meta.url)
/** bundle 目录（dist/serve.js 或 dev 的 src/）——静态资产与 skill 内置目录的锚点 */
const bundleDir = dirname(fileURLToPath(import.meta.url))

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const basePort = Number(argv.find((_, i) => argv[i - 1] === '--port')) || 5180
const allowHome = argv.includes('--allow-home')
const quiet = argv.includes('--quiet')
/** 禁用启动后自动打开浏览器（脚本/SSH/测试场景；默认启动即开，对齐 dsh 先例） */
const noOpen = argv.includes('--no-open')
/** 测试钩子：--user-data <dir> 覆盖数据目录（契约测试用临时目录做完全隔离） */
const userDataOverride = argv.find((_, i) => argv[i - 1] === '--user-data')

// ---------- 位置参数闸：本 daemon 只有旗标参数；位置参数一律是误用 ----------
// （典型：`chill web status`——把 serve 控制面动词误传给 web daemon；现状若静默忽略照常启动，
// 就会多起一个野实例。取值旗标的参数值不算位置参数。）
{
  const VALUE_FLAGS = new Set(['--port', '--user-data'])
  const stray = argv.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(argv[i - 1] ?? ''))
  if (stray.length > 0) {
    process.stderr.write(
      `✗ 无法识别的参数：${stray.join(' ')}（本命令是 WebUI daemon 启动入口，只接受旗标）\n` +
      '  用法: chill web [--port N] [--allow-home] [--quiet] [--no-open]\n' +
      '  提示: 手机遥控常驻宿主的控制面是 chill serve on|off|status\n',
    )
    process.exit(2)
  }
}

function log(...parts: unknown[]): void {
  if (!quiet) console.log(...parts)
}

// ---------- 家目录降级（对齐 Codex 高风险目录降级先例：静默只读，不询问不拒绝） ----------
// 写边界 = 启动目录；家目录启动会把整个家目录划进 WS 直通能力的写圈。
// 旧设计是 y/N 确认（readline 初始化重绘吞掉未换行的提示行，实测 bug）——现改为默认只读、
// --allow-home 显式提升，交互成本归零且安全更严。读取/聊天/设置不受影响。
const cwd = process.cwd()
const homeReadOnly = resolve(cwd) === resolve(homedir()) && !allowHome
if (homeReadOnly) {
  console.warn('⚠  家目录启动：写边界已降级为只读（读取不受影响；写入需以 --allow-home 重启提升）')
}

// ---------- 能力装配（四件套 + 分发表） ----------
const userDataPath = userDataOverride ?? new NodePathProvider().getUserDataPath()
const kv = new KvGateway(userDataPath)
const secure = new WebSecureStorage(userDataPath)
const fsGateway = new FsGateway(userDataPath, [cwd], { readOnlyExtraRoots: homeReadOnly }) // M3.4：工作目录（serve 启动目录）并入白名单；家目录启动时该根降级只读
const sessions = new SessionsGateway(userDataPath)
// M5 会话删除清账（headless：仅取数不持钟——web daemon 无时钟，范围声明 1）：
// web 壳删除会话时绑定该会话的 session 任务转 orphaned（与 CLI/UI 同一收口语义）
{
  const cleanerScheduler = new SchedulerService({
    store: new TaskStore(new NodeFileSystemProvider(), `${userDataPath}/scheduled-tasks.json`),
  })
  setSessionTaskCleaner(async (sessionId) => {
    await cleanerScheduler.markSessionDeleted(sessionId)
  })
}
const remoteConfigs = new RemoteConfigsGateway(userDataPath)
const nodeTools = new NodeToolsGateway()
const codeExec = new CodeExecGateway()
const mcp = new McpGateway()
const watchBridge = new WatchGateway()
const dialogs = new DialogsGateway(userDataPath)
const pathProvider = { getUserDataPath: () => userDataPath, getUserHomePath: () => homedir() }
const assets = new AssetsGateway(userDataPath, skillBuiltinDir().path ?? null, pathProvider as never)
const hooksRunner = new NodeHookProcessRunner()
const subagents = new SubagentGateway(secure, userDataPath, bundleDir)

/** skill 内置目录：bundle 产物（dist/skills/builtin）优先，源码树回退 */
function skillBuiltinDir(): { success: boolean; path?: string | null; managed?: boolean; error?: string } {
  const bundled = join(bundleDir, 'skills', 'builtin')
  if (existsSync(bundled)) return { success: true, path: bundled, managed: true }
  const source = resolve(bundleDir, '../../core/src/skills/builtin')
  if (existsSync(source)) return { success: true, path: source, managed: true }
  return { success: true, path: null, managed: false } // npm 布局缺失：skill 面降级，不阻塞 boot
}

const dispatch = createDispatch({
  userDataPath, kv, secure, fs: fsGateway, sessions, remoteConfigs,
  getPort: () => serverAddressPort,
  nodeTools, codeExec, mcp, watchBridge, assets, dialogs, hooksRunner, subagents,
  skillBuiltinDir,
  fsGate: {
    downgraded: homeReadOnly,
    enforced: () => fsGateway.getReadOnlyExtra(),
    set: (v) => { if (homeReadOnly) fsGateway.setReadOnlyExtra(v) }, // 仅降级态生效；非家目录启动无闸可动（桌面平权）
  },
})

// ---------- 静态服务（Host 头白名单 = 防 DNS rebinding） ----------
// 静态资产双候选：打包形态（包内 web-dist，M5.5 产出）优先，开发形态（UI 构建产物
// packages/dist——与桌面静态服务同一目录思想）回退。零拷贝：CJK 路径下 Node 24 的
// 递归 fs 操作（rmSync/cpSync）会 fail-fast（实测 0xC0000409），直接服务源目录。
const STATIC_CANDIDATES = [
  join(bundleDir, 'web-dist'),               // 打包形态（dist/web/web-dist，与 build.mjs 拷贝落点一致）
  join(bundleDir, '..', '..', 'dist'),       // 开发形态：packages/web/dist → packages/dist
]
const STATIC_ROOT = STATIC_CANDIDATES.find(p => existsSync(join(p, 'web.html')))
/** Web 壳默认页 = web.html（非 Electron 的 index.html） */
const DEFAULT_PAGE = 'web.html'
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase()
  return host === `127.0.0.1:${serverAddressPort}` || host === `localhost:${serverAddressPort}`
}

let serverAddressPort = basePort

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!hostAllowed(req)) {
    res.writeHead(403).end('forbidden host')
    return
  }
  // 模型代理（M2.1）：浏览器 CORS 无豁免，模型 API 一律经此转发（流式 pipe 零缓冲）
  const reqPath = (req.url ?? '/').split('?')[0]
  if (isModelProxyPath(reqPath)) {
    handleModelProxy(req, res)
    return
  }
  if (!STATIC_ROOT) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(placeholderPage())
    return
  }
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  let file = normalize(join(STATIC_ROOT, urlPath === '/' ? DEFAULT_PAGE : urlPath))
  // 出圈防御 + 回退默认页（hash 路由不进服务器，此回退仅兜底根路径外的拓展名less路径）
  if (!file.startsWith(resolve(STATIC_ROOT) + sep) && file !== resolve(STATIC_ROOT)) {
    res.writeHead(403).end('forbidden path')
    return
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    file = join(STATIC_ROOT, DEFAULT_PAGE)
  }
  if (!existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(placeholderPage())
    return
  }
  readFile(file).then(buf => {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(buf)
  }).catch(() => res.writeHead(500).end('read error'))
}

/** 前端资产未产出时的占位页（构建缺位时的诚实呈现） */
function placeholderPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>chill web</title>
<body style="font-family:system-ui;padding:40px;line-height:1.7">
<h2>chill web 运行中</h2>
<p>daemon 已就绪（API 通道可用），但前端资产未找到。</p>
<p>请先构建渲染层：<code>pnpm build:renderer</code>（产出 packages/dist/web.html）。</p></body>`
}

// ---------- WS 通道（token 门禁） ----------
const token = randomBytes(24).toString('base64url')
const server = createServer(serveStatic)
const wss = new WebSocketServer({ noServer: true })

const connections = new Set<WebSocket>()
/** 事件广播枢纽（M3.8）：kv/codeExec/mcp/watch/plan-ask 全部源汇聚于此 → ev 帧 */
function broadcast(n: string, d: unknown): void {
  const payload = JSON.stringify(evFrame(n, d))
  for (const ws of connections) {
    if (ws.readyState === ws.OPEN) ws.send(payload)
  }
}
kv.onEvent(broadcast)
codeExec.onEvent(broadcast)
mcp.onEvent(broadcast)
watchBridge.onEvent(broadcast)
nodeTools.onAsk = (payload) => broadcast('plan:ask-user-request', payload)
// M4：子代理回弹 / Worker hooks 派发 / 执行过程事实流——全部经 WS 推浏览器
subagents.onBuiltinRequest = (payload) => broadcast('subagent:builtin-request', payload)
subagents.onMcpHookRequest = (payload) => broadcast('worker-mcp-hook:request', payload)
subagents.onToolCallEvent = (payload) => broadcast('subagent-tool-call', payload)
// sessions 目录常驻监听（跨端同步推送；M3.8）
watchBridge.startSessionsWatch(sessions.getSessionsDir(), sessions)

// 会话租约（M1.6）：每连接单当前会话；watch 换向即换租约，断连/退出释放
const leases = new SessionLeases(userDataPath)
const watchedOf = new Map<WebSocket, string>()

wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
  connections.add(ws)
  // 连接即推 kv 快照（ws-host 同步 getItem 的数据源）
  ws.send(JSON.stringify(evFrame('kv:snapshot', kv.snapshot())))
  ws.on('message', async (raw: unknown) => {
    const frame = parseFrame(raw)
    if (!frame) { ws.close(4003, 'malformed frame'); return }
    if (frame.m === 'session:watch') {
      // 租约换向（M1 占位基础设施：跨端可见；enforcement 归 M2 写路径）
      const prev = watchedOf.get(ws)
      if (prev) leases.release(prev, process.pid)
      const id = String(frame.a[0] ?? '')
      if (id) {
        leases.acquire(id, process.pid, 'web')
        watchedOf.set(ws, id)
      }
      ws.send(JSON.stringify(resFrame(frame.id, true, { success: true })))
      return
    }
    const handler = dispatch.get(frame.m)
    if (!handler) {
      ws.send(JSON.stringify(resFrame(frame.id, false, `未知方法：${frame.m}`)))
      return
    }
    try {
      const r = await handler(...frame.a)
      ws.send(JSON.stringify(resFrame(frame.id, true, r)))
    } catch (err) {
      ws.send(JSON.stringify(resFrame(frame.id, false, err instanceof Error ? err.message : String(err))))
    }
  })
  ws.on('close', () => {
    connections.delete(ws)
    const prev = watchedOf.get(ws)
    if (prev) { leases.release(prev, process.pid); watchedOf.delete(ws) }
  })
})

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  if (!hostAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.searchParams.get('token') !== token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

// ---------- 实例登记（M1.6：三壳对称探活） ----------
const unregister = registerInstance(userDataPath, 'web')

// ---------- 端口顺延 + 启动（只在"自己的"端口监听成功后才宣告） ----------
// 注意：server.listen(port, host, cb) 的 cb 经 once('listening') 注册，绑定失败时**不自动摘除**——
// 顺延重试成功后陈旧回调会跟着误发（打印一条指向未绑定端口的假"已启动+URL"，实测坑了 smoke 的首个 URL 匹配）。
// 故显式 once + 失败即摘除，不走 listen 的回调参数。

/** 启动后自动打开浏览器（拿到真实监听端口后才调用；失败静默降级为"请手动打开"） */
function openBrowser(url: string): void {
  if (noOpen) return
  try {
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref()
  } catch {
    log('  （自动打开浏览器失败，请手动复制上方地址）')
  }
}

function tryListen(port: number, attemptsLeft: number): void {
  const onListening = (): void => {
    serverAddressPort = port
    if (port !== basePort) console.warn(`【serve】端口 ${basePort} 被占用，顺延至 ${port}`)
    log(`  chill web 已启动`)
    log(`  ➜  http://127.0.0.1:${port}/?token=${token}`)
    log(`  （数据目录 ${userDataPath}；白名单 ${fsGateway.describe()}；Ctrl+C 停止）`)
    openBrowser(`http://127.0.0.1:${port}/?token=${token}`)
  }
  const onError = (err: NodeJS.ErrnoException): void => {
    server.removeListener('listening', onListening)
    if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
      tryListen(port + 1, attemptsLeft - 1)
    } else {
      console.error(`【serve】本地端口不可用（${basePort}~${port} 均被占用）：${err.message}`)
      process.exit(1)
    }
  }
  server.once('listening', onListening)
  server.once('error', onError)
  server.listen(port, '127.0.0.1')
}

tryListen(basePort, 10)

// ---------- 优雅退出（M4.1 退出纪律的先声：注销实例、关连接；Worker 清理随 M4 落地） ----------
function shutdown(): void {
  unregister()
  for (const [, id] of watchedOf) { leases.release(id, process.pid) }
  for (const ws of connections) ws.close(1001, 'server shutdown')
  // M4.1 退出纪律：销毁在途 Worker 环境（不留孤儿进程）后再退
  void subagents.destroyAllWorkers().finally(() => {
    watchBridge.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2500).unref()
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ---------- M3.3（版本切换接续规划）：换版接续——订阅换版令牌，发现即自重启 ----------
// 端口是关键约束：新实例必须复用同端口（浏览器重连覆盖层才有落点）→ 本进程先优雅退出
// （shutdown：注销实例/关 WS/销毁 Worker——释放端口）→ detached 小助手等本 pid 消亡后
// 以同 argv + --no-open 重新拉起（argv[1] 为 junction 形态路径时，spawn 时刻解析必穿当前
// junction → 加载新版本；chill web 常规启动即此形态）。workcopy 体验形态不接续（目录探测同源约定）。
{
  const inWorkcopy = bundleDir.includes('chill-workcopy')
  if (!inWorkcopy) {
    watchVersionToken(join(homedir(), '.chill', 'version-switched.json'), (t) => {
      console.log(`【serve】检测到换版令牌 v${t.version}——自重启接续新版本`)
      const respawnArgv = JSON.stringify([process.argv[1]!, ...process.argv.slice(2), '--no-open'])
      const helper = `
const { spawn } = require('node:child_process');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let dead = false;
for (let i = 0; i < 120; i++) { try { process.kill(${process.pid}, 0); } catch (e) { dead = true; break; } sleep(250); }
if (dead) {
  try { const c = spawn(process.execPath, ${respawnArgv}, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); }
  catch (e) { try { console.error('[web-helper] respawn failed: ' + e.message); } catch (e2) {} }
}
`
      try {
        const { spawn } = require('node:child_process') as typeof import('node:child_process')
        spawn(process.execPath, ['-e', helper], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      } catch {
        /* 尽力而为：拉起失败时本进程不再退出，保持旧版本服务 */
        return
      }
      shutdown()
    }, 5000)
  }
}
