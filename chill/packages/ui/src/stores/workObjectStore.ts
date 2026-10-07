import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { eventBus, EVENTS } from '@assistant-ai/core'
import { classifyFileType } from '../utils/workObjectFileType'

/**
 * 工作对象会话检测 store（迭代 7）：按会话跟踪活跃工作对象集
 *
 * 业务链「AI 操作对象 → ◐ 徽标 → 类型页签」的检测落点：
 * 监听 TOOL_CALL_STATUS_CHANGED，查"工具 → 对象类型"映射表判定活跃对象，
 * 按 sessionId 归集（sessionId → 各 type 的对象集合 + 最近活跃时间 + 徽标数据）。
 *
 * 边界（架构原则 2）：core 只出中性数据（sessionId/工具名/参数载荷），
 * 工具→类型的映射与判定全部在本文件，core 不知道视窗类型概念。
 *
 * 事件载荷三种形状（防御性解析，字段缺失即降级/跳过，不抛错）：
 * ① ChatEngine 完整形 { module, sessionId, toolCallStatus, toolParameters, toolResult, toolCallId, toolCall }
 *    ——工具循环终态主路径，sessionId 自迭代 7 core 修正起随载荷发出（首轮新会话可达）；
 * ② builtInToolExecutor 残缺形 { toolCallStatus, toolResult, toolCallId }
 *    ——写落盘/拒绝的直发事件，无工具名无参数，经 toolCallId 反查工具名后仍无路径则跳过
 *    （完整形孪生事件会补齐，去重由"对象 id 幂等"保证）；
 * ③ baseModelService 路径 { module, toolCallStatus, toolParameters, toolCallId, toolCall }
 *    ——有工具名有参数无 sessionId，sessionId 缺省时归属当前会话。
 */

// ==================== 类型 ====================

interface WorkObjectEntry {
  /** 对象标识（规范化文件路径 / 工作流文件路径） */
  id: string
  /** 视窗类型（document/code/html/generic/workflow，与 viewerRegistry 对应） */
  type: string
  /** 最近活跃时间（页签排序 / 默认聚焦 / 未看判定依据） */
  lastActiveAt: number
}

export interface WorkObjectTypeSummary {
  type: string
  /** 实例计数（该类型活跃对象数） */
  count: number
  /** 该类型最近活跃时间（取对象最大值） */
  lastActiveAt: number
  /** 有未看更新（◐ 聚合徽标：最近活跃晚于用户在 dock 中查看该类型的时刻） */
  unseen: boolean
}

interface SessionWorkObjects {
  /** key = `${type}:${objectId}`（同对象重复活跃幂等更新，不产生重复实例） */
  objects: Record<string, WorkObjectEntry>
  /** type → 用户在 dock 中查看该类型的时刻（dock 打开且页签聚焦即视为已看） */
  seenAt: Record<string, number>
}

// ==================== 工具 → 对象类型映射表（本文件唯一事实源；新类型接入 = 注册 viewer + 在此声明） ====================

/** 写文件类工具：按 workObjectFileType 的 classifyFileType 细分 document/code/html/generic */
const FILE_WRITE_TOOLS = new Set([
  'create_file',
  'insert_content',
  'replace_content',
  'delete_content',
  'delete_file'
])

// 说明性排除（查表即落空，不产生徽标）：
// - read_file/list_files/search_content 等只读工具：不修改对象，不算"操作对象"；
// - write_plan/submit_plan：规划模式内部文档，非用户工作对象；
// - create_task_list 等任务清单工具：落点为聊天区任务清单，不进视窗。

/** 工作流构建类路径：工作流持久化目录（~/.chill/workflows/）下的 JSON 文件 → workflow 类型 */
const isWorkflowPath = (filePath: string): boolean => {
  const n = filePath.replace(/\\/g, '/').toLowerCase()
  return n.endsWith('.json') && n.split('/').includes('workflows')
}

/** 写文件类工具的对象类型判定：工作流路径 → workflow，其余按扩展名分类（未注册落 generic 兜底） */
const classifyWriteTarget = (filePath: string): string =>
  isWorkflowPath(filePath) ? 'workflow' : classifyFileType(filePath)

/** 事件状态白名单：仅进行态/成功态记为对象活跃；failed/rejected（写未发生）不产生徽标 */
const ACTIVE_STATUSES = new Set(['pending', 'running', 'success'])

// ==================== 事件解析辅助 ====================

/** toolCallId → 工具名缓存（残缺形载荷经此反查工具名；有界，防长会话膨胀） */
const toolNameByCallId = new Map<string, string>()
const TOOL_NAME_CACHE_CAP = 500

const rememberToolName = (toolCallId: string, toolName: string) => {
  if (toolNameByCallId.size >= TOOL_NAME_CACHE_CAP) {
    // Map 迭代序即插入序，淘汰最旧
    const oldest = toolNameByCallId.keys().next().value
    if (oldest !== undefined) toolNameByCallId.delete(oldest)
  }
  toolNameByCallId.set(toolCallId, toolName)
}

/** 从载荷提取工具名（完整形/baseModelService 形：toolCall.function.name；残缺形：缓存反查） */
const extractToolName = (data: Record<string, any>): string | null => {
  const direct = (data.toolCall as any)?.function?.name
  if (typeof direct === 'string' && direct) return direct
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null
  return id ? toolNameByCallId.get(id) ?? null : null
}

/** 从载荷提取写目标路径（写文件类工具参数：path 单值 / paths 数组，防御性解析） */
const extractPaths = (data: Record<string, any>): string[] => {
  const params = data.toolParameters
  if (!params || typeof params !== 'object') return []
  const paths: string[] = []
  if (typeof params.path === 'string' && params.path) paths.push(params.path)
  if (Array.isArray(params.paths)) {
    for (const p of params.paths) {
      if (typeof p === 'string' && p) paths.push(p)
    }
  }
  return paths
}

