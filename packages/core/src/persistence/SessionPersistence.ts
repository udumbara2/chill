import { join } from 'path'
import * as fs from 'fs'
import type { IPathProvider } from '../interfaces/IPathProvider'
import type { Message } from '../types/models'

/**
 * 上下文压缩 checkpoint（追加式）：messages 全量保留永不删除，每次 /compact 追加一条。
 * 总结只存于此（不进消息流）；发给模型的"合成总结消息"由最新 checkpoint 发送时现组，不落盘。
 */
export interface CompactionCheckpoint {
  /** 唯一 id（merge 并集键） */
  id: string
  /** ISO 时间串（压缩发生时刻；必须晚于 upToTimestamp，合成消息的时间戳取它） */
  createdAt: string
  /** 切点：此时间点及之前的消息被本 checkpoint 覆盖（用 timestamp 不用 index——merge 后 index 不稳定） */
  upToTimestamp: string
  /** 交接摘要全文（Markdown 分节，含会话主题索引） */
  summary: string
  /** 用户的 /compact [引导语] */
  guidance?: string
}

export interface SessionRecord {
  /** `${Date.now()}-${随机6位}`，随机后缀防多 CLI 窗口同毫秒首消息撞 id */
  id: string
  title: string
  messages: Message[]
  /** 预留给 UI 任务列表（本期 CLI 不写） */
  tasks?: unknown[]
  /** 压缩 checkpoint 数组（逐次追加；可选字段，未压缩过的会话无此字段） */
  compactions?: CompactionCheckpoint[]
  /** ISO 时间串 */
  createdAt: string
  /** ISO 时间串 */
  updatedAt: string
  /** 标题来源：default=截断生成（可自动改题）；auto=LLM 已生成；manual=用户手动改名（后两者均不被覆盖）。缺省视为 'default' */
  titleSource?: 'default' | 'auto' | 'manual'
  /** 前台 Agent（T2 ChatEngine：Subagent 模板 subagent_type；缺省=裸模型。可选字段，旧记录向后兼容） */
  frontAgent?: string
  /** 最近一次 API 调用的实测 token 用量（provider 测量事实，本地不可推导——持久化以在
   *  /session load 后立即恢复状态栏上下文占比；可选字段，旧记录无此字段时该段隐藏，与既往行为一致） */
  lastUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** 会话归属的项目 id（UI 项目分组用；可选字段，CLI 不写→归"未分组"，旧记录向后兼容） */
  projectId?: string
  /** 会话工作目录（「项目=文件夹」绑定的联动落点；可选字段，旧记录向后兼容） */
  workdir?: string
}

export interface SessionResult {
  success: boolean
  error?: string
}

export interface LoadSessionResult extends SessionResult {
  record?: SessionRecord | null
}

export interface ListSessionsResult extends SessionResult {
  records?: SessionRecord[]
}

/**
 * save 写入模式：
 * - merge（默认）：读盘 → 合并 → 写盘，两端互写不破坏对方数据；
 * - replace：现状行为整盘覆写，仅供审计确认的"删除消息"路径（编排切换清理 tool 消息）使用
 */
export type SaveMode = 'merge' | 'replace'

/** watch 回调：record 为外部变更后的整条会话记录；null 表示会话文件已被删除 */
export type SessionWatchCallback = (record: SessionRecord | null) => void

/** 标题来源优先级：manual > auto > default（合并时保留高优先级一方的 title/titleSource） */
const TITLE_SOURCE_PRIORITY: Record<string, number> = { default: 0, auto: 1, manual: 2 }

/** 内存中 timestamp 是 Date 对象、落盘后变 ISO 字符串；比较/排序前必须经此归一，否则同一条消息会被误判为两条 */
function timeOf(t: unknown): number {
  if (t instanceof Date) return t.getTime()
  return new Date(t as string | number).getTime()
}

function normalizeTimestamp(t: unknown): string {
  const time = timeOf(t)
  return Number.isNaN(time) ? String(t ?? '') : new Date(time).toISOString()
}

/** 消息身份键：tool 消息用 toolCallId（同 ms 多条 tool 消息全靠它区分）；其余用 role+归一化 timestamp */
function messageKey(m: Message): string {
  if (m.toolCallId) return `tool:${m.toolCallId}`
  return `${m.role}:${normalizeTimestamp(m.timestamp)}`
}

