/**
 * watch 事件桥（M3.8）
 *
 * daemon 侧 fs.watch 注册表 → WS ev 帧广播。事件源：
 * - sessions 目录（常驻）：session:changed（跨端同步回填；对端写 ndjson 即推）
 * - file:watch-set 注册集：file:changed（文件树刷新，add/addDir/unlink/unlinkDir/change）
 * - teams/workflows watch-dirs：teams:changed / workflows:changed（资产热重载，防抖 300ms）
 * wsHost 侧补回 M1 缺省的四个可选订阅成员——热重载在 Web 端复活。
 */
import { watch, type FSWatcher } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionsGateway } from './sessionsGateway'

interface WatchEntry {
  watcher: FSWatcher
  eventName: string
  debounce?: NodeJS.Timeout
}

export class WatchGateway {
  private entries = new Map<string, WatchEntry>()
  private listeners = new Set<(n: string, d: unknown) => void>()

  onEvent(cb: (n: string, d: unknown) => void): void {
    this.listeners.add(cb)
  }

  private emit(n: string, d: unknown): void {
    for (const cb of this.listeners) { try { cb(n, d) } catch { /* 不扩散 */ } }
  }

  /** 建立单目录监听（幂等；eventName = 广播帧名；debounceMs 有值则防抖合并） */
  private watchDir(dir: string, eventName: string, debounceMs?: number, onRaw?: (filename: string, eventType: string) => void): void {
    const key = `${eventName}:${dir}`
    if (this.entries.has(key)) return
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const entry: WatchEntry = { watcher: null as never, eventName }
      entry.watcher = watch(dir, { recursive: false }, (eventType, filename) => {
        if (onRaw) { onRaw(String(filename ?? ''), eventType); return }
        const fire = (): void => this.emit(eventName, { dir, filename: String(filename ?? '') })
        if (debounceMs) {
          if (entry.debounce) clearTimeout(entry.debounce)
          entry.debounce = setTimeout(fire, debounceMs)
        } else {
          fire()
        }
      })
      this.entries.set(key, entry)
    } catch {
      /* 目录不可监听：跳过（watch 是增强非关键路径） */
    }
  }

  /**
   * sessions 目录常驻监听：session:changed 推**完整 record**（渲染层
   * handleSessionChanged 的载荷契约 = SessionRecord|null——桌面同款经 load 后推送；
   * 删除（rename/unlink 目标消失）推 null。tmp 原子写中间态跳过，防幽灵事件）。
   */
  startSessionsWatch(sessionsDir: string, sessions: SessionsGateway): void {
    this.watchDir(sessionsDir, 'session:changed', undefined, (filename, eventType) => {
      if (!filename.endsWith('.json')) return
      const id = filename.slice(0, -'.json'.length)
      // 防抖同一文件的连续写（引擎每步落盘 = 同秒多次）
      const key = `session-debounce:${id}`
      const prev = this.entries.get(key)
      if (prev?.debounce) clearTimeout(prev.debounce)
      const entry: WatchEntry = { watcher: null as never, eventName: 'session-debounce', debounce: setTimeout(() => {
        this.entries.delete(key)
        if (eventType === 'rename' && !existsSync(join(sessionsDir, filename))) {
          this.emit('session:changed', null)
          return
        }
        void sessions.load(id).then((r: unknown) => {
          const rec = (r as { success?: boolean; record?: unknown })?.record
          if (rec) this.emit('session:changed', rec)
        }).catch(() => { /* 读失败跳过本轮 */ })
      }, 250) }
      this.entries.set(key, entry)
    })
  }

  /** 文件树 watch 集（file:watch-set）：整集 diff——新增建、消失拆 */
  setFileWatchSet(paths: string[]): void {
    const wanted = new Set(paths.map((p) => `file:changed:${p}`))
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith('file:changed:') && !wanted.has(key)) {
        this.entries.get(key)!.watcher.close()
        this.entries.delete(key)
      }
    }
    for (const p of paths) this.watchDir(p, 'file:changed')
  }

  stopFileWatch(): void {
    this.setFileWatchSet([])
  }

  /** 资产目录集（teams/workflows） */
  watchAssetDirs(kind: 'teams' | 'workflows', dirs: string[]): void {
    const eventName = kind === 'teams' ? 'teams:changed' : 'workflows:changed'
    const prefix = `${eventName}:`
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix) && !dirs.some((d) => key === `${prefix}${d}`)) {
        this.entries.get(key)!.watcher.close()
        this.entries.delete(key)
      }
    }
    for (const d of dirs) {
      if (existsSync(d)) this.watchDir(d, eventName, 300)
    }
  }

  close(): void {
    for (const e of this.entries.values()) {
      if (e.debounce) clearTimeout(e.debounce)
      try { e.watcher.close() } catch { /* 已关 */ }
    }
    this.entries.clear()
  }
}
