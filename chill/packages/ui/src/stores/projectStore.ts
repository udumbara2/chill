import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ProjectRecord, SessionSummary } from '@assistant-ai/core'
import { normalizePathForCompare, TITLE_SOURCE_PRIORITY } from '@assistant-ai/core'
import { loadProjectList, saveProject, deleteProject, checkDirectoryExists } from '../adapters/projectStorage'
import { loadSessionSummaries, patchSessionProject, patchSessionTitle } from '../adapters/sessionStorage'
import { tryGetHostAPI } from '../host/hostApi'

/**
 * 项目/会话管理 store
 * 项目 CRUD、会话列表缓存与按 projectId 的分桶（树形面板数据源）、当前会话派生高亮。
 * 归属约定：无 projectId 的会话归"未分组"（CLI 创建的会话同）；归属判定规则 =
 * 用户显式选择（新会话 pendingProjectId 出生意向，首次落盘由引擎保存包装消费）优先，
 * workdir 匹配兜底（chatEngine 保存包装事前注入 + groupSessionsByWorkdir 事后归组，
 * 同一套 normalizePathForCompare 匹配）——不再有"面板选中项目"的事前猜测。
 */
export const useProjectStore = defineStore('project', () => {
  // State
  const projects = ref<ProjectRecord[]>([])
  /** 会话元数据列表缓存（SessionSummary，updatedAt 降序；面板列表与归属查询共用，引擎保存后由 chatEngine 包装处 upsert 保新） */
  const sessions = ref<SessionSummary[]>([])
  const sessionsLoaded = ref(false)

  /** 当前会话 id（Home 的 currentConversationId watch 推入）：写边界按会话解析项目文件夹 + 面板派生高亮用 */
  const currentSessionId = ref<string | null>(null)

  /**
   * 新会话的出生意向归属（3.10：从全局单值改**按会话 id 登记/消费**——多会话并行下
   * 双新会话先后落盘归属各归各，不再互相覆盖）。首次落盘由 chatEngine 保存包装按 record.id
   * 消费；意向只属该次新会话——消费即清，会话切换**不**清（后台新会话的意向仍待兑现）。
   */
  const pendingProjects = ref<Map<string, string>>(new Map())

  function setCurrentSessionId(id: string | null): void {
    currentSessionId.value = id
  }

  /** 登记/清空某会话的出生意向（projectId 为 null = 清空） */
  function setPendingProject(sessionId: string | null, projectId: string | null): void {
    if (!sessionId) return
    if (projectId === null) pendingProjects.value.delete(sessionId)
    else pendingProjects.value.set(sessionId, projectId)
  }

  /** 查某会话的出生意向（save 闭包按 record.id 消费用） */
  function pendingProjectOf(sessionId: string | null): string | null {
    return (sessionId && pendingProjects.value.get(sessionId)) || null
  }

  /** 当前会话的出生意向（ProjectSelector 显示/选中态用） */
  const pendingProjectId = computed(() => pendingProjectOf(currentSessionId.value))

  // Getters

  /** 会话按 projectId 分桶（树形面板数据源）：键 null = 未分组；组内保持 sessions 的 updatedAt 降序 */
  const sessionsByProject = computed(() => {
    const map = new Map<string | null, SessionSummary[]>()
    for (const s of sessions.value) {
      const key = s.projectId ?? null
      const bucket = map.get(key)
      if (bucket) bucket.push(s)
      else map.set(key, [s])
    }
    return map
  })

  /** 当前会话归属的项目 id（面板树节点派生高亮用）：既有归属 > 新会话出生意向（pending）> null（未分组） */
  const activeProjectId = computed(() =>
    (currentSessionId.value ? sessionProjectIdOf(currentSessionId.value) : undefined) ?? pendingProjectId.value
  )

  function projectNameOf(projectId: string | undefined): string | null {
    if (!projectId) return null
    return projects.value.find(p => p.id === projectId)?.name ?? null
  }

  /** 会话当前归属（引擎保存包装处与 activeProjectId 派生查用：已归属会话保留既有归属） */
  function sessionProjectIdOf(sessionId: string): string | undefined {
    return sessions.value.find(s => s.id === sessionId)?.projectId
  }

  /** 记录是否已落盘（3.10 两态判定：sessionId 已预铸 ≠ 已落盘——摘要行只来自磁盘/成功保存） */
  function isSessionPersisted(sessionId: string | null): boolean {
    return !!sessionId && sessions.value.some(s => s.id === sessionId)
  }

  // Actions

  async function loadProjects(): Promise<void> {
    projects.value = await loadProjectList()
  }

  async function loadSessions(): Promise<void> {
    sessions.value = await loadSessionSummaries()
    sessionsLoaded.value = true
    await groupSessionsByWorkdir()
  }

  /**
   * workdir 归组（「项目=文件夹」迭代4）：无 projectId 且 workdir 非空的会话
   * （CLI 在绑定文件夹内启动产生），与已绑定 folderPath 的项目按 core 共享
   * normalizePathForCompare 规范化后匹配（与重复绑定判定同一套，壳侧不自写规范化），
   * 命中则单字段补丁写回 projectId（core patchProjectId 读单文件改字段原子写）。
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
      const result = await patchSessionProject(s.id, hit.id)
      if (result.success) s.projectId = hit.id
      else console.error('会话 workdir 归组失败:', s.id, result.error)
    }
  }

  /**
   * 懒采纳（「项目=文件夹」迭代5）：无 projectId 且 workdir 非空的会话**被打开时**，
   * 匹配既有绑定项目（normalizePathForCompare 同一套）→ 落空且文件夹仍存在则以文件夹名
   * 自动建项目并归组——CLI 在绑定文件夹内启动产生的会话经 /ui 接力后不再是"未分组"。
   * 来源无关（CLI/UI 未分组会话同一规则）、懒触发（仅会话被打开/handoff，启动不批量扫描）。
   * 全程 fail-soft：任一步不满足/失败 → 跳过，会话保持未分组，不抛错。
   * 3.6：**记录已落盘才采纳**——sessionId 已预铸但文件不存在（未落盘的新会话）时不采纳、
   * 不建项目（防幽灵项目/幽灵归属）；摘要行缺失即视为未落盘。
   */
  async function adoptSessionByWorkdir(sessionId: string): Promise<void> {
    try {
      const s = sessions.value.find(x => x.id === sessionId)
      // 3.6 守卫：!s = 记录未落盘（摘要仅来自磁盘扫描/upsert 成功保存后）——预铸 id 不采纳
      if (!s || s.projectId || !s.workdir) return
      if (!(await checkDirectoryExists(s.workdir))) return
      const hit = projectBoundToFolder(s.workdir)
      const projectId = hit
        ? hit.id
        : (await createProject(s.workdir.split(/[\\/]/).filter(Boolean).pop() || s.workdir, s.workdir)).id
      const result = await patchSessionProject(sessionId, projectId)
      if (result.success) s.projectId = projectId
      else console.error('会话懒采纳失败:', sessionId, result.error)
    } catch (err) {
      console.error('会话懒采纳失败:', sessionId, err)
    }
  }

  /** 归属注入前必须保证列表已加载，否则已归属会话会被误判为新会话而按 workdir 规则重挂 */
  async function ensureSessionsLoaded(): Promise<void> {
    if (!sessionsLoaded.value) await loadSessions()
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
    const real = await tryGetHostAPI()?.realpath?.(folderPath)
    const normalizedPath = real?.success && real.path ? real.path : folderPath
    const updated: ProjectRecord = { ...project, folderPath: normalizedPath, updatedAt: new Date().toISOString() }
    const result = await saveProject(updated)
    if (!result.success) throw new Error(result.error || '绑定文件夹失败')
    project.folderPath = normalizedPath
    project.updatedAt = updated.updatedAt
  }

  /** 删项目边界：仅清该项目会话的 projectId（逐个单字段补丁，会话归入"未分组"），不删会话本身 */
  async function removeProject(id: string): Promise<void> {
    const affected = sessions.value.filter(s => s.projectId === id)
    for (const s of affected) {
      await clearSessionProject(s)
    }
    const result = await deleteProject(id)
    if (!result.success) throw new Error(result.error || '删除项目失败')
    projects.value = projects.value.filter(p => p.id !== id)
  }

  /**
   * 会话归属变更（ProjectSelector 的已落盘未分组选择走此路径）。targetProjectId 为 null = 移出到未分组。
   * 单字段补丁（core patchProjectId）：壳不再感知 merge/replace 语义；
   * 写成功后原地突变列表条目即可。
   */
  async function moveSessionToProject(sessionId: string, targetProjectId: string | null): Promise<void> {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const result = await patchSessionProject(sessionId, targetProjectId)
    if (!result.success) throw new Error(result.error || '移动会话失败')
    session.projectId = targetProjectId ?? undefined
  }

  /** 清归属（删项目时逐个调用）：单字段补丁，写成功后原地突变 */
  async function clearSessionProject(session: SessionSummary): Promise<void> {
    const result = await patchSessionProject(session.id, null)
    if (result.success) session.projectId = undefined
    else console.error('清除会话项目归属失败:', session.id, result.error)
  }

  /**
   * 会话重命名（UI 行内编辑/CLI /session rename 同语义）：单字段补丁（core patchTitle，
   * 落 titleSource='manual' 且不动 updatedAt），写成功后原地突变 summary.title——
   * 不重排序、不动 updatedAt（改名非会话活动）；manual 标题不被引擎回合末 auto/default
   * 落盘冲掉由 merge 的 TITLE_SOURCE_PRIORITY 既有保护承担。
   */
  async function renameSession(sessionId: string, title: string): Promise<void> {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const result = await patchSessionTitle(sessionId, title)
    if (!result.success) throw new Error(result.error || '重命名会话失败')
    // 本地同步置 manual：upsert 守卫的本地依据，否则重启前挡不住引擎内存里旧标题的 upsert
    session.title = title
    session.titleSource = 'manual'
  }

  /**
   * 引擎保存成功后由 chatEngine 包装处调用：面板列表条目（标题/时间/归属）实时保新。
   * 标题优先级守卫（与磁盘 mergeRecord 同一 TITLE_SOURCE_PRIORITY 语义，>= 同级新 wins）：
   * 引擎内存 record 感知不到 UI 改名（patchTitle 只写磁盘且回声被过滤），其 upsert 携带的
   * 旧 default/auto 标题不得冲掉本地 manual；updatedAt/归属等其余字段照常保新。
   */
  function upsertSessionSummary(summary: SessionSummary): void {
    const idx = sessions.value.findIndex(s => s.id === summary.id)
    if (idx >= 0) {
      const existing = sessions.value[idx]
      const existingPriority = TITLE_SOURCE_PRIORITY[existing.titleSource ?? 'default'] ?? 0
      const incomingPriority = TITLE_SOURCE_PRIORITY[summary.titleSource ?? 'default'] ?? 0
      sessions.value[idx] = incomingPriority >= existingPriority
        ? summary
        : { ...summary, title: existing.title, titleSource: existing.titleSource }
    } else {
      sessions.value.unshift(summary)
    }
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
    currentSessionId,
    pendingProjectId,
    // Getters
    sessionsByProject,
    activeProjectId,
    projectNameOf,
    sessionProjectIdOf,
    isSessionPersisted,
    pendingProjectOf,
    // Actions
    setCurrentSessionId,
    setPendingProject,
    loadProjects,
    loadSessions,
    ensureSessionsLoaded,
    createProject,
    renameProject,
    projectBoundToFolder,
    bindFolder,
    removeProject,
    moveSessionToProject,
    renameSession,
    upsertSessionSummary,
    removeSession,
    adoptSessionByWorkdir
  }
})
