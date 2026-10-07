/**
 * M6 类一：双端会话同步纯逻辑服务（SessionSyncService）。
 *
 * 定位：无 RelayBridge 依赖、零引擎耦合，一切 IO 经 deps 参数注入，可独立单测。
 * 真相源只读既有两者：sessionIndex（sessions-index.jsonl 惰性索引）+ ProjectPersistence
 * （projects.json）——不引入任何新真相源。
 *
 * 三个能力（对应协议 catalog.state / catalog.sync 对账 / history.page）：
 * - buildCatalog：目录（projects + sessions 元数据 + activeSessionId）。
 *   悬空 projectId 归一化：指向不存在项目的会话按未分组（projectId: null）输出——
 *   与桌面 UI 删项目口径一致（projectStore.removeProject 先逐个清会话 projectId 再删项目，
 *   删项目后会话即归"未分组"）。
 * - diffCatalog：按 updatedAt 比对手机上报的已知版本，产出 { upserts, deletes, full }。
 *   删项目（UI 路径清 projectId 不动 updatedAt，diff 看不见 session 行变化）经两路收敛：
 *   projectsRev 变化触发项目全量重发；手机对 projectId 不在已知项目集合的会话按未分组
 *   呈现（与 buildCatalog 归一化是同一条规则的两个执行点，协议侧登记于 PROTOCOL-FROZEN）。
 * - pageHistory：按 messageKey 游标倒序分页读会话历史，消息序列化为传输形态。
 *
 * 线形类型（CatalogSessionMeta/SyncMessage/CatalogSyncBody/HistoryPageBody 等）的唯一事实点
 * 在 ./relay/envelope.ts（M6 协议类型区），本服务 import type 对齐，不双源。
 * 位置纪律：本模块读文件真相源（fs），不在 services/relay/ 红线目录内（该目录全部
 * Node-free/renderer 安全），只进 index.ts（Node 主入口），不进 index.renderer.ts。
 */
import { ensureIndex, saveIndexAtomic, textOf } from './sessionIndex'
import { messageKey, type SessionRecord } from '../persistence/SessionPersistence'
import type { ProjectRecord } from '../persistence/ProjectPersistence'
import { ContentBlockType, MessageRole, type Message } from '../types/models'
import type {
  CatalogSessionMeta,
  CatalogSyncBody,
  HistoryPageBody,
  SyncMessage,
} from './relay/envelope'

export type { CatalogSessionMeta, SyncMessage } from './relay/envelope'

// ==================== 目录（catalog） ====================

export interface SessionCatalog {
  projects: ProjectRecord[]
  sessions: CatalogSessionMeta[]
  /** 桌面当前活跃会话（引擎内存态，由桥装配时注入；无则 null） */
  activeSessionId: string | null
  /** 项目集合修订号：projects 任一增/删/改即变，供 diffCatalog 判定项目全量重发 */
  projectsRev: string
}

export interface BuildCatalogDeps {
  /** 会话目录（sessionIndex 索引所在目录） */
  sessionsDir: string
  /** 项目真相源读取（ProjectPersistence.list 的适配闭包） */
  listProjects: () => Promise<ProjectRecord[]>
  /** 当前引擎活跃会话 id（可选） */
  activeSessionId?: string | null
}

