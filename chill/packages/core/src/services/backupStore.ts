/**
 * 文件备份存储（写前 pre-image 快照 + 归因 + 保留策略 + 恢复）
 *
 * 布局：<rootDir>/<pathKey>/<ts>（快照文件）+ <pathKey>/index.jsonl（逐行一条索引记录）
 *      + <rootDir>/.sessions/<sessionId>.jsonl（会话维度二级索引，轮次/任务级聚合恢复的数据源）。
 * pathKey = FNV-1a(12 hex，normalizeForKey 端无关归一后的路径) + 清洗后 basename 前缀
 * （可读性 + 避开 Windows 非法字符/长路径；哈希冲突零特判——index 记录自带 originalPath，
 * 同 pathKey 目录天然可服务多个原始路径，list 按 originalPath 过滤）。
 *
 * 边界（README 声明同款）：敏感文件（.env* / *.key / *.pem / id_rsa*，按 basename 判）不拍；
 * 单文件 >10MB 不拍；目标不存在写 existed:false 标记记录（撤销创建语义：restore 到它 = 移回收站）；
 * 保留策略 = 每文件最新 10 份 + 每进程首次 save 时 sweep 7 天前快照（同步重写 .sessions 索引）。
 *
 * 渲染端安全子集：严禁 import fs/os/crypto，哈希手写（FNV-1a BigInt），路径拼接手写；
 * 全部读写走注入的 IFileSystemProvider（CLI 直写 / UI 渲染端经 file:* IPC 落主进程）。
 * 全程 try/catch：快照失败绝不阻断写入，原因经返回值 warning 上抛（兜底失守必须可见）。
 */

import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'

/**
 * 端无关路径归一（纯字符串操作）：统一分隔符/折叠重复斜杠/去尾斜杠/小写。
 * 不用 writeBoundary 的 normalizePathForCompare——它依赖 node:path（渲染端是 POSIX polyfill，
 * path.sep 与 normalize 行为不同），CLI 与 UI 对同一文件会算出不同 pathKey、跨端恢复断链；
 * 本模块的快照库两端共享，归一必须端无关（writeBoundary 的边界判定是同端自用，不受影响）。
 */
function normalizeForKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** save 的归因元数据（调用点现成；sessionId/turnId 由 store 经 context 闭包现读补齐） */
export interface BackupSaveMeta {
  toolName: string
  toolCallId: string
  /** Worker 委派写的发起任务 id（= task 调用的 toolCallId）；主会话写无此字段 */
  taskId?: string
  source: 'main' | 'worker'
  /** 2.2 备份归因随调用归属：调用侧 scope 现读的会话 id（只增；缺省回退 context 闭包=现状） */
  sessionId?: string
  /** 2.2 轮次归因（只增；缺省回退 context 闭包=现状） */
  turnId?: string
}

export interface BackupSaveResult {
  saved: boolean
  /** 快照时间戳（= 快照文件名；restore 的定位键） */
  ts?: string
  /** 未留存原因（敏感文件/超限/读写失败……），调用方附到写结果尾部 */
  warning?: string
}

/** index.jsonl 一行 = 一条快照记录（list 的返回元素） */
export interface BackupEntry {
  ts: string
  /** 快照文件名；existed:false 标记记录为 null */
  file: string | null
  originalPath: string
  toolName: string
  toolCallId: string
  sessionId: string
  turnId?: string
  taskId?: string
  source: 'main' | 'worker'
  sizeBytes: number
  /** false = 写前文件不存在的标记记录（撤销创建：restore 到它 = 移回收站） */
  existed: boolean
}

/** 轮次/任务级写入组（listTurns 返回；任务组 key=task:<taskId>，轮次组 key=turn:<turnId>） */
export interface TurnGroup {
  key: string
  turnId?: string
  taskId?: string
  firstTs: string
  lastTs: string
  /** 组内涉及的文件（去重） */
  files: string[]
  /** 组内工具名摘要（去重） */
  toolNames: string[]
  /** 组内写入次数 */
  count: number
}

