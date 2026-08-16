import type { ProjectRecord } from '@assistant-ai/core'

/**
 * 项目存储适配器（UI 端）
 *
 * 后端为 core 的 ProjectPersistence（~/.chill/projects.json，单文件存整个项目数组），
 * 经 Electron IPC 调用；非 Electron 环境（浏览器 dev）回退 localStorage。
 */

const FALLBACK_KEY = 'project_list'

function getApi(): any {
  return (window as any).electronAPI
}

// ==================== 非 Electron 回退（localStorage，project_list 键） ====================

function fallbackList(): ProjectRecord[] {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function fallbackWrite(records: ProjectRecord[]): void {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(records))
}

function fallbackSave(record: ProjectRecord): void {
  const list = fallbackList()
  const idx = list.findIndex(p => p.id === record.id)
  if (idx >= 0) list[idx] = record
  else list.push(record)
  fallbackWrite(list)
}

/**
 * 深拷贝剥离 Vue 响应式代理（同 sessionStorage 的 DataCloneError 事故教训：
 * IPC Structured Clone 遇 Vue Proxy 抛错，必须先剥响应式）。
 */
function toPlainRecord(record: ProjectRecord): ProjectRecord {
  return JSON.parse(JSON.stringify(record))
}

// ==================== 对外接口 ====================

/** 加载项目列表（order 升序，由后端排序；回退路径在此排） */
export async function loadProjectList(): Promise<ProjectRecord[]> {
  const api = getApi()
  if (api?.projectList) {
    try {
      const result = await api.projectList()
      if (result?.success) return result.records ?? []
      console.error('加载项目列表失败:', result?.error)
      return []
    } catch (err) {
      console.error('加载项目列表失败:', err)
      return []
    }
  }
  return fallbackList().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** upsert 一条项目（按 id 天然去重）；失败返回 error 不静默吞（projectId 注入链路需可感知） */
export async function saveProject(record: ProjectRecord): Promise<{ success: boolean; error?: string }> {
  const api = getApi()
  if (api?.projectSave) {
    try {
      const result = await api.projectSave(toPlainRecord(record))
      if (!result?.success) {
        console.error('保存项目失败:', result?.error)
        return { success: false, error: result?.error || '保存项目失败' }
      }
      return { success: true }
    } catch (err: any) {
      console.error('保存项目失败:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
  fallbackSave(toPlainRecord(record))
  return { success: true }
}

/** 删除一个项目（仅删项目本身；会话归属清理由调用方逐个 patch 完成） */
export async function deleteProject(id: string): Promise<{ success: boolean; error?: string }> {
  const api = getApi()
  if (api?.projectDelete) {
    try {
      const result = await api.projectDelete(id)
      if (!result?.success) {
        console.error('删除项目失败:', result?.error)
        return { success: false, error: result?.error || '删除项目失败' }
      }
      return { success: true }
    } catch (err: any) {
      console.error('删除项目失败:', err)
      return { success: false, error: err?.message || String(err) }
    }
  }
  fallbackWrite(fallbackList().filter(p => p.id !== id))
  return { success: true }
}
