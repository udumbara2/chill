import * as fs from 'fs'
import * as path from 'path'

/**
 * 历史会话旁路元数据索引（search_sessions 分级检索改造）。
 *
 * 设计要点（规划见 weRealize/search_sessions检索改造规划.md）：
 * - 读路径惰性维护：不侵入 SessionPersistence 的 save 写链路，索引新鲜度靠
 *   stat 双指纹（mtimeMs + bytes）在每次检索时对账——文件系统是唯一真相源，
 *   CLI 与 Electron 双进程共享目录时无属主竞争，stale 条目必然被指纹差异暴露并重建。
 * - 首行为 schema 版本标记 {"v":N}：条目字段结构变化时递增，旧索引整体废弃重建。
 * - 索引文件放在 sessions 目录内、后缀 .jsonl：SessionPersistence.list() 与本模块的
 *   readdir 都只认 .json，天然互斥；预览模式（.preview-sessions）下随目录整体清理。
 * - 原子写：临时文件 + rename；tmp 清理 try/catch 容忍残留（本机 Node 24 在含
 *   非 ASCII 路径下删除类调用可能静默失败，残留 tmp 无 .json 后缀，readdir 忽略）。
 * - 元数据为纯代码提取（字段拷贝/计数/stat），零模型调用。
 */

/** 索引 schema 版本：条目字段结构变化时 +1 */
export const INDEX_VERSION = 1

export interface SessionIndexEntry {
  id: string
  title: string
  /** 首条 user 消息纯文本（空白归一）前 100 字，与列表摘要语义一致 */
  preview: string
  createdAt: string
  updatedAt: string
  messageCount: number
  /** 双指纹：文件字节数 */
  bytes: number
  /** 双指纹：文件 mtime 毫秒数 */
  mtimeMs: number
}

// ==================== 共享文本辅助（自 executeSearchSessions 上移，检索语义单一事实源） ====================

/** 取消息的纯文本（content 为 ContentPart[] 时拼接 text 部分） */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === 'text' && p.text)
      .map((p: any) => p.text)
      .join(' ')
  }
  return ''
}

/** 按空白分词并小写化（多词元 AND、顺序无关；兼容 "DeepSeek V4" 对 "deepseek-v4" 的写法差异） */
export function tokenizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** 全部词元都命中才算匹配（haystack 原样传入，内部小写化） */
export function allTokensHit(haystack: string, tokens: string[]): boolean {
  const h = haystack.toLowerCase()
  return tokens.every(t => h.includes(t))
}

/** 片段定位：截取最先出现的词元前后文（前 80 / 后 160 字符，空白归一） */
export function locateSnippet(text: string, tokens: string[]): string {
  const lower = text.toLowerCase()
  const candidates = tokens.map(t => lower.indexOf(t)).filter(i => i >= 0)
  const idx = candidates.length ? Math.min(...candidates) : 0
  const start = Math.max(0, idx - 80)
  const end = Math.min(text.length, idx + 160)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

// ==================== 原文预过滤（第 2 层：零命中/未命中文件不 parse） ====================

/**
 * 词元是否可安全用于原文（未 parse 的 JSON 文件文本）子串预过滤。
 * JSON 字符串值只转义 `"`、`\` 与控制字符（<0x20）——词元含这些字符时其原文形态
 * 会与逻辑形态不一致，预过滤可能漏报，须回退直接 parse（宁多 parse 不漏报）。
 */
export function rawPrefilterSafe(tokens: string[]): boolean {
  return tokens.every(t => !t.includes('"') && !t.includes('\\') && !/[\x00-\x1f]/.test(t))
}

/** 原文（小写化后）是否包含全部词元——不含任一则该文件不可能正文命中，可整文件跳过 */
export function rawContainsAllTokens(raw: string, tokens: string[]): boolean {
  const lower = raw.toLowerCase()
  return tokens.every(t => lower.includes(t))
}

// ==================== 索引读写 ====================

export function indexPathOf(sessionsDir: string): string {
  return path.join(sessionsDir, 'sessions-index.jsonl')
}

/**
 * 读索引；返回 null 表示需全量重建（不存在 / v 行不符 / 任何条目损坏）。
 * Claude 反面教训：索引必须可无损重建——损坏时整体丢弃重建，不做带病部分复用。
 */
export function loadIndex(sessionsDir: string): Map<string, SessionIndexEntry> | null {
  let text: string
  try {
    text = fs.readFileSync(indexPathOf(sessionsDir), 'utf-8')
  } catch {
    return null
  }
  try {
    const lines = text.split('\n').filter(l => l.trim() !== '')
    if (lines.length === 0) return null
    const head = JSON.parse(lines[0])
    if (!head || typeof head !== 'object' || head.v !== INDEX_VERSION) return null
    const map = new Map<string, SessionIndexEntry>()
    for (let i = 1; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]) as SessionIndexEntry
      if (!entry || typeof entry.id !== 'string' || typeof entry.mtimeMs !== 'number' || typeof entry.bytes !== 'number') {
        return null
      }
      map.set(entry.id, entry)
    }
    return map
  } catch {
    return null
  }
}