export interface BackupRestoreResult {
  restored: boolean
  /** 恢复成功但恢复前现状快照未留存（恢复本身不可逆了，必须可见） */
  warning?: string
  error?: string
}

export interface TurnRestoreResult {
  restored: string[]
  errors: string[]
}

export interface BackupStoreDeps {
  fs: IFileSystemProvider
  /** backups 根目录（~/.chill/backups；壳层注入 getter——CLI 接 NodePathProvider，UI 在 userDataPath 解析后注入） */
  rootDir: () => string
  /** 归因上下文现读闭包（executor hookContextProvider 同数据源；sessionId 可空——空则不写 .sessions 索引） */
  context: () => { sessionId: string; turnId?: string }
}

/** 每文件保留的最新快照份数（7 天 sweep 是总量闸门，10 份恢复列表仍可用编号选择） */
const KEEP_PER_FILE = 10
/** 单文件快照上限（超限不拍：快照成本 > 回滚价值） */
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024
/** sweep 年龄阈值：7 天 */
const SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000
const SESSIONS_DIR = '.sessions'
const INDEX_FILE = 'index.jsonl'

/** 每进程首次 save 时 sweep 一次的标记（对齐 desktop-audit 先例：逐文件容错、全程 try/catch） */
let globalSwept = false

const byteEncoder = new TextEncoder()

/** 64-bit FNV-1a，取低 48 bit 的 12 hex（手写——渲染端安全子集不可用 crypto） */
function fnv1a12(input: string): string {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i))
    h = (h * prime) & mask
  }
  return h.toString(16).padStart(16, '0').slice(-12)
}

/** basename 清洗：仅留 [A-Za-z0-9._-]（避开 Windows 非法字符/中文），≤20 字符，空则 'file' */
function sanitizeBasename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 20).replace(/[. ]+$/, '')
  return cleaned || 'file'
}

/** 快照文件名时间戳（本地时间，定宽可字典序比较；compare 即时间序） */
function formatTs(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
}

/** 单调时间戳：同毫秒连写（工具循环内对同一文件的连续快照）时递增 1ms——
 *  ts 即快照文件名，撞名会互相覆盖导致索引指向错误内容（实测教训） */
let lastTsMs = 0
function nextTs(): string {
  const now = Date.now()
  const ms = now <= lastTsMs ? lastTsMs + 1 : now
  lastTsMs = ms
  return formatTs(new Date(ms))
}

/** 手动拼接（不依赖 node:path——渲染端安全子集） */
function joinPath(a: string, b: string): string {
  return `${a.replace(/[\\/]+$/, '')}/${b}`
}

function basenameOf(p: string): string {
  const n = p.replace(/\\/g, '/')
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(i + 1) : n
}

/** 敏感文件判定（按 basename）：pre-image 明文存进 backups = 用户不知情的凭证副本 */
function isSensitiveName(base: string): boolean {
  const n = base.toLowerCase()
  return n.startsWith('.env') || n.endsWith('.key') || n.endsWith('.pem') || n.startsWith('id_rsa')
}

/** 行的稳定标识（prune/sweep 删行用；ts+file+toolCallId 组合足够区分同文件连续写） */
function lineId(e: { ts?: unknown; file?: unknown; toolCallId?: unknown }): string {
  return `${String(e.ts ?? '')}|${String(e.file ?? '')}|${String(e.toolCallId ?? '')}`
}

export class BackupStore {
  constructor(private readonly deps: BackupStoreDeps) {}