/**
 * 消息合并：同键用新内容更新（流式语义：updateLastMessage 原地改内容、timestamp 不变，键稳定）；
 * 异键插入后按 timestamp 排序。Array.sort 稳定，同 timestamp 保持盘上的在前、新来的在后。
 */
function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const merged = existing.slice()
  const indexByKey = new Map<string, number>()
  existing.forEach((m, i) => indexByKey.set(messageKey(m), i))
  for (const m of incoming) {
    const key = messageKey(m)
    const idx = indexByKey.get(key)
    if (idx !== undefined) {
      merged[idx] = m
    } else {
      indexByKey.set(key, merged.length)
      merged.push(m)
    }
  }
  merged.sort((a, b) => (timeOf(a.timestamp) || 0) - (timeOf(b.timestamp) || 0))
  return merged
}

/** 任务身份键：优先 taskId，兼容 id；都没有则返回 null 走内容去重追加 */
function taskKey(t: unknown): string | null {
  if (t !== null && typeof t === 'object') {
    const o = t as Record<string, unknown>
    const id = o.taskId ?? o.id
    if (id !== undefined && id !== null) return String(id)
  }
  return null
}

/** tasks 按 taskId 同理合并：同键更新、异键追加（保持盘上在前）；无键任务按内容去重追加 */
function mergeTasks(existing: unknown[], incoming: unknown[]): unknown[] {
  const merged = existing.slice()
  const indexByKey = new Map<string, number>()
  existing.forEach((t, i) => {
    const key = taskKey(t)
    if (key !== null) indexByKey.set(key, i)
  })
  for (const t of incoming) {
    const key = taskKey(t)
    if (key === null) {
      if (!merged.some(e => JSON.stringify(e) === JSON.stringify(t))) merged.push(t)
      continue
    }
    const idx = indexByKey.get(key)
    if (idx !== undefined) {
      merged[idx] = t
    } else {
      indexByKey.set(key, merged.length)
      merged.push(t)
    }
  }
  return merged
}

/** compactions 按 id 并集：同 id 新的 wins，异 id 追加后按 createdAt 升序（防对端写盘丢字段——头号坑） */
function mergeCompactions(
  existing: CompactionCheckpoint[],
  incoming: CompactionCheckpoint[]
): CompactionCheckpoint[] {
  const merged = existing.slice()
  const indexById = new Map<string, number>()
  existing.forEach((c, i) => indexById.set(c.id, i))
  for (const c of incoming) {
    const idx = indexById.get(c.id)
    if (idx !== undefined) {
      merged[idx] = c
    } else {
      indexById.set(c.id, merged.length)
      merged.push(c)
    }
  }
  merged.sort((a, b) => (timeOf(a.createdAt) || 0) - (timeOf(b.createdAt) || 0))
  return merged
}

/** 取两个时间戳的 min/max（返回 ISO 串）；一侧缺失/非法时取另一侧 */
function pickTimestamp(a: unknown, b: unknown, mode: 'min' | 'max'): string {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? '' : new Date(tb).toISOString()
  if (Number.isNaN(tb)) return new Date(ta).toISOString()
  return new Date(mode === 'min' ? Math.min(ta, tb) : Math.max(ta, tb)).toISOString()
}

export class SessionPersistence {
  private sessionsDir: string
  /** 各会话文件最后一次由本实例写入/采纳的 mtime（ms）：watch 回声过滤与 loadIfNewer 锚定的判据 */
  private lastWrittenMtime = new Map<string, number>()
  private watchers = new Map<string, fs.FSWatcher>()