/** 从已 parse 的会话记录提取索引条目。id 以文件名（寻址真相）为准，非 record.id。 */
export function extractEntry(id: string, record: any, bytes: number, mtimeMs: number): SessionIndexEntry {
  const messages = Array.isArray(record?.messages) ? record.messages : []
  const firstUser = messages.find((m: any) => m?.role === 'user')
  const preview = textOf(firstUser?.content).replace(/\s+/g, ' ').trim().slice(0, 100)
  return {
    id,
    title: String(record?.title ?? ''),
    preview,
    createdAt: String(record?.createdAt ?? ''),
    updatedAt: String(record?.updatedAt ?? ''),
    messageCount: messages.length,
    bytes,
    mtimeMs
  }
}

export interface EnsureIndexResult {
  /** updatedAt 降序的全部条目 */
  entries: SessionIndexEntry[]
  /** 是否需要写回索引文件 */
  dirty: boolean
  /** 本次实际 parse 正文的文件数（0 = 全部命中缓存） */
  parsedCount: number
}

/**
 * 惰性对账：readdir + stat 拿双指纹，与缓存条目比对——变了才 parse 重建该条，
 * 没变直接复用。sessionsDir 不存在（全新安装）视为空索引，不报错。
 */
export function ensureIndex(sessionsDir: string): EnsureIndexResult {
  let files: string[]
  try {
    files = fs.readdirSync(sessionsDir)
  } catch {
    return { entries: [], dirty: false, parsedCount: 0 }
  }
  const jsonFiles = files.filter(f => f.endsWith('.json'))
  const prev = loadIndex(sessionsDir)
  const entries: SessionIndexEntry[] = []
  const seen = new Set<string>()
  let dirty = false
  let parsedCount = 0
  for (const file of jsonFiles) {
    const id = file.slice(0, -'.json'.length)
    seen.add(id)
    let stat: fs.Stats
    try {
      stat = fs.statSync(path.join(sessionsDir, file))
    } catch {
      continue
    }
    const cached = prev?.get(id)
    if (cached && cached.bytes === stat.size && cached.mtimeMs === stat.mtimeMs) {
      entries.push(cached)
      continue
    }
    // 新增或漂移：parse 重建该条
    try {
      const record = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf-8'))
      entries.push(extractEntry(id, record, stat.size, stat.mtimeMs))
      parsedCount++
      dirty = true
    } catch {
      // 正文损坏：有旧条目则沿用 last-known-good，没有则跳过（与 list() 跳过损坏文件一致）
      if (cached) entries.push(cached)
    }
  }
  // 有缓存条目对应的文件已消失（会话被删）→ 条目集变化，需写回
  if (prev) {
    for (const id of prev.keys()) {
      if (!seen.has(id)) {
        dirty = true
        break
      }
    }
  }
  entries.sort((a, b) => {
    const d = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    return d !== 0 ? d : (a.id < b.id ? -1 : 1)
  })
  return { entries, dirty, parsedCount }
}

/**
 * 原子写回（临时文件 + rename）。失败仅意味着下次检索多 parse 一轮，不影响正确性；
 * 双进程并发重建时 last-writer-wins，条目都派生自同一批 stat，收敛一致。
 */
export function saveIndexAtomic(sessionsDir: string, entries: SessionIndexEntry[]): boolean {
  const target = indexPathOf(sessionsDir)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    const body = [`{"v":${INDEX_VERSION}}`, ...entries.map(e => JSON.stringify(e))].join('\n') + '\n'
    fs.writeFileSync(tmp, body, 'utf-8')
    fs.renameSync(tmp, target)
    return true
  } catch {
    // 清理残留 tmp：容忍失败（CJK 路径下删除可能静默失败；残留无 .json 后缀，readdir 忽略）
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 无害残留 */
    }
    return false
  }
}
