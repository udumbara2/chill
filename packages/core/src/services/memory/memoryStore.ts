import * as path from 'path'
import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../../interfaces/IPathProvider'

/**
 * 长期记忆存储（~/.chill/memory/，纯 Markdown，无第三方依赖）
 *
 * 布局：MEMORY.md 索引（人类可读正本）+ 主题文件 <type>_<slug>.md（frontmatter 元数据）。
 * 四类记忆：user（偏好/习惯）、feedback（纠正/确认的工作方式）、project（不可从代码推导的项目事实）、reference（外部指针）。
 *
 * per-agent 命名空间：getScoped(rootDir) 产出共享同一引擎、根目录不同的实例
 * （agent 模板声明 memory: user|project|local 后的私域存储；解析见 resolveAgentMemoryDir）。
 * pending/蒸馏/审批仅全局实例使用。
 *
 * 软衰减不删除：buildIndexInjection 按 score = recency衰减 × importance × 使用频率 排序注入，
 * 记忆永不自动删除；索引超上限由调用方（模型）精简。usage 仅"深读主题文件"（touch）时累计。
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference']

export interface MemoryEntry {
  file: string
  filePath: string
  name: string
  type: MemoryType
  created_at: string
  updated_at: string
  last_used_at: string
  usage_count: number
  importance: number
  source_session?: string
  hook: string
  body: string
}

export interface SaveMemoryParams {
  type: MemoryType
  title: string
  content: string
  importance?: number
  sourceSession?: string
}

export interface SaveMemoryResult {
  success: boolean
  action?: 'created' | 'updated'
  file?: string
  warning?: string
  error?: string
}

/** 待确认记忆候选（蒸馏产物，经用户审批后入库） */
export interface PendingCandidate {
  type: MemoryType
  title: string
  content: string
  importance?: number
}

/** 一批待确认候选（一次蒸馏的结果） */
export interface PendingBatch {
  createdAt: string
  sourceSessionId: string
  candidates: PendingCandidate[]
}

/** 蒸馏水位（按 sessionId 记录已蒸馏到的消息时间戳 ms；旧格式 {sessionId, updatedAt} 视为无水位） */
export interface DistillState {
  watermarks: Record<string, number>
}

/** 衰减常量：每小时保留率（0.999 ≈ 半衰期 29 天；Park et al. 2023 用 0.995，角色扮演场景衰减更快） */
const RECENCY_RATE_PER_HOUR = 0.999
/** 索引注入上限（对齐 Claude Code MEMORY.md 上限） */
const MAX_INDEX_LINES = 200
const MAX_INDEX_CHARS = 25 * 1024

/** 标题归一（裁决日志/pending 去重/蒸馏排除共用的唯一键规则：小写 + trim） */
export function normalizeTitle(title: string): string {
  return (title ?? '').trim().toLowerCase()
}

function slugify(title: string): string {  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'memory'
}

function clampImportance(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 5
  return Math.min(10, Math.max(1, v))
}

/** 计算衰减分：recency × importance × 频率加成（导出供 CLI /memory 列表排序复用） */
export function memoryDecayScore(e: MemoryEntry, now: number = Date.now()): number {
  const hours = Math.max(0, (now - new Date(e.last_used_at).getTime()) / 3600000)
  const recency = Math.pow(RECENCY_RATE_PER_HOUR, hours)
  const freq = 1 + Math.log(1 + (e.usage_count || 0))
  return recency * e.importance * freq
}

/** 计算衰减分：recency × importance × 频率加成 */
function decayScore(e: MemoryEntry, now: number): number {
  return memoryDecayScore(e, now)
}

function serializeFrontmatter(e: Omit<MemoryEntry, 'file' | 'filePath' | 'hook' | 'body'>): string {
  const lines = [
    `name: ${e.name}`,
    `type: ${e.type}`,
    `created_at: ${e.created_at}`,
    `updated_at: ${e.updated_at}`,
    `last_used_at: ${e.last_used_at}`,
    `usage_count: ${e.usage_count}`,
    `importance: ${e.importance}`,
  ]
  if (e.source_session) lines.push(`source_session: ${e.source_session}`)
  return `---\n${lines.join('\n')}\n---\n\n`
}

