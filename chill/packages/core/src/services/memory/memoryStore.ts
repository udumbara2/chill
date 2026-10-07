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
 *
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

/** 衰减常量：每小时保留率（0.999 ≈ 半衰期 29 天；Park et al. 2023 用 0.995，角色扮演场景衰减更快） */
const RECENCY_RATE_PER_HOUR = 0.999
/** 索引注入上限（对齐 Claude Code MEMORY.md 上限） */
const MAX_INDEX_LINES = 200
const MAX_INDEX_CHARS = 25 * 1024

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
    void this.refreshNewCount() // 启动即预热"新记忆"计数（cmd.state 快照同步读口；仅全局实例有水位语义）
    // 全局实例初始化时同步补齐已创建的 scoped 实例（scoped 自身 init 不再传播）    this.fsProvider = fsProvider
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

  private newCountCache: number | undefined

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
    void this.refreshNewCount()
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
    void this.refreshNewCount()
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


  // ==================== 巡检水位与"新记忆"计数（事后治理：面板巡检，非对话审批） ====================

  private seenAtFile(): string {
    return path.join(this.memoryDir(), '.seen-at.json')
  }

  /** 读取巡检水位（ISO 时间戳；无文件返回 null=从未巡检，全部视为新） */
  async readSeenAt(): Promise<string | null> {
    if (!this.isReady()) return null
    try {
      const read = await this.fsProvider!.readFile(this.seenAtFile())
      if (!read.success) return null
      const raw: string = read.data?.content ?? read.data ?? ''
      const parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      return typeof parsed?.seenAt === 'string' ? parsed.seenAt : null
    } catch {
      return null
    }
  }

  /** 巡检水位上报（MemorySheet 打开即调；手机目录行"新 N"随之归零） */
  async writeSeenAt(ts: string): Promise<void> {
    if (!this.isReady()) return
    try {
      await this.fsProvider!.writeFile(this.seenAtFile(), JSON.stringify({ seenAt: ts }))
      void this.refreshNewCount()
    } catch { /* 静默 */ }
  }

  /** 判新单源：updated_at 晚于水位即为"新"（save 更新旧条目也算新变化）；newCount 与 memory.list 投影共用 */
  isNewerEntry(e: MemoryEntry, seenAt: string | null): boolean {
    return seenAt === null || e.updated_at > seenAt
  }

  /** newCount 同步读口（cmd.state 快照同步契约；未算过=undefined → 快照字段缺省=未装配语义） */
  getNewCount(): number | undefined {
    return this.newCountCache
  }

  /** 异步重算（init 后与 save/remove/writeSeenAt 后触发；失败保留旧值） */
  async refreshNewCount(): Promise<void> {
    if (!this.isReady()) return
    try {
      const [entries, seenAt] = await Promise.all([this.list(), this.readSeenAt()])
      this.newCountCache = entries.filter(e => this.isNewerEntry(e, seenAt)).length
    } catch { /* 保留旧值 */ }
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