/** 规范化路径（对象 id 用：统一分隔符，同对象幂等去重） */
const normalizeObjectId = (filePath: string): string => filePath.replace(/\\/g, '/')

// ==================== Store ====================

export const useWorkObjectStore = defineStore('workObject', () => {
  /** sessionId → 活跃对象集（reactive Map，嵌套对象深响应，事件驱动即刷新） */
  const sessions = reactive(new Map<string, SessionWorkObjects>())
  /** 当前会话 id（Home 的 currentConversationId watch 推入；新会话首轮为 null，事件自带 sessionId 不受影响） */
  const currentSessionId = ref<string | null>(null)

  const ensureSession = (sessionId: string): SessionWorkObjects => {
    let s = sessions.get(sessionId)
    if (!s) {
      s = { objects: {}, seenAt: {} }
      sessions.set(sessionId, s)
    }
    return s
  }

  // ==================== 事件监听（store 首次使用时挂载一次） ====================
  const handleToolCallStatusChanged = (data: unknown) => {
    if (!data || typeof data !== 'object') return
    const payload = data as Record<string, any>
    const status = typeof payload.toolCallStatus === 'string' ? payload.toolCallStatus : ''
    if (!ACTIVE_STATUSES.has(status)) return

    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null
    const directName = (payload.toolCall as any)?.function?.name
    if (toolCallId && typeof directName === 'string' && directName) {
      rememberToolName(toolCallId, directName)
    }

    const toolName = extractToolName(payload)
    if (!toolName || !FILE_WRITE_TOOLS.has(toolName)) return

    // sessionId 归属：完整形自带（首轮新会话关键）；缺失时归属当前会话；两者皆无则跳过
    const sessionId =
      typeof payload.sessionId === 'string' && payload.sessionId
        ? payload.sessionId
        : currentSessionId.value
    if (!sessionId) return

    const paths = extractPaths(payload)
    if (paths.length === 0) return

    const session = ensureSession(sessionId)
    const now = Date.now()
    for (const p of paths) {
      const type = classifyWriteTarget(p)
      const objectId = normalizeObjectId(p)
      const key = `${type}:${objectId}`
      const existing = session.objects[key]
      if (existing) existing.lastActiveAt = now
      else session.objects[key] = { id: objectId, type, lastActiveAt: now }
    }
  }

  eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, handleToolCallStatusChanged)

  // ==================== 动作 ====================

  const setCurrentSession = (sessionId: string | null) => {
    currentSessionId.value = sessionId
  }

  /** dock 中查看某类型即视为已看（dock 打开且页签聚焦时由 Home 调用） */
  const markTypeSeen = (type: string, sessionId?: string) => {
    const id = sessionId ?? currentSessionId.value
    if (!id) return
    ensureSession(id).seenAt[type] = Date.now()
  }

  // ==================== 查询（会话 → 类型摘要，按最近活跃降序） ====================

  const summariesFor = (sessionId: string | null): WorkObjectTypeSummary[] => {
    if (!sessionId) return []
    const session = sessions.get(sessionId)
    if (!session) return []
    const byType = new Map<string, { count: number; lastActiveAt: number }>()
    for (const obj of Object.values(session.objects)) {
      const agg = byType.get(obj.type)
      if (agg) {
        agg.count += 1
        if (obj.lastActiveAt > agg.lastActiveAt) agg.lastActiveAt = obj.lastActiveAt
      } else {
        byType.set(obj.type, { count: 1, lastActiveAt: obj.lastActiveAt })
      }
    }
    return Array.from(byType.entries())
      .map(([type, agg]) => ({
        type,
        count: agg.count,
        lastActiveAt: agg.lastActiveAt,
        unseen: agg.lastActiveAt > (session.seenAt[type] ?? 0)
      }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  /** 当前会话活跃类型摘要（最近活跃降序，首项即 ◐ 按下默认聚焦类型） */
  const currentSummaries = computed(() => summariesFor(currentSessionId.value))

  /** 当前会话各类型实例计数（dock 页签徽标数据源之一，与 pendingOperations 的 +N -M 整合） */
  const currentTypeCounts = computed(() => {
    const counts: Record<string, number> = {}
    for (const s of currentSummaries.value) counts[s.type] = s.count
    return counts
  })

  /** ◐ 聚合徽标：当前会话有未看更新的类型数 */
  const currentUnseenCount = computed(
    () => currentSummaries.value.filter(s => s.unseen).length
  )

  /** 当前会话某类型的活跃对象实例（最近活跃降序）——轻量视图实例列表的唯一事实源；
   *  pendingOperations 只负责 diff 叠加（+N -M/预览），不再承担实例源职责。
   *  lastActiveAt 同时是视图内容刷新的触发信号：AI 每次写入该对象都会推进它 */
  const objectsForType = (type: string): { path: string; name: string; lastActiveAt: number }[] => {
    const sessionId = currentSessionId.value
    if (!sessionId) return []
    const session = sessions.get(sessionId)
    if (!session) return []
    return Object.values(session.objects)
      .filter(o => o.type === type)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(o => ({ path: o.id, name: o.id.split('/').pop() || o.id, lastActiveAt: o.lastActiveAt }))
  }

  return {
    currentSessionId,
    setCurrentSession,
    markTypeSeen,
    summariesFor,
    currentSummaries,
    currentTypeCounts,
    currentUnseenCount,
    objectsForType
  }
})
