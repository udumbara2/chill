import { toSessionSummary } from '@assistant-ai/core'
import type { SessionRecord, SessionSearchHit, SessionSummary } from '@assistant-ai/core'
import { tryGetHostAPI } from '../host/hostApi'

/**
 * 会话历史存储适配器（UI 端）
 *
 * 后端为 core 的 SessionPersistence（~/.chill/sessions/，与 CLI 共享同一套机制和数据），
 * 经 Electron IPC 调用；非 Electron 环境（浏览器 dev）回退 localStorage。
 *
 * legacy 迁移：首次读取且磁盘为空时，把 localStorage 旧数据（chatHistory_list）
 * 迁移进 SessionPersistence，并清理全部旧键（chatHistory_list / chatHistory / chat_history_*）。
 * 旧键 chatHistory（只写不读）与 chat_history_<id>（只读不写）是历史上的双写残留，
 * 无有效数据，直接清除不做迁移。
 */

const LEGACY_LIST_KEY = 'chatHistory_list'
const LEGACY_DEAD_KEYS = ['chatHistory']
const LEGACY_DEAD_PREFIX = 'chat_history_'
const FALLBACK_KEY = 'session_list'

function getApi() {
  return tryGetHostAPI()
}

/** 旧记录 { id, title, messages, tasks, timestamp } → SessionRecord */
function mapLegacyRecord(c: any): SessionRecord {
  const now = new Date().toISOString()
  return {
    id: c.id,
    title: c.title || '新对话',
    messages: c.messages ?? [],
    tasks: c.tasks,
    createdAt: c.timestamp ?? now,
    updatedAt: c.timestamp ?? now
  }
}