  /**
   * 写前留存 pre-image。
   * 敏感文件/超限/读写失败 → { saved:false, warning }（调用方附写结果尾部）；绝不抛错阻断写入。
   */
  async save(originalPath: string, meta: BackupSaveMeta): Promise<BackupSaveResult> {
    try {
      if (isSensitiveName(basenameOf(originalPath))) {
        return { saved: false, warning: '敏感文件不留存快照' }
      }
      await this.sweepOnce()
      // 2.2 备份归因随调用归属：meta 携带的 scope 归因优先；缺省回退 context 闭包（现状）
      const fallbackCtx = this.context()
      const ctx = {
        sessionId: meta.sessionId ?? fallbackCtx.sessionId,
        turnId: meta.turnId ?? fallbackCtx.turnId,
      }
      const pathKey = this.pathKeyOf(originalPath)
      const dir = joinPath(this.deps.rootDir(), pathKey)
      const ts = nextTs()

      const existsResult = await this.deps.fs.fileExists(originalPath)
      const existed = existsResult.success && existsResult.data === true
      let file: string | null = null
      let sizeBytes = 0
      if (existed) {
        const read = await this.deps.fs.readFile(originalPath)
        const content = read.success ? read.data?.content : null
        if (typeof content !== 'string') {
          return { saved: false, warning: '读取原文件失败，未留存备份快照' }
        }
        sizeBytes = byteEncoder.encode(content).length
        if (sizeBytes > MAX_SNAPSHOT_BYTES) {
          return { saved: false, warning: '文件超过 10MB，未留存备份快照' }
        }
        file = ts
        const w = await this.deps.fs.writeFile(joinPath(dir, file), content)
        if (!w.success) {
          return { saved: false, warning: `快照写入失败：${w.error ?? '未知错误'}` }
        }
      }

      const entry: BackupEntry = {
        ts,
        file,
        originalPath,
        toolName: meta.toolName,
        toolCallId: meta.toolCallId,
        sessionId: ctx.sessionId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        ...(meta.taskId ? { taskId: meta.taskId } : {}),
        source: meta.source,
        sizeBytes,
        existed,
      }
      await this.appendJsonl(joinPath(dir, INDEX_FILE), entry)

      // 会话维度二级索引（空 sessionId 只写 per-file 快照，文件级恢复仍可用；
      // 行内直接带快照文件名与 existed——恢复时免去二次查 per-file index）
      if (ctx.sessionId) {
        await this.appendJsonl(this.sessionsIndexPath(ctx.sessionId), {
          ts,
          file,
          originalPath,
          pathKey,
          turnId: ctx.turnId,
          taskId: meta.taskId,
          toolName: meta.toolName,
          existed,
        })
      }

      await this.prune(pathKey)
      return { saved: true, ts }
    } catch (error) {
      return { saved: false, warning: `备份快照留存失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 枚举某文件的快照（倒序，最新在前；按 originalPath 过滤同 pathKey 目录——哈希冲突零特判） */
  async list(originalPath: string): Promise<BackupEntry[]> {
    try {
      const pathKey = this.pathKeyOf(originalPath)
      const entries = await this.readJsonl(joinPath(joinPath(this.deps.rootDir(), pathKey), INDEX_FILE))
      const norm = normalizeForKey(originalPath)
      return entries
        .filter((e) => e && typeof e.ts === 'string' &&
          normalizeForKey(String(e.originalPath ?? '')) === norm)
        .map((e) => e as BackupEntry)
        .sort((a, b) => b.ts.localeCompare(a.ts))
    } catch {
      return []
    }
  }

  /**
   * 恢复到指定快照：先对当前内容再拍一份 pre-image（回滚可再回滚），再写回；
   * existed:false 标记记录 = 撤销创建（文件移回收站，与 delete_file 同通道）。
   * 注意：写回后调用方负责失效 executor 的文档快照缓存（invalidateSnapshot），
   * 否则下次 insert/replace 会拿过期快照做锚点匹配。
   */
  async restore(originalPath: string, ts: string): Promise<BackupRestoreResult> {
    try {
      const pathKey = this.pathKeyOf(originalPath)
      const entries = await this.readJsonl(joinPath(joinPath(this.deps.rootDir(), pathKey), INDEX_FILE))
      const norm = normalizeForKey(originalPath)
      const entry = entries.find((e) => e && e.ts === ts &&
        normalizeForKey(String(e.originalPath ?? '')) === norm)
      if (!entry) return { restored: false, error: '未找到对应的备份记录' }
      return await this.restoreEntry(
        originalPath,
        pathKey,
        String(entry.ts),
        typeof entry.file === 'string' && entry.file ? entry.file : null,
        entry.existed !== false,
      )
    } catch (error) {
      return { restored: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 轮次/任务级写入组枚举（读 .sessions 二级索引，零全库扫描；按 lastTs 倒序取 limit 组） */
  async listTurns(sessionId: string, limit = 10): Promise<TurnGroup[]> {
    try {
      const lines = await this.readJsonl(this.sessionsIndexPath(sessionId))
      const groups = new Map<string, TurnGroup & { fileSet: Set<string>; toolSet: Set<string> }>()
      for (const l of lines) {
        if (!l || typeof l.ts !== 'string' || typeof l.originalPath !== 'string') continue
        const taskId = typeof l.taskId === 'string' && l.taskId ? l.taskId : undefined
        const turnId = typeof l.turnId === 'string' && l.turnId ? l.turnId : undefined
        // 任务组独立成恢复单位（杜绝后台快照错挂主对话轮次）；turnId 记发起轮（归属可溯）
        const key = taskId ? `task:${taskId}` : `turn:${turnId ?? ''}`
        let g = groups.get(key)
        if (!g) {
          g = {
            key, turnId, taskId,
            firstTs: l.ts, lastTs: l.ts,
            files: [], toolNames: [], count: 0,
            fileSet: new Set(), toolSet: new Set(),
          }
          groups.set(key, g)
        }
        if (l.ts < g.firstTs) g.firstTs = l.ts
        if (l.ts > g.lastTs) g.lastTs = l.ts
        g.count++
        if (!g.fileSet.has(l.originalPath)) { g.fileSet.add(l.originalPath); g.files.push(l.originalPath) }
        const tn = typeof l.toolName === 'string' ? l.toolName : ''
        if (tn && !g.toolSet.has(tn)) { g.toolSet.add(tn); g.toolNames.push(tn) }
      }
      return [...groups.values()]
        .map(({ fileSet: _f, toolSet: _t, ...g }) => g)
        .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
        .slice(0, Math.max(1, limit))
    } catch {
      return []
    }
  }

  /**
   * 整轮/整任务批量恢复：每文件取组内最早快照（= 该轮/该任务写前状态），
   * 逐文件 restore（各自仍先拍现状快照——整轮回滚同样可再回滚）。
   * taskId 提供时按任务组恢复；否则按轮次组（不含任务委派的写——它们是独立恢复单位）。
   */
  async restoreTurn(sessionId: string, turnId: string, taskId?: string): Promise<TurnRestoreResult> {
    const restored: string[] = []
    const errors: string[] = []
    try {
      const lines = await this.readJsonl(this.sessionsIndexPath(sessionId))
      const byFile = new Map<string, { ts: string; file: string | null; pathKey: string; existed: boolean }>()
      for (const l of lines) {
        if (!l || typeof l.ts !== 'string' || typeof l.originalPath !== 'string') continue
        const match = taskId ? l.taskId === taskId : (l.turnId === turnId && !l.taskId)
        if (!match) continue
        const cur = byFile.get(l.originalPath)
        if (!cur || l.ts < cur.ts) {
          byFile.set(l.originalPath, {
            ts: l.ts,
            file: typeof l.file === 'string' && l.file ? l.file : null,
            pathKey: typeof l.pathKey === 'string' && l.pathKey ? l.pathKey : this.pathKeyOf(l.originalPath),
            existed: l.existed !== false,
          })
        }
      }
      for (const [originalPath, l] of byFile) {
        try {
          const r = await this.restoreEntry(originalPath, l.pathKey, l.ts, l.file, l.existed)
          if (r.restored) restored.push(originalPath)
          // 指向缺失快照的行容错：记 error 继续（不阻断其余文件恢复）
          else errors.push(`${originalPath}: ${r.error ?? '未知错误'}`)
        } catch (error) {
          errors.push(`${originalPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    return { restored, errors }
  }

  // ==================== 内部实现 ====================

  /**
   * 通用前缀清理原语（与"版本/项目"概念零耦合）：删除 originalPath 位于指定前缀下的
   * 全部快照（桶目录 + 索引行），并同步清 .sessions 索引中对应行。
   * 调用方语义：谁删除真相源目录树，谁负责清理其衍生快照
   * （如 /switch-version 成功固化后，由切换流程清理 workcopy 前缀的过程性快照——
   * 最终态已由版本树承接，过程态随树清理）。
   */
  async purgePrefix(absPathPrefix: string): Promise<{ removed: number; errors: number }> {
    let removed = 0
    let errors = 0
    try {
      const prefixNorm = normalizeForKey(absPathPrefix)
      const under = (p: unknown): boolean => {
        if (typeof p !== 'string' || !p) return false
        const n = normalizeForKey(p)
        return n === prefixNorm || n.startsWith(prefixNorm + '/')
      }

      // per-file 桶：整桶在前缀下 → 删整个目录；部分在（哈希冲突）→ 删对应快照文件并重写 index
      const root = this.deps.rootDir()
      const list = await this.deps.fs.listDirectory(root)
      const dirs: Array<{ name: string; type: string }> = list.success ? (list.data?.files ?? []) : []
      for (const d of dirs) {
        if (d.type !== 'directory' || d.name === SESSIONS_DIR) continue
        try {
          const dir = joinPath(root, d.name)
          const indexPath = joinPath(dir, INDEX_FILE)
          const entries = await this.readJsonl(indexPath)
          if (entries.length === 0) continue
          const underEntries = entries.filter((e) => under(e.originalPath))
          if (underEntries.length === 0) continue
          if (underEntries.length === entries.length) {
            const del = await this.deps.fs.deleteFile(dir) // provider 删除走回收站，目录同理
            if (del.success) removed += underEntries.length
            else errors++
          } else {
            for (const e of underEntries) {
              if (typeof e.file === 'string' && e.file) {
                try { await this.deps.fs.deleteFile(joinPath(dir, e.file)) } catch { /* 逐文件容错 */ }
              }
            }
            const dropped = new Set(underEntries.map((e) => lineId(e)))
            await this.writeJsonl(indexPath, entries.filter((e) => !dropped.has(lineId(e))))
            removed += underEntries.length
          }
        } catch {
          errors++
        }
      }

      // .sessions 二级索引：剔除前缀下的行并重写
      const sessionsDir = joinPath(root, SESSIONS_DIR)
      const sList = await this.deps.fs.listDirectory(sessionsDir)
      const sFiles: Array<{ name: string; type: string }> = sList.success ? (sList.data?.files ?? []) : []
      for (const f of sFiles) {
        if (f.type !== 'file' || !f.name.endsWith('.jsonl')) continue
        try {
          const p = joinPath(sessionsDir, f.name)
          const lines = await this.readJsonl(p)
          const kept = lines.filter((l) => !under(l.originalPath))
          if (kept.length !== lines.length) {
            await this.writeJsonl(p, kept)
          }
        } catch { /* 逐文件容错 */ }
      }
    } catch {
      errors++
    }
    return { removed, errors }
  }

  private pathKeyOf(originalPath: string): string {
    return `${fnv1a12(normalizeForKey(originalPath))}-${sanitizeBasename(basenameOf(originalPath))}`
  }

  /** 读取指定快照文件的内容（恢复中心 diff 预览用；不存在/读取失败 → null） */
  async readSnapshot(originalPath: string, file: string): Promise<string | null> {
    try {
      const pathKey = this.pathKeyOf(originalPath)
      const read = await this.deps.fs.readFile(joinPath(joinPath(this.deps.rootDir(), pathKey), file))
      const content = read.success ? (read.data?.content ?? read.data) : null
      return typeof content === 'string' ? content : null
    } catch {
      return null
    }
  }

  private sessionsIndexPath(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown'
    return joinPath(joinPath(this.deps.rootDir(), SESSIONS_DIR), `${safe}.jsonl`)
  }

  /** 归因上下文现读（闭包异常退化空 sessionId——只写 per-file 快照，不写会话索引） */
  private context(): { sessionId: string; turnId?: string } {
    try {
      const c = this.deps.context()
      return { sessionId: c?.sessionId ?? '', turnId: c?.turnId }
    } catch {
      return { sessionId: '' }
    }
  }

  /**
   * 读 JSONL（单行损坏只丢一条；文件不存在/读取失败 → []）。
   * 数据契约兼容：readFile data 可能是 { content } 包装或裸字符串。
   */
  private async readJsonl(path: string): Promise<Array<Record<string, any>>> {
    try {
      const read = await this.deps.fs.readFile(path)
      if (!read.success) return []
      const raw = read.data?.content ?? read.data ?? ''
      if (typeof raw !== 'string' || !raw.trim()) return []
      const out: Array<Record<string, any>> = []
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const obj = JSON.parse(t)
          if (obj && typeof obj === 'object') out.push(obj)
        } catch { /* 单行损坏只丢一条 */ }
      }
      return out
    } catch {
      return []
    }
  }

  /** 重写 JSONL（prune/sweep 的索引收缩；空列表写空串清文件） */
  private async writeJsonl(path: string, lines: Array<Record<string, any>>): Promise<void> {
    const content = lines.length ? lines.map((l) => JSON.stringify(l)).join('\n') + '\n' : ''
    await this.deps.fs.writeFile(path, content)
  }

  /**
   * 追加一行 JSONL。
   * 注：IFileSystemProvider 无 appendFile，只能读-拼-写；行文本极小、并发写竞争域
   * 已按 per-file/per-session 索引隔离（设计取舍：不为 append 扩接口牵连三个 provider）。
   */
  private async appendJsonl(path: string, obj: Record<string, any>): Promise<void> {
    try {
      const read = await this.deps.fs.readFile(path)
      const existing = read.success ? (read.data?.content ?? read.data ?? '') : ''
      const base = typeof existing === 'string' ? existing : ''
      await this.deps.fs.writeFile(path, base + JSON.stringify(obj) + '\n')
    } catch {
      await this.deps.fs.writeFile(path, JSON.stringify(obj) + '\n').catch(() => { /* 索引失败不阻断 */ })
    }
  }

  /** keep-10 修剪：按 originalPath 分组各留最新 10 份，删快照文件并重写 index（失败不阻断主流程） */
  private async prune(pathKey: string): Promise<void> {
    try {
      const dir = joinPath(this.deps.rootDir(), pathKey)
      const indexPath = joinPath(dir, INDEX_FILE)
      const entries = await this.readJsonl(indexPath)
      const byPath = new Map<string, Array<Record<string, any>>>()
      for (const e of entries) {
        const k = normalizeForKey(String(e.originalPath ?? ''))
        const arr = byPath.get(k)
        if (arr) arr.push(e)
        else byPath.set(k, [e])
      }
      const dropped = new Set<string>()
      const dropFiles = new Set<string>()
      for (const group of byPath.values()) {
        group.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
        for (const e of group.slice(KEEP_PER_FILE)) {
          dropped.add(lineId(e))
          if (typeof e.file === 'string' && e.file) dropFiles.add(e.file)
        }
      }
      if (dropped.size === 0) return
      for (const f of dropFiles) {
        try { await this.deps.fs.deleteFile(joinPath(dir, f)) } catch { /* 逐文件容错 */ }
      }
      await this.writeJsonl(indexPath, entries.filter((e) => !dropped.has(lineId(e))))
    } catch { /* 修剪失败不影响主流程 */ }
  }

  /**
   * 每进程首次 save 时 sweep 7 天前快照（对齐 desktop-audit 先例：逐文件容错、全程 try/catch）；
   * 同步按 ts 重写 per-file index 与 .sessions 索引中指向已删快照的行
   * （读取侧对指向缺失快照的行另有容错 skip，双保险）。
   */
  private async sweepOnce(): Promise<void> {
    if (globalSwept) return
    globalSwept = true
    try {
      const root = this.deps.rootDir()
      const cutoff = formatTs(new Date(Date.now() - SWEEP_AGE_MS))
      const list = await this.deps.fs.listDirectory(root)
      const dirs: Array<{ name: string; type: string }> = list.success ? (list.data?.files ?? []) : []
      for (const d of dirs) {
        if (d.type !== 'directory' || d.name === SESSIONS_DIR) continue
        try {
          const dir = joinPath(root, d.name)
          const sub = await this.deps.fs.listDirectory(dir)
          const files: Array<{ name: string; type: string }> = sub.success ? (sub.data?.files ?? []) : []
          // 快照文件名 = 时间戳，字典序 < cutoff 即过期
          const victims = files.filter((f) => f.type === 'file' && f.name !== INDEX_FILE && f.name < cutoff)
          if (victims.length === 0) continue
          for (const v of victims) {
            try { await this.deps.fs.deleteFile(joinPath(dir, v.name)) } catch { /* 逐文件容错 */ }
          }
          const victimNames = new Set(victims.map((v) => v.name))
          const entries = await this.readJsonl(joinPath(dir, INDEX_FILE))
          const kept = entries.filter((e) =>
            String(e.ts ?? '') >= cutoff && !(typeof e.file === 'string' && victimNames.has(e.file)))
          if (kept.length !== entries.length) {
            await this.writeJsonl(joinPath(dir, INDEX_FILE), kept)
          }
        } catch { /* 逐目录容错 */ }
      }
      // .sessions 索引同步重写（按 ts 收缩）
      const sessionsDir = joinPath(root, SESSIONS_DIR)
      const sList = await this.deps.fs.listDirectory(sessionsDir)
      const sFiles: Array<{ name: string; type: string }> = sList.success ? (sList.data?.files ?? []) : []
      for (const f of sFiles) {
        if (f.type !== 'file' || !f.name.endsWith('.jsonl')) continue
        try {
          const p = joinPath(sessionsDir, f.name)
          const lines = await this.readJsonl(p)
          const kept = lines.filter((l) => String(l.ts ?? '') >= cutoff)
          if (kept.length !== lines.length) {
            await this.writeJsonl(p, kept)
          }
        } catch { /* 逐文件容错 */ }
      }
    } catch { /* sweep 失败不影响主流程 */ }
  }

  /** restore 的统一落点（文件级与轮次级共用；恢复前先拍现状 pre-image——回滚可再回滚） */
  private async restoreEntry(
    originalPath: string,
    pathKey: string,
    ts: string,
    file: string | null,
    existed: boolean,
  ): Promise<BackupRestoreResult> {
    if (!existed) {
      // 撤销创建：写前文件不存在 → 移回收站（OS 级兜底，与 delete_file 一致）
      const del = await this.deps.fs.deleteFile(originalPath)
      if (!del.success) {
        return { restored: false, error: `撤销创建失败（移回收站）：${del.error ?? '未知错误'}` }
      }
      return { restored: true }
    }
    if (!file) return { restored: false, error: '备份记录缺少快照文件' }
    const read = await this.deps.fs.readFile(joinPath(joinPath(this.deps.rootDir(), pathKey), file))
    const content = read.success ? (read.data?.content ?? read.data) : null
    if (typeof content !== 'string') {
      return { restored: false, error: '快照读取失败（可能已被保留策略清理）' }
    }
    // 恢复前先对当前内容再拍一份（敏感文件等未留存场景经 warning 上抛——恢复不可逆必须可见）
    const pre = await this.save(originalPath, { toolName: 'restore', toolCallId: `restore-${ts}`, source: 'main' })
    const w = await this.deps.fs.writeFile(originalPath, content)
    if (!w.success) {
      return { restored: false, error: `写回失败：${w.error ?? '未知错误'}` }
    }
    return { restored: true, warning: pre.saved ? undefined : pre.warning }
  }
}