function parseMemoryFile(file: string, filePath: string, raw: string): MemoryEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  const body = raw.slice(m[0].length).trim()
  const firstLine = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? ''
  const type = (MEMORY_TYPES as string[]).includes(meta.type) ? (meta.type as MemoryType) : 'user'
  return {
    file,
    filePath,
    name: meta.name || file.replace(/\.md$/, ''),
    type,
    created_at: meta.created_at || '',
    updated_at: meta.updated_at || '',
    last_used_at: meta.last_used_at || meta.updated_at || meta.created_at || '',
    usage_count: Number(meta.usage_count) || 0,
    importance: clampImportance(Number(meta.importance)),
    source_session: meta.source_session || undefined,
    hook: firstLine.slice(0, 80),
    body,
  }
}

export class MemoryStore {
  private static instance: MemoryStore
  /** per-agent 命名空间实例缓存（rootDir → 实例；与全局单例共享 provider） */
  private static scopedInstances = new Map<string, MemoryStore>()
  private fsProvider: IFileSystemProvider | null = null
  private pathProvider: IPathProvider | null = null
  /** scoped 实例的根目录覆盖（null = 全局默认 ~/.chill/memory） */
  private rootDirOverride: string | null = null

  private constructor(rootDirOverride: string | null = null) {
    this.rootDirOverride = rootDirOverride
  }

  static getInstance(): MemoryStore {
    if (!MemoryStore.instance) MemoryStore.instance = new MemoryStore()
    return MemoryStore.instance
  }

  /**
   * 获取指定根目录的 scoped 实例（per-agent 记忆命名空间；命名空间实现——
   * 同一存储引擎参数化根目录，不新建机制）。与全局单例共享 provider；
   * 全局未初始化时 scoped 同样未就绪，调用方按未就绪降级处理。
   */
  static getScoped(rootDir: string): MemoryStore {
    const cached = MemoryStore.scopedInstances.get(rootDir)
    if (cached) return cached
    const inst = new MemoryStore(rootDir)
    const global = MemoryStore.getInstance()
    if (global.isReady()) inst.init(global.fsProvider!, global.pathProvider!)
    MemoryStore.scopedInstances.set(rootDir, inst)
    return inst
  }

  /** 注入平台实现：CLI 注 Node provider，UI 注 Electron IPC provider */
  init(fsProvider: IFileSystemProvider, pathProvider: IPathProvider): void {
    this.fsProvider = fsProvider
    this.pathProvider = pathProvider
    // 全局实例初始化时同步补齐已创建的 scoped 实例（scoped 自身 init 不再传播）
    if (!this.rootDirOverride) {
      for (const inst of MemoryStore.scopedInstances.values()) {
        if (!inst.isReady()) {
          inst.fsProvider = fsProvider
          inst.pathProvider = pathProvider
        }
      }
    }
  }

  isReady(): boolean {
    return this.fsProvider !== null && this.pathProvider !== null
  }

  memoryDir(): string {
    if (!this.rootDirOverride && !this.pathProvider) throw new Error('MemoryStore 未初始化（缺 pathProvider）')
    return this.rootDirOverride ?? path.join(this.pathProvider!.getUserDataPath(), 'memory')
  }

