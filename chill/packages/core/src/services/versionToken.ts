/**
 * versionToken.ts — 换版令牌（版本切换接续与体验窗口规划 M1.2）
 *
 * 单一写入点：chill-guardian/switcher.js（切换与回滚成功后；switcher 是零依赖 CJS 脚本，
 * 不 import 本模块——写侧逻辑在 switcher 内联同款，格式以本文件为单一事实源）。
 * 消费方：长驻壳（CLI serve / CLI 旁观窗 / Electron 主进程 / Web daemon）经本助手读取与订阅，
 * 收到新令牌后自我接续到新版本。
 *
 * 语义边界（规划安全审计定案）：
 * - 令牌为**建议性信号**，junction 为权威真相——令牌不携带任何可执行语义（无路径/无命令，零注入面）；
 * - schema 校验强制：畸形/字段不全一律返回 null（调用方忽略），绝不部分行动；
 * - 防陈旧：watch 助手按 (version, at, nonce) 三元组去重，同一令牌只触发一次；
 * - 启动时盘上已存在的令牌视为"过去时"（本进程加载的已是新版本），不触发——只对启动后新出现的令牌动作；
 * - 消费方纪律：仅限"长驻壳自我接续"，严禁做全局编排（规划§九）。
 */
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'

export interface VersionSwitchToken {
  /** 新版本目录名（如 v20260930-195658）——仅作日志与去重，不用于加载路径（加载走 junction） */
  version: string
  /** 切换落定时刻（epoch ms） */
  at: number
  /** 随机一次性标识（crypto.randomUUID），防陈旧/重放混淆 */
  nonce: string
}

/** 令牌默认落点：~/.chill/version-switched.json（与 relay.lock / serve.pid 同栖息地） */
export function defaultVersionTokenPath(userHome: string): string {
  return join(userHome, '.chill', 'version-switched.json')
}

/** 严格 schema 校验（三字段齐备且类型正确；多余字段容忍——协议只增不改） */
export function isVersionSwitchToken(v: unknown): v is VersionSwitchToken {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    typeof t.version === 'string' && t.version.length > 0 &&
    typeof t.at === 'number' && Number.isFinite(t.at) && t.at > 0 &&
    typeof t.nonce === 'string' && t.nonce.length > 0
  )
}

/** 读取并校验令牌；不存在/损坏/畸形一律返回 null（绝不抛出、绝不部分行动）。
 *  容错边界：剥离 UTF-8 BOM 后再解析（实测教训：PowerShell 等工具的 UTF8 写入带 BOM，
 *  JSON.parse 遇 '\uFEFF{' 即抛——带 BOM 的合法令牌会被静默当畸形忽略）。 */
export function readVersionToken(path: string): VersionSwitchToken | null {
  try {
    let raw = readFileSync(path, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    const parsed: unknown = JSON.parse(raw)
    return isVersionSwitchToken(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 原子写 + 写后校验（写侧权威实现；switcher 内联同款逻辑，测试/工具复用此函数）。
 * tmp+rename 原子性 + 读回校验；失败返回 null（调用方大声报——令牌写失败是"半成功切换"，
 * 必须让发起壳知道，规划§八）。
 */
export function writeVersionToken(path: string, version: string): VersionSwitchToken | null {
  const token: VersionSwitchToken = { version, at: Date.now(), nonce: randomUUID() }
  try {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(token), 'utf8')
    renameSync(tmp, path)
    const readBack: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isVersionSwitchToken(readBack) ? token : null
  } catch {
    return null
  }
}

export interface VersionTokenWatcher {
  /** 最近一次已见令牌（启动时盘上既有令牌也计入；从未见过为 null） */
  lastSeen(): VersionSwitchToken | null
  stop(): void
}

/**
 * 订阅新令牌：fs.watch 监听令牌所在目录 + pollMs 兜底轮询（watch 在个别环境不可用/丢事件）。
 *
 * 实现纪律（规划 M1.3 明示）：watch 事件**必须按文件名过滤**——同目录的 relay.lock 每 5s
 * 心跳写入会刷屏事件；轮询兜底保证 watch 失效时延迟仍以 pollMs 为上界。
 * 定时器 unref：不阻止进程退出（serve 另有保活心跳；交互壳由 readline 保活）。
 */
export function watchVersionToken(
  path: string,
  onNewToken: (t: VersionSwitchToken) => void,
  pollMs = 5000,
): VersionTokenWatcher {
  let last: VersionSwitchToken | null = readVersionToken(path)
  let stopped = false
  let watcher: FSWatcher | null = null
  const name = basename(path)
  const check = (): void => {
    if (stopped) return
    const t = readVersionToken(path)
    if (t === null) return
    if (last !== null && t.version === last.version && t.at === last.at && t.nonce === last.nonce) return
    last = t
    onNewToken(t)
  }
  try {
    watcher = watch(dirname(path), (_event, filename) => {
      if (typeof filename === 'string' && basename(filename) === name) check()
    })
    watcher.on('error', () => {
      /* watch 失败退化为纯轮询（check 仍按 pollMs 跑） */
    })
  } catch {
    /* 同上：纯轮询兜底 */
  }
  const timer = setInterval(check, pollMs)
  timer.unref()
  return {
    lastSeen: () => last,
    stop(): void {
      stopped = true
      clearInterval(timer)
      try {
        watcher?.close()
      } catch {
        /* 已关 */
      }
    },
  }
}
