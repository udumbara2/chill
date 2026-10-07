/**
 * 会话级租约（WebUI 规划 M1.6）
 *
 * 语义：谁"打开"了某会话（session:watch 重定向 = 当前后台会话），谁持有该会话的
 * 租约文件（~/.chill/session-leases/<sessionId>.json：{ pid, mode, at }）。
 * M1 只读浏览期 web 无写能力，租约在此是**占位基础设施**：跨端可见"web 正在看这个
 * 会话"；enforcement（后来者只读 + 提示）在 M2 首个写能力里程碑激活——彼时写路径
 * 先查租约。与 instanceRegistry 同款存活语义：持有进程死亡 → 租约视为失效。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface LeaseInfo {
  pid: number
  mode: 'cli' | 'ui' | 'web'
  at: string
}

export class SessionLeases {
  private dir: string

  constructor(userDataPath: string) {
    this.dir = join(userDataPath, 'session-leases')
  }

  private file(sessionId: string): string {
    // 会话 id 由引擎生成（uuid 形态）；防御性清洗路径分隔符
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  /** 持有租约（幂等：重复持有同会话刷新时间戳） */
  acquire(sessionId: string, pid: number, mode: LeaseInfo['mode']): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.file(sessionId), JSON.stringify({ pid, mode, at: new Date().toISOString() } satisfies LeaseInfo), 'utf-8')
    } catch { /* 租约是防护增强不是关键路径，失败静默 */ }
  }

  /** 释放租约（仅当仍归本 pid 持有——防误删他端接管后的新租约） */
  release(sessionId: string, pid: number): void {
    try {
      const f = this.file(sessionId)
      if (!existsSync(f)) return
      const info = JSON.parse(readFileSync(f, 'utf-8')) as LeaseInfo
      if (info.pid === pid) rmSync(f, { force: true })
    } catch { /* 同 acquire */ }
  }

  /** 查询租约（存活校验：持有进程死亡视为无租约） */
  holder(sessionId: string): LeaseInfo | null {
    try {
      const f = this.file(sessionId)
      if (!existsSync(f)) return null
      const info = JSON.parse(readFileSync(f, 'utf-8')) as LeaseInfo
      try {
        process.kill(info.pid, 0)
        return info
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM' ? info : null
      }
    } catch {
      return null
    }
  }
}
