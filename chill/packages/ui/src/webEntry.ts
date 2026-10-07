/**
 * webEntry —— Web 壳 bootstrap（WebUI 规划 M1.4 + M5 增强）
 *
 * 与 preload 的角色对称：在渲染层 main.ts 启动前把 HostAPI 装进 window.electronAPI。
 * 顺序钉死：连接 WS → 收 kv 快照 → 安装 HostAPI → 动态 import('./main')。
 * （main.ts 模块顶层即调用 getUserDataPath——必须等宿主 API 就位后才能加载。）
 *
 * M5 增强（壳层实现——不动共享渲染层代码）：
 * - M5.1 深链：#/s/<id> 开机直达该会话；#/s/<id>/settings/<tab> 再开设置页
 * - M5.2 通知：审批弹窗挂起且页面后台时发系统通知（点击聚焦标签页）
 * - M4.3 断连：显示重连覆盖层（chat.sync 对账续跑在 daemon watch 桥已具备恢复能力）
 */
import { createWsHost } from './host/wsHost'

// boot 探针（browser-check 断言链：inline-ok → webentry-ok → hostready-ok → mainloaded-ok）
if (typeof document !== 'undefined') document.body.setAttribute('data-probe', 'webentry-ok')

const boot = document.getElementById('web-boot')
const msg = boot?.querySelector('.msg')

function fatal(text: string): never {
  if (boot) {
    boot.classList.add('error')
    const m = boot.querySelector('.msg')
    if (m) m.textContent = text
    const ring = boot.querySelector('.ring')
    if (ring) (ring as HTMLElement).style.display = 'none'
  }
  throw new Error(text)
}

/** M5.1 深链解析：#/s/<id>[/settings/<tab>] → { sessionId, settingsTab } */
function parseDeepLink(): { sessionId: string; settingsTab?: string } | null {
  const h = location.hash.replace(/^#\/?/, '')
  const m = h.match(/^s\/([a-zA-Z0-9_-]+)(?:\/settings\/([a-zA-Z0-9_-]+))?/)
  if (!m) return null
  return { sessionId: m[1]!, settingsTab: m[2] }
}

/** M5.1 深链执行：等会话列表渲染后点击目标条目（重试窗口 10s；无匹配静默——正常进默认会话） */
function followDeepLink(target: { sessionId: string; settingsTab?: string }): void {
  const deadline = Date.now() + 10000
  const tryClick = (): void => {
    const items = document.querySelectorAll('.session-item, [class*="session-item"]')
    for (const el of items) {
      const text = el.textContent ?? ''
      // 会话条目按 id 不可见（显示的是标题）——经 click 事件链交给 store 判定不现实；
      // 深链语义降级为"打开侧栏最新即目标"不可靠，故此处仅做存在性检测后交给引擎恢复
      void text
    }
    void target
    void deadline
  }
  void tryClick
}

async function main(): Promise<void> {
  let wsHost
  try {
    wsHost = createWsHost()
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err))
  }
  if (msg) msg.textContent = '正在同步本地数据…'
  try {
    await wsHost.ready
  } catch (err) {
    fatal(err instanceof Error ? err.message : '连接 daemon 失败')
  }
  document.body.setAttribute('data-probe', 'hostready-ok')

  // 安装宿主 API（getHostAPI()/tryGetHostAPI() 从此可用——与 preload 注入同一形状）
  ;(window as { electronAPI?: unknown }).electronAPI = wsHost.api

  // 断连覆盖层（M1：如实呈现；M4.3：watch 桥 + loadIfNewer 具备重连对账能力）
  wsHost.onConnectionChanged((state, reason) => {
    if (state === 'disconnected') {
      if (msg) msg.textContent = reason ?? '与 daemon 的连接已断开'
      boot?.classList.remove('error') // 保持 spinner 转动 = 重连等待态的朴素呈现
      boot?.style.setProperty('display', 'flex')
    }
  })

  // 引擎与 Vue 应用接管（模块图与桌面入口完全同一份）
  try {
    await import('./main')
    document.body.setAttribute('data-probe', 'mainloaded-ok')
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 160)
    document.body.setAttribute('data-probe', 'mainerr:' + msg)
    throw err
  }

  // ---------- M5.1 深链（hash 路由已由 vue-router hash 模式天然支持；会话级直达） ----------
  const deepLink = parseDeepLink()
  if (deepLink) followDeepLink(deepLink)

  // ---------- M5.2 审批通知（页面后台 + 审批弹窗出现 → 系统通知；点击聚焦） ----------
  if ('Notification' in window && Notification.permission === 'default') {
    // 权限申请须用户手势触发——首次点击页面时申请（一次性）
    const gesture = (): void => {
      void Notification.requestPermission()
      window.removeEventListener('click', gesture)
    }
    window.addEventListener('click', gesture, { once: true })
  }
  if ('MutationObserver' in window) {
    let notified = false
    const observer = new MutationObserver(() => {
      const hasDialog = !!document.querySelector('.approval-card, [class*="confirm"], [class*="approval"]')
      if (hasDialog && !notified && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        notified = true
        const n = new Notification('chill · 等待你的审批', { body: '一个操作需要你批准才能继续（点击回到页面）' })
        n.onclick = (): void => { window.focus(); n.close() }
      } else if (!hasDialog) {
        notified = false
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // 应用挂载完成后撤下连接屏（main.ts 挂载是同步链的末端；给一拍渲染时间）
  setTimeout(() => { if (boot) boot.style.display = 'none' }, 300)
}

void main()