/** FNV-1a 32bit：项目集合修订号（确定性、紧凑；项目极少，无需密码学强度） */
function projectsRevision(projects: ProjectRecord[]): string {
  const s = projects.map(p => `${p.id}:${p.updatedAt}`).sort().join('|')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** 构建目录：读索引（惰性对账，dirty 时写回维持索引新鲜度，与 sessionSearch 同路径）+ 项目表 */
export async function buildCatalog(deps: BuildCatalogDeps): Promise<SessionCatalog> {
  const { entries, dirty } = ensureIndex(deps.sessionsDir)
  if (dirty) saveIndexAtomic(deps.sessionsDir, entries)
  const projects = await deps.listProjects()
  const projectIds = new Set(projects.map(p => p.id))
  const sessions: CatalogSessionMeta[] = entries.map(e => ({
    id: e.id,
    title: e.title,
    titleSource: e.titleSource,
    projectId: e.projectId && projectIds.has(e.projectId) ? e.projectId : null,
    workdir: e.workdir,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    preview: e.preview,
  }))
  return {
    projects,
    sessions,
    activeSessionId: deps.activeSessionId ?? null,
    projectsRev: projectsRevision(projects),
  }
}

// ==================== 目录对账（diff） ====================

/** 手机经 catalog.sync 上报的已知版本（线形 = CatalogSyncBody） */
export type KnownCatalogState = CatalogSyncBody

export interface CatalogDiff {
  /** true = 手机侧为空/上报异常，应整体采纳 upserts 为全量目录 */
  full: boolean
  /** projects 非空 = 全量项目表（projectsRev 变化时整表重发，手机整表替换，覆盖增/删/改） */
  upserts: { projects: ProjectRecord[]; sessions: CatalogSessionMeta[] }
  deletes: { sessions: string[] }
  activeSessionId: string | null
}

export function diffCatalog(known: KnownCatalogState | null | undefined, catalog: SessionCatalog): CatalogDiff {
  // 手机为空/异常 → 全量
  if (!known || typeof known !== 'object' || !known.sessions || typeof known.sessions !== 'object') {
    return {
      full: true,
      upserts: { projects: catalog.projects, sessions: catalog.sessions },
      deletes: { sessions: [] },
      activeSessionId: catalog.activeSessionId,
    }
  }
  const knownSessions = known.sessions
  const byId = new Map(catalog.sessions.map(s => [s.id, s]))
  const upsertSessions = catalog.sessions.filter(s => knownSessions[s.id] !== s.updatedAt)
  const deleteSessions = Object.keys(knownSessions).filter(id => !byId.has(id))
  // 项目：projectsRev 不一致 → 整表重发（项目极少，删除/改名/清归属均由此收敛）
  const projectsChanged = known.projectsRev !== catalog.projectsRev
  return {
    full: false,
    upserts: {
      projects: projectsChanged ? catalog.projects : [],
      sessions: upsertSessions,
    },
    deletes: { sessions: deleteSessions },
    activeSessionId: catalog.activeSessionId,
  }
}

// ==================== 历史分页（history） ====================

/** 页大小上限（协议：min(20 条, ~32KB)） */
export const HISTORY_PAGE_LIMIT = 20
/** 单页序列化字节预算（约 32KB） */
export const HISTORY_PAGE_BYTE_BUDGET = 32 * 1024
/** 工具结果预览字符上限（手机端展开详情可读；4000 字符中文约 12KB，安全落在 32KB 页预算与 45KB 信封预算内） */
export const TOOL_RESULT_PREVIEW_CHARS = 4000
/** 媒体占位/截断标注文案（沿用信封截断"请在桌面查看"先例） */
export const MEDIA_PLACEHOLDER = '请在桌面查看'

/** 历史页（线形 = HistoryPageBody） */
export type HistoryPage = HistoryPageBody

export interface PageHistoryDeps {
  /** SessionPersistence.load 的适配闭包：null = 会话不存在 */
  loadSession: (sessionId: string) => Promise<SessionRecord | null>
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
function byteLen(s: string): number {
  return textEncoder.encode(s).length
}

/** 按字节预算截断（回退到合法 UTF-8 边界；与 envelope.truncateToBudget 同一手法规避半个字符） */
function truncateBytes(text: string, budget: number): string {
  const bytes = textEncoder.encode(text)
  if (bytes.length <= budget) return text
  let end = budget
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return textDecoder.decode(bytes.slice(0, end))
}

function isoOf(t: unknown): string {
  const time = t instanceof Date ? t.getTime() : new Date(t as string | number).getTime()
  return Number.isNaN(time) ? String(t ?? '') : new Date(time).toISOString()
}

function msOf(t: unknown): number {
  const time = t instanceof Date ? t.getTime() : new Date(t as string | number).getTime()
  return Number.isNaN(time) ? 0 : time
}

/** 工具名解析：contentBlocks 的 TOOL_CALL 块优先，否则回溯 assistant 消息的 toolCalls */
function resolveToolName(m: Message, all: Message[]): string | undefined {
  const block = m.contentBlocks?.find(
    b => b.type === ContentBlockType.TOOL_CALL && b.toolCallId === m.toolCallId
  )
  if (block && block.type === ContentBlockType.TOOL_CALL) return block.toolName
  for (let i = all.length - 1; i >= 0; i--) {
    const tc = all[i]!.toolCalls?.find(t => t.id === m.toolCallId)
    if (tc) return tc.function.name
  }
  return undefined
}

/** core Message → 传输形态（类型映射单一事实点，手机渲染规则以此为准） */
export function toSyncMessage(m: Message, all: Message[]): SyncMessage {
  const base = {
    msgKey: messageKey(m),
    role: m.role as string,
    ts: isoOf(m.timestamp),
    ...(m.clientId ? { clientId: m.clientId } : {}),
  }
  // synthetic 合成消息 → 提示行
  if (m.synthetic) {
    return { ...base, kind: 'notice', text: textOf(m.content) }
  }
  // 媒体检测（三通道或，file.* 协议族修正既有隐性缺陷）：
  // ① contentBlocks 含图/视频/音频（工具消息媒体块，如 capture_screen）
  // ② attachmentRefs（手机附件消息——file.* 回填键）
  // ③ content 为 ContentPart[] 且含媒体块（用户消息媒体——桌面 @提及 的媒体在 content 字段里，
  //    旧判据只查 contentBlocks 导致这类消息在手机上连占位都不显示）
  const hasMedia =
    m.contentBlocks?.some(b =>
      b.type === ContentBlockType.IMAGE || b.type === ContentBlockType.VIDEO || b.type === ContentBlockType.AUDIO
    ) ||
    (m.attachmentRefs !== undefined && m.attachmentRefs.length > 0) ||
    (Array.isArray(m.content) &&
      m.content.some(p => p?.type === 'image_url' || p?.type === 'video_url' || p?.type === 'input_audio'))
  if (hasMedia) {
    // refs 回填（additive）：手机传输 fileId + name/mime——手机查本地登记表渲染缩略图/芯片
    const refs = m.attachmentRefs?.map(r => ({ ref: r.ref, name: r.name, mime: r.mime }))
    // 用户文字保留（第一性定案：协议忠实携带语义，渲染器如实显示）：
    // role=user 时提取 ContentPart[] 的 text 块（桌面 @提及 的用户文字同样保留）；
    // 无文字或非用户消息（工具截图等）→ 占位（为桌面侧媒体设计的语义）
    const userText = m.role === MessageRole.USER
      ? (Array.isArray(m.content)
          ? (m.content as Array<{ type: string; text?: string }>)
              .filter(p => p?.type === 'text' && typeof p.text === 'string')
              .map(p => p.text)
              .join(' ')
              .trim()
          : typeof m.content === 'string' ? m.content.trim() : '')
      : ''
    const text = userText.length > 0 ? userText.slice(0, 2000) : MEDIA_PLACEHOLDER
    return { ...base, kind: 'media', text, ...(refs && refs.length > 0 ? { refs } : {}) }
  }
  // 工具消息 → 工具行精简载荷（工具名 + 状态 + ≤1000 字符结果预览）
  if (m.role === MessageRole.TOOL) {
    const full = textOf(m.content)
    const over = full.length > TOOL_RESULT_PREVIEW_CHARS
    return {
      ...base,
      kind: 'tool',
      text: over ? full.slice(0, TOOL_RESULT_PREVIEW_CHARS) : full,
      toolName: resolveToolName(m, all),
      toolStatus: m.toolCallStatus as string | undefined,
      truncated: over || undefined,
    }
  }
  // 普通 user/assistant/system → 正文
  return {
    ...base,
    kind: 'text',
    text: textOf(m.content),
    reasoningContent: m.reasoningContent,
    thinkingDurationMs: m.thinkingDurationMs,
  }
}

/**
 * 游标分页（倒序翻页）：before = 手机已持有的最早 msgKey，返回比它更早的一页。
 * before 缺省/在会话中找不到（锚点被压缩或再生抹掉）→ 回退为最新一页
 * （手机按 msgKey 幂等归并，重投无害；真正的历史发散由 history.invalidated 通道收敛）。
 * 页大小 = min(limit 条, ~32KB 序列化预算)；单条超预算时截断正文并标 truncated。
 */
export async function pageHistory(
  deps: PageHistoryDeps,
  sessionId: string,
  before?: string,
  limit?: number,
): Promise<HistoryPage> {
  const record = await deps.loadSession(sessionId)
  if (!record) {
    return { sessionId, messages: [], done: true, notFound: true }
  }
  const pageLimit = Math.max(1, Math.min(limit ?? HISTORY_PAGE_LIMIT, HISTORY_PAGE_LIMIT))
  // 盘上记录经 merge 已按 timestamp 升序；防御性再排一次（稳定排序，同键保持原序）
  const msgs = (Array.isArray(record.messages) ? record.messages.slice() : []).sort(
    (a, b) => msOf(a.timestamp) - msOf(b.timestamp)
  )
  if (msgs.length === 0) {
    return { sessionId, messages: [], done: true }
  }
  const keys = msgs.map(m => messageKey(m))
  let end = msgs.length
  if (before !== undefined) {
    const idx = keys.indexOf(before)
    if (idx >= 0) end = idx
  }
  // 从 end 向过去累计，条数与字节双闸门
  const picked: SyncMessage[] = []
  let bytes = 0
  let start = end
  for (let i = end - 1; i >= 0 && picked.length < pageLimit; i--) {
    const sm = toSyncMessage(msgs[i]!, msgs)
    // 零载荷 assistant 行不上线（空正文/无思考——纯工具调用轮的占位消息；工具行已承载全部可显示信息，
    // 对手机是纯噪声：渲染为空壳制造幻影间距）。kind 判定复用 toSyncMessage 单一事实点（media/tool/notice 均不误伤）；
    // 跳过不占条数/字节预算；start 照常推进（位置已被消费——否则页首恰为空行时 done 永假、nextBefore 不变，手机会原地死循环拉页）；user 消息永不跳过
    if (msgs[i]!.role === MessageRole.ASSISTANT && sm.kind === 'text' && sm.text.trim() === '' && !sm.reasoningContent) { start = i; continue }
    const size = byteLen(JSON.stringify(sm))
    if (picked.length > 0 && bytes + size > HISTORY_PAGE_BYTE_BUDGET) break
    if (picked.length === 0 && size > HISTORY_PAGE_BYTE_BUDGET) {
      // 单条超预算：正文优先，思考内容让位；截断并标 truncated（手机标注"请在桌面查看"）
      const overhead = byteLen(JSON.stringify({ ...sm, text: '', reasoningContent: '' }))
      const avail = Math.max(0, HISTORY_PAGE_BYTE_BUDGET - overhead)
      if (byteLen(sm.text) > avail) {
        sm.text = truncateBytes(sm.text, avail)
        sm.reasoningContent = undefined
      } else if (sm.reasoningContent) {
        const rAvail = avail - byteLen(sm.text)
        if (byteLen(sm.reasoningContent) > rAvail) {
          sm.reasoningContent = truncateBytes(sm.reasoningContent, rAvail)
        }
      }
      sm.truncated = true
      bytes += byteLen(JSON.stringify(sm))
    } else {
      bytes += size
    }
    picked.push(sm)
    start = i
  }
  picked.reverse()
  const done = start === 0
  return {
    sessionId,
    messages: picked,
    nextBefore: done ? undefined : keys[start],
    done,
  }
}


// ==================== 目录元数据增量（session.event 数据源） ====================

/** 相邻两次目录快照的元数据差异（wiring 目录监听 → session.event 的映射数据源；纯逻辑可单测） */
export interface CatalogMetaDiff {
  /** 新出现的会话（→ session.created） */
  created: CatalogSessionMeta[]
  /** 消失的会话 id（→ session.deleted） */
  deleted: string[]
  /** 标题/标题来源变化（→ title.changed；改名不动 updatedAt，必须独立比对） */
  titleChanged: CatalogSessionMeta[]
  /** 其余元数据变化（updatedAt/preview/projectId/workdir → metadata.upsert，携带整行） */
  upserted: CatalogSessionMeta[]
}

/**
 * 目录快照 diff：以 id 对齐前后两期 sessions 元数据。
 * title 变化与其他字段变化独立判定（可同时命中：改名 + 新消息并发时两路各发一条，手机幂等收敛）。
 */
export function diffCatalogMeta(
  prev: ReadonlyMap<string, CatalogSessionMeta>,
  next: readonly CatalogSessionMeta[],
): CatalogMetaDiff {
  const diff: CatalogMetaDiff = { created: [], deleted: [], titleChanged: [], upserted: [] }
  const nextIds = new Set<string>()
  for (const s of next) {
    nextIds.add(s.id)
    const p = prev.get(s.id)
    if (!p) {
      diff.created.push(s)
      continue
    }
    if (p.title !== s.title || p.titleSource !== s.titleSource) diff.titleChanged.push(s)
    if (
      p.updatedAt !== s.updatedAt || p.preview !== s.preview ||
      p.projectId !== s.projectId || p.workdir !== s.workdir
    ) {
      diff.upserted.push(s)
    }
  }
  for (const id of prev.keys()) {
    if (!nextIds.has(id)) diff.deleted.push(id)
  }
  return diff
}
