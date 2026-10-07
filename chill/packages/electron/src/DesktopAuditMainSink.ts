// 桌面审计主进程落盘（desktop:audit 单工 IPC 的接收端）
// 条目逐行 append 到 ~/.chill/desktop-audit/audit-YYYY-MM-DD.jsonl；
// 截图 data URI 解码落盘 shots/<时间戳-毫秒>.png 并把相对路径回填 entry.shot；
// 每进程首次写入时清理 7 天前的审计文件；全程 try/catch——审计失败不得影响工具执行
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

/** 审计条目形状（与 core DesktopAuditSink 契约对齐；shot 由本模块回填相对路径） */
export interface DesktopAuditEntry {
  ts: number
  tool: string
  action: string
  desc: string
  purpose?: string
  coord?: { x: number; y: number }
  approval: string
  ok: boolean
  error?: string
  batch?: number
  shot?: string
  [key: string]: unknown
}

const AUDIT_DIR = join(os.homedir(), '.chill', 'desktop-audit')
const SHOTS_DIR = join(AUDIT_DIR, 'shots')
const RETENTION_MS = 7 * 24 * 3600 * 1000

// 每进程只在首次写入时清理一次，避免每条记录都扫目录
let cleaned = false

/** 删除 7 天前的审计日志与截图（按 mtime 判定，逐文件容错） */
function cleanupOldFiles(): void {
  const cutoff = Date.now() - RETENTION_MS
  for (const dir of [AUDIT_DIR, SHOTS_DIR]) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue // 目录不存在等情况：无需清理
    }
    for (const name of names) {
      try {
        const full = join(dir, name)
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
      } catch {
        // 单文件失败不影响其余清理
      }
    }
  }
}

/** 本地日期文件名：audit-YYYY-MM-DD.jsonl */
function auditFileName(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `audit-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`
}

/** 从 data URI 解出 PNG 字节；非 data:image 前缀返回 null（不落盘、不报错） */
function decodeImageDataUri(dataUri: string): Buffer | null {
  const comma = dataUri.indexOf(',')
  if (!dataUri.startsWith('data:image/') || comma < 0) return null
  return Buffer.from(dataUri.slice(comma + 1), 'base64')
}

/**
 * 记录一条桌面审计：截图（如有）先落盘回填 shot，再 append 一行 JSON。
 * 全程静默容错——任何失败只打 console，不向调用方抛错。
 */
export function recordDesktopAudit(entry: DesktopAuditEntry, imageDataUri?: string): void {
  try {
    if (!cleaned) {
      cleaned = true
      cleanupOldFiles()
    }
    fs.mkdirSync(SHOTS_DIR, { recursive: true })

    const finalEntry: DesktopAuditEntry = { ...entry }
    if (imageDataUri) {
      const bytes = decodeImageDataUri(imageDataUri)
      if (bytes) {
        const tsMs = typeof entry.ts === 'number' ? entry.ts : Date.now()
        const shotName = `${tsMs}.png`
        fs.writeFileSync(join(SHOTS_DIR, shotName), bytes)
        finalEntry.shot = `shots/${shotName}` // 相对 AUDIT_DIR 的路径
      }
    }

    const day = new Date(typeof entry.ts === 'number' ? entry.ts : Date.now())
    fs.appendFileSync(join(AUDIT_DIR, auditFileName(day)), JSON.stringify(finalEntry) + '\n', 'utf8')
  } catch (error) {
    console.warn('[DesktopAudit] 落盘失败（已忽略）:', error instanceof Error ? error.message : error)
  }
}
