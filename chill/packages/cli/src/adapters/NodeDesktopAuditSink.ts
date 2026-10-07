/**
 * 桌面审计 sink 的 Node 实现（CLI 侧装配；core 经 DesktopAuditSink 接口调用，见 IDesktopAudit.ts）。
 * 落盘布局：~/.chill/desktop-audit/audit-YYYY-MM-DD.jsonl（按日分文件，逐行追加）
 * + shots/<时间戳-毫秒>.png（有截屏结果时从 dataUri 解码落盘，entry.shot 回填相对路径）。
 * 每个进程首次写入时清理 7 天前的 audit-*.jsonl 与 shots/*.png（日期从文件名解析，解析不出不动）。
 * 全程 try/catch 吞咽 + 内部 promise 链串行（保行序）——审计是旁路不是关键路径，失败绝不影响动作执行。
 */

import { appendFile, mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DesktopAuditEntry, DesktopAuditSink, IPathProvider } from '@assistant-ai/core'

/** 审计保留天数（超过的按日文件与截图在进程首次写入时清理） */
const RETENTION_DAYS = 7

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** 按日文件名（本地时区；/desktop log 读今日文件经 todayFilePath 用同一约定） */
export function desktopAuditFileName(date: Date = new Date()): string {
  return `audit-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jsonl`
}

/** shots 文件名：20260818-103045-123.png（本地时区，毫秒防同秒撞名） */
function shotFileName(ts: string): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}.png`
}

export class NodeDesktopAuditSink implements DesktopAuditSink {
  private readonly dir: string
  /** 7 天清理只做一次（进程首个写入时） */
  private cleaned = false
  /** 串行链：保 JSONL 行序（同一进程内多条记录不交错） */
  private tail: Promise<void> = Promise.resolve()

  constructor(pathProvider: IPathProvider) {
    this.dir = join(pathProvider.getUserDataPath(), 'desktop-audit')
  }

  /** 今日审计文件完整路径（/desktop log 读取用） */
  todayFilePath(): string {
    return join(this.dir, desktopAuditFileName())
  }

  /** fire-and-forget：调用即忘，写盘经串行链异步完成，失败吞咽 */
  record(entry: DesktopAuditEntry, imageDataUri?: string): void {
    this.tail = this.tail.then(() => this.writeEntry(entry, imageDataUri)).catch(() => { /* 吞咽 */ })
  }

  private async writeEntry(entry: DesktopAuditEntry, imageDataUri?: string): Promise<void> {
    try {
      await mkdir(join(this.dir, 'shots'), { recursive: true })
      if (!this.cleaned) {
        this.cleaned = true
        await this.cleanExpired()
      }
      // 截图落盘（仅在确有截屏结果时；失败不阻塞条目本身，只少 shot 字段）
      if (imageDataUri) {
        try {
          const base64 = imageDataUri.replace(/^data:image\/\w+;base64,/, '')
          const name = shotFileName(entry.ts)
          await writeFile(join(this.dir, 'shots', name), Buffer.from(base64, 'base64'))
          entry.shot = `shots/${name}`
        } catch { /* 截图落盘失败：条目照记 */ }
      }
      await appendFile(join(this.dir, desktopAuditFileName(new Date(entry.ts))), JSON.stringify(entry) + '\n', 'utf8')
    } catch { /* 审计写盘失败：吞咽 */ }
  }

  /** 清理 7 天前的 audit-*.jsonl 与 shots/*（日期从文件名解析；解析不出的文件不动） */
  private async cleanExpired(): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const fileDate = (name: string, re: RegExp): number | null => {
      const m = name.match(re)
      if (!m) return null
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
      return Number.isNaN(t) ? null : t
    }
    try {
      for (const f of await readdir(this.dir)) {
        const t = fileDate(f, /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/)
        if (t !== null && t < cutoff) await unlink(join(this.dir, f)).catch(() => { /* 单文件删除失败跳过 */ })
      }
      for (const f of await readdir(join(this.dir, 'shots'))) {
        const t = fileDate(f, /^(\d{4})(\d{2})(\d{2})-\d{6}-\d{3}\.png$/)
        if (t !== null && t < cutoff) await unlink(join(this.dir, 'shots', f)).catch(() => { /* 单文件删除失败跳过 */ })
      }
    } catch { /* 清理失败：吞咽 */ }
  }
}
