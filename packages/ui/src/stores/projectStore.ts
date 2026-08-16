import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ProjectRecord, SessionRecord } from '@assistant-ai/core'
import { normalizePathForCompare } from '@assistant-ai/core'
import { loadProjectList, saveProject, deleteProject } from '../adapters/projectStorage'
import { loadSessionList, saveSession } from '../adapters/sessionStorage'
import { IPCKeyValueStore } from '../adapters/IPCKeyValueStore'

/** currentProjectId 持久化键（与面板状态同一机制：IPCKeyValueStore + localStorage 回退） */
const CURRENT_PROJECT_KEY = 'workspace-current-project'

/**
 * 项目/会话管理 store
 * 项目 CRUD、当前选中项目（持久化，刷新后保持）、会话列表与按 projectId 的分组过滤。
 * 归属约定：currentProjectId 为 null = "未分组"；CLI 创建的无 projectId 会话同样归"未分组"。
 */
export const useProjectStore = defineStore('project', () => {
  // State
  const projects = ref<ProjectRecord[]>([])
  /** 会话列表缓存（updatedAt 降序；面板列表与归属查询共用，引擎保存后由 chatEngine 包装处 upsert 保新） */
  const sessions = ref<SessionRecord[]>([])
  const sessionsLoaded = ref(false)

  // currentProjectId 持久化（IPCKeyValueStore + localStorage 回退；须先于 currentProjectId 初始化）
  const kvStore = typeof window.electronAPI?.getKeyValue === 'function' ? new IPCKeyValueStore() : null

  function loadPersistedCurrentProject(): string | null {
    try {
      const raw = kvStore
        ? kvStore.getItem(CURRENT_PROJECT_KEY)
        : localStorage.getItem(CURRENT_PROJECT_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  const currentProjectId = ref<string | null>(loadPersistedCurrentProject())

  /** 当前会话 id（Home 的 currentConversationId watch 推入）：写边界按会话解析项目文件夹用 */
  const currentSessionId = ref<string | null>(null)

  function setCurrentSessionId(id: string | null): void {
    currentSessionId.value = id
  }

  function persistCurrentProject(): void {
    try {
      const raw = JSON.stringify(currentProjectId.value)
      if (kvStore) kvStore.setItem(CURRENT_PROJECT_KEY, raw)
      else localStorage.setItem(CURRENT_PROJECT_KEY, raw)
    } catch { /* 持久化失败不影响使用 */ }
  }

  // Getters

  /** 当前过滤下的会话：选中项目 → 该项目会话；未分组 → 无 projectId 的会话 */
  const visibleSessions = computed(() =>
    currentProjectId.value
      ? sessions.value.filter(s => s.projectId === currentProjectId.value)
      : sessions.value.filter(s => !s.projectId)
  )

  function projectNameOf(projectId: string | undefined): string | null {
    if (!projectId) return null
    return projects.value.find(p => p.id === projectId)?.name ?? null
  }

  /** 会话当前归属（引擎保存包装处查用：已归属会话不被当前选中项目回写覆盖） */
  function sessionProjectIdOf(sessionId: string): string | undefined {
    return sessions.value.find(s => s.id === sessionId)?.projectId
  }

  // Actions

  async function loadProjects(): Promise<void> {
    projects.value = await loadProjectList()
  }

  async function loadSessions(): Promise<void> {
    sessions.value = await loadSessionList()
    sessionsLoaded.value = true
    await groupSessionsByWorkdir()
  }

  /**
   * workdir 归组（「项目=文件夹」迭代4）：无 projectId 且 workdir 非空的会话
   * （CLI 在绑定文件夹内启动产生），与已绑定 folderPath 的项目按 core 共享
   * normalizePathForCompare 规范化后匹配（与重复绑定判定同一套，壳侧不自写规范化），
   * 命中则一次性 merge 写回 projectId（workdir 有 merge 防护不会丢）。
   * 幂等、只补不改已有归属；存量无 workdir 会话不做自动归组。
   */
  async function groupSessionsByWorkdir(): Promise<void> {
    // 项目列表可能尚未加载（同 Home 会话切换 watch 的懒加载兜底）
    if (projects.value.length === 0) await loadProjects()
    const boundProjects = projects.value.filter(p => !!p.folderPath)
    if (boundProjects.length === 0) return
    for (const s of sessions.value) {
      if (s.projectId || !s.workdir) continue
      const target = normalizePathForCompare(s.workdir)
      const hit = boundProjects.find(p => normalizePathForCompare(p.folderPath!) === target)
      if (!hit) continue
      const result = await saveSession({ ...s, projectId: hit.id }, 'merge')
      if (result.success) s.projectId = hit.id
      else console.error('会话 workdir 归组失败:', s.id, result.error)
    }
  }

  /** 归属注入前必须保证列表已加载，否则已归属会话会被误判为新会话而改挂当前项目 */
  async function ensureSessionsLoaded(): Promise<void> {
    if (!sessionsLoaded.value) await loadSessions()
  }

  function selectProject(id: string | null): void {
    currentProjectId.value = id
    persistCurrentProject()
  }

  async function createProject(name: string, folderPath?: string): Promise<ProjectRecord> {
    const now = new Date().toISOString()
    const record: ProjectRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      folderPath,
      createdAt: now,
      updatedAt: now,
      order: projects.value.length > 0 ? Math.max(...projects.value.map(p => p.order ?? 0)) + 1 : 0
    }
    const result = await saveProject(record)
    if (!result.success) throw new Error(result.error || '新建项目失败')
    projects.value.push(record)
    return record
  }

  async function renameProject(id: string, name: string): Promise<void> {
    const project = projects.value.find(p => p.id === id)
    if (!project) return
    const updated: ProjectRecord = { ...project, name, updatedAt: new Date().toISOString() }
    const result = await saveProject(updated)
    if (!result.success) throw new Error(result.error || '重命名项目失败')
    project.name = name
    project.updatedAt = updated.updatedAt
  }

  /** 查文件夹当前归属（重复绑定阻止）：core 共享 normalizePathForCompare 规范化后比较 */
  function projectBoundToFolder(folderPath: string, excludeProjectId?: string): ProjectRecord | null {
    const target = normalizePathForCompare(folderPath)
    return projects.value.find(p =>
      p.id !== excludeProjectId && !!p.folderPath && normalizePathForCompare(p.folderPath) === target
    ) ?? null
  }

  /** 绑定/更换文件夹（realpath 规范化后读改写全记录 save；调用方负责重复绑定检查） */
  async function bindFolder(id: string, folderPath: string): Promise<void> {
    const project = projects.value.find(p => p.id === id)
    if (!project) return
    // realpath 规范化（主进程真 fs）：符号链接别名归一到同一物理路径，防重复绑定的漏网
    const real = await window.electronAPI?.realpath?.(folderPath)
    const normalizedPath = real?.success && real.path ? real.path : folderPath
    const updated: ProjectRecord = { ...project, folderPath: normalizedPath, updatedAt: new Date().toISOString() }
    const result = await saveProject(updated)
    if (!result.success) throw new Error(result.error || '绑定文件夹失败')
    project.folderPath = normalizedPath
    project.updatedAt = updated.updatedAt
  }

  /**
   * 解绑文件夹。core save 合并防护（ProjectPersistence.save：incoming folderPath 为
   * undefined 时保留盘上旧值），故解绑必须显式写空串穿透防护；UI 侧以 falsy 判定未绑定。
   */
  async function unbindFolder(id: string): Promise<void> {
    const project = projects.value.find(p => p.id === id)
    if (!project) return
    const updated: ProjectRecord = { ...project, folderPath: '', updatedAt: new Date().toISOString() }
    const result = await saveProject(updated)
    if (!result.success) throw new Error(result.error || '解绑文件夹失败')
    project.folderPath = ''
    project.updatedAt = updated.updatedAt
  }

  /**
   * 删项目边界：仅清该项目会话的 projectId（逐个 patch 后 save），不删会话本身；
   * 删的是当前选中项目时归位"未分组"。
   */
  async function removeProject(id: string): Promise<void> {
    const affected = sessions.value.filter(s => s.projectId === id)
    for (const s of affected) {
      await clearSessionProject(s)
    }
    const result = await deleteProject(id)
    if (!result.success) throw new Error(result.error || '删除项目失败')
    projects.value = projects.value.filter(p => p.id !== id)
    if (currentProjectId.value === id) selectProject(null)
  }

  /**
   * 会话归属变更（"移动到项目"菜单）。targetProjectId 为 null = 移出到未分组。
   * 移入走 merge（incoming projectId 优先）；移出必须 replace——merge 防护会保留盘上旧归属，
   * 此处持有列表全量记录，整盘覆写安全。
   */
  async function moveSessionToProject(sessionId: string, targetProjectId: string | null): Promise<void> {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const patched: SessionRecord = { ...session, projectId: targetProjectId ?? undefined }
    const result = await saveSession(patched, targetProjectId ? 'merge' : 'replace')
    if (!result.success) throw new Error(result.error || '移动会话失败')
    session.projectId = targetProjectId ?? undefined
  }

  /** 清归属（删项目时逐个调用）：replace 覆写绕过 merge 的 projectId 保留防护 */
  async function clearSessionProject(session: SessionRecord): Promise<void> {
    const patched: SessionRecord = { ...session, projectId: undefined }
    const result = await saveSession(patched, 'replace')
    if (result.success) session.projectId = undefined
    else console.error('清除会话项目归属失败:', session.id, result.error)
  }

  /** 引擎保存成功后由 chatEngine 包装处调用：面板列表条目（标题/时间/归属）实时保新 */
  function upsertSession(record: SessionRecord): void {
    const idx = sessions.value.findIndex(s => s.id === record.id)
    const plain: SessionRecord = JSON.parse(JSON.stringify(record))
    if (idx >= 0) sessions.value[idx] = plain
    else sessions.value.unshift(plain)
    sessions.value.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }

  /** 会话删除成功后由面板调用：列表条目即时移除 */
  function removeSession(sessionId: string): void {
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
  }

  return {
    // State
    projects,
    sessions,
    sessionsLoaded,
    currentProjectId,
    currentSessionId,
    // Getters
    visibleSessions,
    projectNameOf,
    sessionProjectIdOf,
    // Actions
    setCurrentSessionId,
    loadProjects,
    loadSessions,
    ensureSessionsLoaded,
    selectProject,
    createProject,
    renameProject,
    projectBoundToFolder,
    bindFolder,
    unbindFolder,
    removeProject,
    moveSessionToProject,
    upsertSession,
    removeSession
  }
})
