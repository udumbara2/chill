import type { SessionRecord } from '@assistant-ai/core'

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

function getApi(): any {
  return (window as any).electronAPI
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

/** 加载会话列表（updatedAt 降序）；首次为空时自动迁移 legacy localStorage 数据 */
export async function loadSessionList(): Promise<SessionRecord[]> {
  const api = getApi()
  if (api?.sessionList) {
    try {
      const result = await api.sessionList()
      if (result?.success && result.records?.length > 0) {
        return result.records
      }
      // 磁盘为空 → 尝试迁移 legacy
      const legacy = readLegacyRecords()
      if (legacy.length > 0) {
        for (const record of legacy) {
          await api.sessionSave(record).catch((err: unknown) => console.error('迁移会话失败:', err))
        }
        clearLegacyKeys()
        return sortByUpdatedAtDesc(legacy)
      }
      return []
    } catch (err) {
      console.error('加载会话列表失败:', err)
      return []
    }
  }

  // 非 Electron 环境：localStorage 回退（同样做一次 legacy 迁移）
  const stored = fallbackList()
  if (stored.length > 0) return sortByUpdatedAtDesc(stored)
  const legacy = readLegacyRecords()
  if (legacy.length > 0) {
    for (const record of legacy) fallbackSave(record)
    clearLegacyKeys()
    return sortByUpdatedAtDesc(legacy)
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

/** 按 id 加载一条会话记录（引擎 SessionStoreAdapter 用；IPC 无 session:load，经 list 查找） */
export async function loadSession(id: string): Promise<{ success: boolean; record?: SessionRecord | null; error?: string }> {
  const api = getApi()
  if (api?.sessionList) {
    try {
      const result = await api.sessionList()
      if (!result?.success) return { success: false, error: result?.error || '读取会话列表失败' }
      return { success: true, record: (result.records ?? []).find((r: SessionRecord) => r.id === id) ?? null }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
  }
  return { success: true, record: fallbackList().find((r) => r.id === id) ?? null }
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