  isMemoryPath(filePath: string): boolean {
    try {
      // 统一分隔符与大小写再比较（Windows 下调用方可能传入混合分隔符路径）
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/*$/, '')
      const dir = norm(this.memoryDir()) + '/'
      const f = norm(filePath)
      return f.startsWith(dir) && f.endsWith('.md') && !f.endsWith('/memory.md')
    } catch {
      return false
    }
  }

  /** 读取全部记忆条目（目录不存在/为空返回 []） */
  async list(): Promise<MemoryEntry[]> {
    if (!this.isReady()) return []
    const dir = this.memoryDir()
    const result = await this.fsProvider!.listDirectory(dir)
    if (!result.success) return []
    const files: Array<{ name: string; type: string }> = result.data?.files ?? result.data?.data?.files ?? []
    const entries: MemoryEntry[] = []
    for (const f of files) {
      if (f.type !== 'file' || !f.name.endsWith('.md') || f.name === 'MEMORY.md') continue
      const filePath = path.join(dir, f.name)
      const read = await this.fsProvider!.readFile(filePath)
      if (!read.success) continue
      const raw: string = read.data?.content ?? read.data ?? ''
      const entry = parseMemoryFile(f.name, filePath, typeof raw === 'string' ? raw : String(raw))
      if (entry) entries.push(entry)
    }
    return entries
  }

  /** 新增或更新（标题相同不区分大小写 → 更新旧条目，写时对账轻量版） */
  async save(params: SaveMemoryParams): Promise<SaveMemoryResult> {
    if (!this.isReady()) return { success: false, error: 'MemoryStore 未初始化' }
    const now = new Date().toISOString()
    const entries = await this.list()
    const existing = entries.find(e => e.name.toLowerCase() === params.title.toLowerCase())

    const meta = {
      name: params.title,
      type: params.type,
      created_at: existing?.created_at || now,
      updated_at: now,
      last_used_at: now,
      usage_count: existing?.usage_count ?? 0,
      importance: clampImportance(params.importance ?? existing?.importance),
      source_session: params.sourceSession ?? existing?.source_session,
    }
    const file = existing?.file ?? `${params.type}_${slugify(params.title)}.md`
    const write = await this.fsProvider!.writeFile(
      path.join(this.memoryDir(), file),
      serializeFrontmatter(meta) + params.content.trim() + '\n'
    )
    if (!write.success) return { success: false, error: write.error || '写入记忆文件失败' }

    const warning = await this.rewriteIndex()
    return { success: true, action: existing ? 'updated' : 'created', file, warning }
  }

  async remove(title: string): Promise<{ success: boolean; error?: string }> {
    if (!this.isReady()) return { success: false, error: 'MemoryStore 未初始化' }
    const entries = await this.list()
    const target = entries.find(e => e.name.toLowerCase() === title.toLowerCase())
    if (!target) return { success: false, error: `未找到记忆: ${title}` }
    const del = await this.fsProvider!.deleteFile(target.filePath)
    if (!del.success) return { success: false, error: del.error || '删除失败' }
    await this.rewriteIndex()
    return { success: true }
  }

  /** 深读主题文件时累计使用（usage_count+1、刷新 last_used_at）；fire-and-forget */
  async touch(filePath: string): Promise<void> {
    try {
      if (!this.isReady() || !this.isMemoryPath(filePath)) return
      const read = await this.fsProvider!.readFile(filePath)
      if (!read.success) return
      const raw: string = read.data?.content ?? read.data ?? ''
      const entry = parseMemoryFile(path.basename(filePath), filePath, typeof raw === 'string' ? raw : String(raw))
      if (!entry) return
      entry.usage_count += 1
      entry.last_used_at = new Date().toISOString()
      await this.fsProvider!.writeFile(
        filePath,
        serializeFrontmatter(entry) + entry.body + '\n'
      )
    } catch { /* touch 失败不影响主流程 */ }
  }

  // ==================== 待确认区（二期：自动蒸馏 + 审批） ====================

  private pendingDir(): string {
    return path.join(this.memoryDir(), '.pending')
  }

  private distillStateFile(): string {
    return path.join(this.memoryDir(), '.distill-state.json')
  }

  async readDistillState(): Promise<DistillState | null> {
    if (!this.isReady()) return null
    try {
      const read = await this.fsProvider!.readFile(this.distillStateFile())
      if (!read.success) return null
      const raw: string = read.data?.content ?? read.data ?? ''
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      // 旧格式 {sessionId, updatedAt} 或其他损坏结构 → 视为无水位
      if (!parsed || typeof parsed !== 'object' || typeof parsed.watermarks !== 'object' || parsed.watermarks === null) {
        return { watermarks: {} }
      }
      return parsed as DistillState
    } catch {
      return null
    }
  }

  async writeDistillState(state: DistillState): Promise<void> {
    if (!this.isReady()) return
    try {
      await this.fsProvider!.writeFile(this.distillStateFile(), JSON.stringify(state, null, 2))
    } catch { /* 静默 */ }
  }

  /** 写一批待确认候选；标题已在 pending 或已在裁决日志的直接丢弃（写时幂等去重），全部被丢弃则不创建文件。返回文件名或 null */
  async writePending(batch: PendingBatch): Promise<string | null> {
    if (!this.isReady()) return null
    const existingTitles = new Set<string>()
    for (const b of await this.listPending()) {
      for (const c of b.candidates) existingTitles.add(normalizeTitle(c.title))
    }
    const reviewed = await this.readReviewed()
    const candidates = batch.candidates.filter(c => {
      const key = normalizeTitle(c.title)
      return !existingTitles.has(key) && !(key in reviewed)
    })
    if (candidates.length === 0) return null
    const file = `${Date.now()}.json`
    await this.fsProvider!.writeFile(
      path.join(this.pendingDir(), file),
      JSON.stringify({ ...batch, candidates }, null, 2)
    )
    return file
  }

  /** 读取全部待确认批次（按时间升序；损坏文件跳过） */
  async listPending(): Promise<PendingBatch[]> {
    if (!this.isReady()) return []
    const result = await this.fsProvider!.listDirectory(this.pendingDir())
    if (!result.success) return []
    const files: Array<{ name: string; type: string }> = result.data?.files ?? result.data?.data?.files ?? []
    const batches: PendingBatch[] = []
    for (const f of files) {
      if (f.type !== 'file' || !f.name.endsWith('.json')) continue
      const read = await this.fsProvider!.readFile(path.join(this.pendingDir(), f.name))
      if (!read.success) continue
      try {
        const raw: string = read.data?.content ?? read.data ?? ''
        const batch = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as PendingBatch
        if (Array.isArray(batch?.candidates) && batch.candidates.length > 0) batches.push(batch)
      } catch { /* 跳过损坏文件 */ }
    }
    return batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** 清空全部待确认文件 */
  async clearPending(): Promise<void> {
    if (!this.isReady()) return
    const result = await this.fsProvider!.listDirectory(this.pendingDir())
    if (!result.success) return
    const files: Array<{ name: string; type: string }> = result.data?.files ?? result.data?.data?.files ?? []
    for (const f of files) {
      if (f.type !== 'file' || !f.name.endsWith('.json')) continue
      await this.fsProvider!.deleteFile(path.join(this.pendingDir(), f.name)).catch(() => {})
    }
  }

  // ==================== 裁决日志（~/.chill/memory/.reviewed.json） ====================

  private reviewedFile(): string {
    return path.join(this.memoryDir(), '.reviewed.json')
  }

  /** 读取裁决日志（标题归一键 → 裁决记录）；不存在返回 {} */
  async readReviewed(): Promise<Record<string, { verdict: 'approved' | 'rejected'; at: string }>> {
    if (!this.isReady()) return {}
    try {
      const read = await this.fsProvider!.readFile(this.reviewedFile())
      if (!read.success) return {}
      const raw: string = read.data?.content ?? read.data ?? ''
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * 写入裁决（读-合并-写 + first-decision-wins：已存在键跳过不覆写，
   * 首次裁决永久有效，批量操作不得翻转历史 approved；并发写下尽量保住双方新增键）。
   */
  async writeReviewed(entries: Record<string, { verdict: 'approved' | 'rejected'; at: string }>): Promise<boolean> {
    if (!this.isReady()) return false
    try {
      const existing = await this.readReviewed()
      for (const [key, value] of Object.entries(entries)) {
        if (!(key in existing)) existing[key] = value
      }
      await this.fsProvider!.writeFile(this.reviewedFile(), JSON.stringify(existing, null, 2))
      return true
    } catch {
      return false
    }
  }

  /** 读取待确认批次并剔除已裁决标题（notice 与 review 列表共用的显示过滤） */
  async listPendingFiltered(): Promise<PendingBatch[]> {
    const reviewed = await this.readReviewed()
    const batches = await this.listPending()
    const out: PendingBatch[] = []
    for (const batch of batches) {
      const candidates = batch.candidates.filter(c => !(normalizeTitle(c.title) in reviewed))
      if (candidates.length > 0) out.push({ ...batch, candidates })
    }
    return out
  }

  /**
   * 生成"待确认记忆"注入提示（过滤后无剩余返回 null）。
   * exitHint 按端传入（CLI 可传 /memory review 提示；UI 不传——共享函数不内置端专属命令文案）。
   */
  async buildPendingNotice(exitHint?: string): Promise<string | null> {
    const batches = await this.listPendingFiltered()
    if (batches.length === 0) return null
    const lines: string[] = [
      '【待确认记忆——需要优先处理】系统已从最近的会话中自动提炼出候选长期记忆（尚未生效，等待用户确认）。',
      '在本次回复中，请先用一两句话向用户汇报以下候选并征得同意（此项优先于回答用户的其他问题）：',
      '',
    ]
    let n = 0
    for (const batch of batches) {
      for (const c of batch.candidates) {
        n++
        if (n > 10) break
        lines.push(`${n}. [${c.type}] ${c.title} — ${c.content.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
      if (n > 10) break
    }
    if (n === 0) return null
    lines.push('')
    lines.push('用户表态后（全部保存/部分保存/全部拒绝），调用 review_pending_memories 工具：approved_titles 填入用户同意保存的标题（全部拒绝则传空数组）。')
    lines.push('在用户明确表态之前，不要自行将这些内容写入长期记忆，也不要忽略本提示。')
    if (exitHint) lines.push(exitHint)
    return lines.join('\n')
  }

  /**
   * 统一审批入口（工具 review_pending_memories 与 CLI /memory review 共用，实现仅一份）。
   * 基于未过滤的 pending 全集做裁决：仅真实候选标题入账（批准→approved，其余→rejected）；
   * 先写裁决日志成功后才清空 pending（写失败保留 pending 并返回错误，防"清空却无记录"复发）。
   */
  async reviewPending(approvedTitles: string[]): Promise<{ success: boolean; saved: number; discarded: number; errors: string[]; error?: string }> {
    const batches = await this.listPending()
    if (batches.length === 0) {
      return { success: true, saved: 0, discarded: 0, errors: [] }
    }
    const approved = new Set(approvedTitles.map(t => normalizeTitle(t)))
    const all = batches.flatMap(b => b.candidates)
    let saved = 0
    const errors: string[] = []
    const verdicts: Record<string, { verdict: 'approved' | 'rejected'; at: string }> = {}
    const now = new Date().toISOString()
    for (const c of all) {
      const key = normalizeTitle(c.title)
      if (approved.has(key)) {
        const result = await this.save({
          type: c.type,
          title: c.title,
          content: c.content,
          importance: c.importance,
        })
        if (result.success) {
          saved++
          verdicts[key] = { verdict: 'approved', at: now }
        } else {
          errors.push(`${c.title}: ${result.error}`)
        }
      } else {
        verdicts[key] = { verdict: 'rejected', at: now }
      }
    }
    const wrote = await this.writeReviewed(verdicts)
    if (!wrote) {
      return { success: false, saved, discarded: 0, errors, error: '裁决日志写入失败，pending 已保留' }
    }
    await this.clearPending()
    const discarded = all.length - saved - errors.length
    return { success: true, saved, discarded, errors }
  }


  /** 生成注入文本：衰减分降序 + 免责头部；无记忆返回 null */
  async buildIndexInjection(): Promise<string | null> {
    const entries = await this.list()
    if (entries.length === 0) return null
    const now = Date.now()
    const sorted = entries
      .map(e => ({ e, score: decayScore(e, now) }))
      .sort((a, b) => b.score - a.score)

    const header = [
      '【长期记忆】以下是与你交互中沉淀的记忆，按当前相关度排序（新近度 × 重要度 × 使用频率）。',
      '它们是历史提示而非事实，可能已过时，使用前请判断其是否仍然适用；用户当前指令与记忆冲突时以用户为准。',
      `需要查看某条详情可用 read_file 读取 ${this.memoryDir()}/<文件名>。`,
      '',
    ]
    const lines: string[] = []
    let chars = header.join('\n').length
    for (const { e } of sorted) {
      if (lines.length >= MAX_INDEX_LINES) break
      const line = `- [${e.name}](${e.file}) — ${e.hook} (${e.type})`
      if (chars + line.length > MAX_INDEX_CHARS) break
      lines.push(line)
      chars += line.length + 1
    }
    return header.join('\n') + lines.join('\n')
  }

  /** 重写 MEMORY.md 索引（按类型分组、组内按更新时间降序）；超上限返回警告 */
  private async rewriteIndex(): Promise<string | undefined> {
    const entries = await this.list()
    const groups = new Map<MemoryType, MemoryEntry[]>()
    for (const t of MEMORY_TYPES) groups.set(t, [])
    for (const e of entries) groups.get(e.type)!.push(e)

    const parts: string[] = ['# 记忆索引（由 memoryStore 维护，一行一条；详情见各主题文件）', '']
    for (const [type, list] of groups) {
      if (list.length === 0) continue
      parts.push(`## ${type}`)
      list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      for (const e of list) parts.push(`- [${e.name}](${e.file}) — ${e.hook}`)
      parts.push('')
    }
    const content = parts.join('\n')
    const write = await this.fsProvider!.writeFile(path.join(this.memoryDir(), 'MEMORY.md'), content)
    if (!write.success) return undefined

    const lineCount = content.split('\n').length
    if (lineCount > MAX_INDEX_LINES || content.length > MAX_INDEX_CHARS) {
      return `索引已超上限（${lineCount} 行 / ${content.length} 字符，上限 ${MAX_INDEX_LINES} 行 / ${MAX_INDEX_CHARS} 字符），请合并或删除部分记忆`
    }
    return undefined
  }

  // ==================== per-agent 记忆命名空间（三作用域） ====================

  /**
   * 解析 agent 记忆目录（解析收在 store 内：userDataPath 经自身 pathProvider 取，调用方均不持有）。
   * user → ~/.chill/agent-memory/<type>；
   * project/local → <项目根>/.agents/agent-memory[-local]/<type>，
   *   项目根从 workDir 向上递归定位 .agents/ 根（同构 SkillLoader 递归发现），找不到回退 workDir 本身；
   * workDir 缺省 → 回退 user 作用域。
   */
  async resolveAgentMemoryDir(
    scope: 'user' | 'project' | 'local',
    subagentType: string,
    workDir?: string
  ): Promise<string> {
    if (!this.pathProvider) throw new Error('MemoryStore 未初始化（缺 pathProvider）')
    if (scope === 'project' || scope === 'local') {
      const base = scope === 'project' ? 'agent-memory' : 'agent-memory-local'
      if (workDir) {
        const root = (await this.findAgentsRoot(workDir)) ?? workDir
        return path.join(root, '.agents', base, subagentType)
      }
      // workDir 缺省：回退 user 作用域（与下方一致）
    }
    return path.join(this.pathProvider.getUserDataPath(), 'agent-memory', subagentType)
  }

  /** 从 workDir 向上递归定位最近的 .agents/ 根；找不到返回 null（同构 SkillLoader.scanProjectLevels） */
  private async findAgentsRoot(workDir: string): Promise<string | null> {
    if (!this.fsProvider) return null
    let current = path.resolve(workDir)
    for (;;) {
      try {
        const r = await this.fsProvider.fileExists(path.join(current, '.agents'))
        if (r?.success && r.data === true) return current
      } catch { /* 继续向上 */ }
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }

  /**
   * per-agent 空间索引注入（facade 方法：解析 + scoped 读取收在 store 内，
   * ContextAssembler 经 MemoryStoreFacade 调用，renderer 安全边界不破坏）。任何失败返回 null（注入器跳过）。
   */
  async buildAgentIndexInjection(
    scope: 'user' | 'project' | 'local',
    subagentType: string,
    workDir?: string
  ): Promise<string | null> {
    try {
      const dir = await this.resolveAgentMemoryDir(scope, subagentType, workDir)
      return await MemoryStore.getScoped(dir).buildIndexInjection()
    } catch {
      return null
    }
  }
}

export const memoryStore = MemoryStore.getInstance()