function readLegacyRecords(): SessionRecord[] {
  try {
    const raw = localStorage.getItem(LEGACY_LIST_KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.map(mapLegacyRecord)
  } catch (err) {
    console.error('读取 legacy 会话数据失败:', err)
    return []
  }
}

function clearLegacyKeys(): void {
  localStorage.removeItem(LEGACY_LIST_KEY)
  for (const k of LEGACY_DEAD_KEYS) localStorage.removeItem(k)
  for (const k of Object.keys(localStorage).filter(k => k.startsWith(LEGACY_DEAD_PREFIX))) {
    localStorage.removeItem(k)
  }
}

function sortByUpdatedAtDesc(records: SessionRecord[]): SessionRecord[] {
  return records.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

// ==================== 非 Electron 回退（localStorage，session_list 键） ====================

function fallbackList(): SessionRecord[] {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function fallbackWrite(records: SessionRecord[]): void {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(records))
}

function fallbackSave(record: SessionRecord): void {
  const list = fallbackList()
  const idx = list.findIndex(r => r.id === record.id)
  if (idx >= 0) list[idx] = record
  else list.unshift(record)
  fallbackWrite(list)
}

/**
 * 深拷贝剥离 Vue 响应式代理。
 * 调用方传入的 record.messages / record.tasks 常是 ref/Pinia 的响应式 Proxy，
 * Electron IPC 走 Structured Clone 序列化，Proxy 不可克隆会抛 DataCloneError
 * （曾被静默 catch 吞掉，导致 UI 端会话保存全部失败、聊天内容随窗口关闭丢失）。
 */
function toPlainRecord(record: SessionRecord): SessionRecord {
  return JSON.parse(JSON.stringify(record))
}

// ==================== 对外接口 ====================

/** 加载会话元数据列表（SessionSummary，updatedAt 降序）；首次为空时自动迁移 legacy localStorage 数据 */
export async function loadSessionSummaries(): Promise<SessionSummary[]> {
  const api = getApi()
  if (api?.sessionListMeta) {
    try {
      const result = await api.sessionListMeta()
      const records = result?.records
      if (result?.success && records && records.length > 0) {
        return records
      }
      // 磁盘为空 → 尝试迁移 legacy
      const legacy = readLegacyRecords()
      if (legacy.length > 0) {
        for (const record of legacy) {
          await api.sessionSave(record).catch((err: unknown) => console.error('迁移会话失败:', err))
        }
        clearLegacyKeys()
        return sortByUpdatedAtDesc(legacy).map(toSessionSummary)
      }
      return []
    } catch (err) {
      console.error('加载会话列表失败:', err)
      return []
    }
  }

  // 非 Electron 环境：localStorage 回退（summaries 由存量完整 record 映射；同样做一次 legacy 迁移）
  const stored = fallbackList()
  if (stored.length > 0) return sortByUpdatedAtDesc(stored).map(toSessionSummary)
  const legacy = readLegacyRecords()
  if (legacy.length > 0) {
    for (const record of legacy) fallbackSave(record)
    clearLegacyKeys()
    return sortByUpdatedAtDesc(legacy).map(toSessionSummary)
  }
  return []
}

/** upsert 一条会话记录（按 id 天然去重）；mode 透传 SaveMode（引擎 regenerate 需 replace）。
 *  失败如实返回 error（不静默吞——projectId 归属注入等链路需可感知） */
export async function saveSession(record: SessionRecord, mode?: 'merge' | 'replace'): Promise<{ success: boolean; error?: string }> {
  const api = getApi()
  if (api?.sessionSave) {
    try {
      const result = await api.sessionSave(toPlainRecord(record), mode)
      if (!result?.success) {
        console.error('保存会话失败:', result?.error)
        return { success: false, error: result?.error || '保存会话失败' }
      }
      return { success: true }
    } catch (err: any) {
      console.error('保存会话失败:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
  fallbackSave(toPlainRecord(record))
  return { success: true }
}

/** 按 id 直读单条会话记录（session:load 单文件直读；引擎 SessionStoreAdapter 用） */
export async function loadSession(id: string): Promise<{ success: boolean; record?: SessionRecord | null; error?: string }> {
  const api = getApi()
  if (api?.sessionLoad) {
    try {
      const result = await api.sessionLoad(id)
      if (!result?.success) return { success: false, error: result?.error || '读取会话失败' }
      return { success: true, record: result.record ?? null }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  }
  return { success: true, record: fallbackList().find((r) => r.id === id) ?? null }
}

/** 单字段归属补丁（session:patch-project → core patchProjectId；projectId 传 null 清除归属）。
 *  失败如实返回 error（同 saveSession 的错误透传约定） */
export async function patchSessionProject(id: string, projectId: string | null): Promise<{ success: boolean; error?: string }> {
  const api = getApi()
  if (api?.sessionPatchProject) {
    try {
      const result = await api.sessionPatchProject(id, projectId)
      if (!result?.success) {
        console.error('更新会话项目归属失败:', result?.error)
        return { success: false, error: result?.error || '更新会话项目归属失败' }
      }
      return { success: true }
    } catch (err: any) {
      console.error('更新会话项目归属失败:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
  // 非 Electron 回退：读改写
  const list = fallbackList()
  const idx = list.findIndex(r => r.id === id)
  if (idx < 0) return { success: false, error: '会话不存在' }
  if (projectId) list[idx].projectId = projectId
  else delete list[idx].projectId
  fallbackWrite(list)
  return { success: true }
}

/** 单字段标题补丁（session:patch-title → core patchTitle；落 titleSource='manual'，不动 updatedAt）。
 *  失败如实返回 error（同 saveSession 的错误透传约定） */
export async function patchSessionTitle(id: string, title: string): Promise<{ success: boolean; error?: string }> {
  const api = getApi()
  if (api?.sessionPatchTitle) {
    try {
      const result = await api.sessionPatchTitle(id, title)
      if (!result?.success) {
        console.error('重命名会话失败:', result?.error)
        return { success: false, error: result?.error || '重命名会话失败' }
      }
      return { success: true }
    } catch (err: any) {
      console.error('重命名会话失败:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
  // 非 Electron 回退：读改写
  const list = fallbackList()
  const idx = list.findIndex(r => r.id === id)
  if (idx < 0) return { success: false, error: '会话不存在' }
  list[idx].title = title
  list[idx].titleSource = 'manual'
  fallbackWrite(list)
  return { success: true }
}

/** 删除一条会话记录；失败如实返回 error（同 saveSession 的错误透传约定） */
export async function deleteSession(id: string): Promise<{ success: boolean; error?: string }> {
  const api = getApi()
  if (api?.sessionDelete) {
    try {
      const result = await api.sessionDelete(id)
      if (!result?.success) {
        console.error('删除会话失败:', result?.error)
        return { success: false, error: result?.error || '删除会话失败' }
      }
      return { success: true }
    } catch (err: any) {
      console.error('删除会话失败:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
  fallbackWrite(fallbackList().filter(r => r.id !== id))
  return { success: true }
}

/**
 * 会话内容搜索（侧边栏搜索框）：Electron 下走主进程 core sessionSearch（标题+正文），
 * 非 Electron 回退环境（浏览器 dev）仅按标题匹配。
 */
export async function searchSessions(query: string): Promise<SessionSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const api = getApi()
  if (api?.sessionSearch) {
    try {
      const result = await api.sessionSearch(q)
      return result?.success ? (result.hits ?? []) : []
    } catch (err) {
      console.error('搜索会话失败:', err)
      return []
    }
  }
  const lower = q.toLowerCase()
  return fallbackList()
    .filter(r => (r.title ?? '').toLowerCase().includes(lower))
    .map(r => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, matchKind: 'title' as const, snippet: '' }))
}