  /**
   * @param sessionsDirOverride 覆盖存储目录。用于自迭代体验窗口：CLI 在 workcopy 内运行时，
   * 会话重定向到 workcopy 内独立目录，不进正式版 ~/.chill/sessions/，随 workcopy 清理自动消失
   */
  constructor(pathProvider: IPathProvider, sessionsDirOverride?: string) {
    this.sessionsDir = sessionsDirOverride ?? join(pathProvider.getUserDataPath(), 'sessions')
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true })
    }
  }

  private filePathOf(id: string): string {
    return join(this.sessionsDir, `${id}.json`)
  }

  /** 按 updatedAt 降序返回全部会话；单个文件损坏时跳过并 warn，不影响其他会话 */
  async list(): Promise<ListSessionsResult> {
    try {
      const files = fs.readdirSync(this.sessionsDir)
      const records: SessionRecord[] = []
      for (const file of files) {
        // 只认 .json，跳过原子写可能残留的 .tmp
        if (!file.endsWith('.json')) continue
        try {
          const content = fs.readFileSync(join(this.sessionsDir, file), 'utf-8')
          records.push(JSON.parse(content) as SessionRecord)
        } catch (error: unknown) {
          console.warn(`Skipping corrupted session file ${file}:`, error)
        }
      }
      records.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      return { success: true, records }
    } catch (error: unknown) {
      console.error('Failed to list sessions:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async load(id: string): Promise<LoadSessionResult> {
    try {
      const filePath = this.filePathOf(id)
      if (!fs.existsSync(filePath)) {
        return { success: true, record: null }
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const record = JSON.parse(content) as SessionRecord
      return { success: true, record }
    } catch (error: unknown) {
      console.error('Failed to load session:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 原子写：先写 .tmp 再 rename 覆盖（同 id 天然 upsert）。
   * 内部一律用同步 fs API：autoSave 按消息高频触发，同步实现在 Node 单线程下
   * 天然排队，无 .tmp 并发写竞争（fs.promises 会引入竞争）。
   *
   * merge（默认）：先读盘合并再写——单一路径，不设快路径（"工具循环途中对端写入"
   * 场景下快路径会用不含对端消息的内存覆写已合并的磁盘记录）。
   * 任何模式写成功后 stat 记录 lastWrittenMtime[id]，供回声过滤与锚定。
   */
  async save(record: SessionRecord, mode: SaveMode = 'merge'): Promise<SessionResult> {
    try {
      const filePath = this.filePathOf(record.id)
      let toWrite = record
      if (mode === 'merge' && fs.existsSync(filePath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionRecord
          toWrite = this.mergeRecord(existing, record)
        } catch {
          // 磁盘记录损坏：以新记录为准整盘写入（与现状覆写行为一致）
          toWrite = record
        }
      }
      const tmpPath = `${filePath}.tmp`
      fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), 'utf-8')
      fs.renameSync(tmpPath, filePath)
      this.lastWrittenMtime.set(record.id, fs.statSync(filePath).mtimeMs)
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to save session:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 锚定：仅当磁盘记录比本实例最后一次写入/采纳更新时才读盘返回整 record。
   * mtime 与基线相同 → record: null（零读盘）；rename 不刷新 updatedAt，故判据必须是 mtime。
   * 该 id 无基线时先 stat 建基线并返回 null（首次不视为"更新"）；采纳后同步基线防重复触发。
   */
  async loadIfNewer(id: string): Promise<LoadSessionResult> {
    try {
      const filePath = this.filePathOf(id)
      if (!fs.existsSync(filePath)) {
        return { success: true, record: null }
      }
      const mtime = fs.statSync(filePath).mtimeMs
      const baseline = this.lastWrittenMtime.get(id)
      if (baseline === undefined) {
        this.lastWrittenMtime.set(id, mtime)
        return { success: true, record: null }
      }
      if (mtime === baseline) {
        return { success: true, record: null }
      }
      const record = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionRecord
      this.lastWrittenMtime.set(id, mtime)
      return { success: true, record }
    } catch (error: unknown) {
      console.error('Failed to load session if newer:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 监听某会话文件的外部变更。必须盯 sessions 目录而非文件：tmp+rename 原子写会换文件，
   * 盯文件会在第一次保存后丢监听。启动先 stat 建基线，否则首个变更事件无法区分回声与外部写入。
   * 变更后 mtime !== lastWrittenMtime[id] → 读盘 cb(record) 并更新基线；
   * 自身 save 造成的变更被基线过滤，绝不触发 cb。core 不常驻，由调用方按需启停。
   */
  watch(sessionId: string, cb: SessionWatchCallback): void {
    this.unwatch(sessionId)
    const filePath = this.filePathOf(sessionId)
    try {
      this.lastWrittenMtime.set(sessionId, fs.statSync(filePath).mtimeMs)
    } catch {
      this.lastWrittenMtime.delete(sessionId)
    }
    const watcher = fs.watch(this.sessionsDir, (_eventType, filename) => {
      // 只关心本会话的 .json；原子写的 .tmp 事件天然被过滤
      if (filename === `${sessionId}.json`) {
        this.handleSessionFileEvent(sessionId, filePath, cb)
      }
    })
    // 目录 watch 失败（如目录被删）不抛出，由 loadIfNewer 锚定兜底
    watcher.on('error', () => {})
    this.watchers.set(sessionId, watcher)
  }

  /** 停止监听：传 sessionId 停单个；不传停全部 */
  unwatch(sessionId?: string): void {
    if (sessionId === undefined) {
      for (const watcher of this.watchers.values()) watcher.close()
      this.watchers.clear()
      return
    }
    this.watchers.get(sessionId)?.close()
    this.watchers.delete(sessionId)
  }

  private handleSessionFileEvent(sessionId: string, filePath: string, cb: SessionWatchCallback): void {
    let mtime: number
    try {
      mtime = fs.statSync(filePath).mtimeMs
    } catch (error: unknown) {
      // 会话文件被（对端）删除：回调 null，不抛错、不重建空记录
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastWrittenMtime.delete(sessionId)
        cb(null)
      }
      return
    }
    if (mtime === this.lastWrittenMtime.get(sessionId)) return
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SessionRecord
      // 采纳后同步基线：防同一变更的后续事件重复触发
      this.lastWrittenMtime.set(sessionId, mtime)
      cb(record)
    } catch {
      // 对端直接写（非原子写）中途的瞬时事件：不更新基线，等后续事件重试
    }
  }

  /**
   * 合并磁盘记录与新记录：messages/tasks 按身份键合并；updatedAt 取 max、createdAt 取 min；
   * title/titleSource 保留高优先级（manual > auto > default，同级新的 wins）；
   * compactions 按 id 并集（一侧没有该字段时保留另一侧，不静默丢弃）；
   * lastUsage/projectId/workdir 取 incoming，缺失时保留 existing（防对端旧版写盘抹字段）。
   */
  private mergeRecord(existing: SessionRecord, incoming: SessionRecord): SessionRecord {
    const existingPriority = TITLE_SOURCE_PRIORITY[existing.titleSource ?? 'default'] ?? 0
    const incomingPriority = TITLE_SOURCE_PRIORITY[incoming.titleSource ?? 'default'] ?? 0
    const useIncomingTitle = incomingPriority >= existingPriority
    const compactions = mergeCompactions(existing.compactions ?? [], incoming.compactions ?? [])
    return {
      ...incoming,
      messages: mergeMessages(existing.messages ?? [], incoming.messages ?? []),
      tasks: mergeTasks(existing.tasks ?? [], incoming.tasks ?? []),
      // 两侧都从未压缩时不写该字段（保持未压缩会话的记录形态不变）
      ...(compactions.length > 0 ? { compactions } : { compactions: undefined }),
      // 实测用量随会话持久化：incoming 优先（保存方最新状态），缺失时保留 existing
      // （防对端旧版 chill 写盘静默抹掉该字段——与 compactions 同一防护）
      lastUsage: incoming.lastUsage ?? existing.lastUsage,
      // 项目归属随会话持久化：incoming 优先（归属变更方最新状态），缺失时保留 existing
      // （防对端旧版 chill 写盘静默抹掉归属——与 lastUsage 同一防护）
      projectId: incoming.projectId ?? existing.projectId,
      // 工作目录随会话持久化：incoming 优先（绑定/切换方最新状态），缺失时保留 existing
      // （防对端旧版 chill 写盘静默抹掉该字段——与 projectId 同一防护）
      workdir: incoming.workdir ?? existing.workdir,
      title: useIncomingTitle ? incoming.title : existing.title,
      titleSource: useIncomingTitle ? incoming.titleSource : existing.titleSource,
      createdAt: pickTimestamp(existing.createdAt, incoming.createdAt, 'min'),
      updatedAt: pickTimestamp(existing.updatedAt, incoming.updatedAt, 'max')
    }
  }

  async delete(id: string): Promise<SessionResult> {
    try {
      const filePath = this.filePathOf(id)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to delete session:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }
}
