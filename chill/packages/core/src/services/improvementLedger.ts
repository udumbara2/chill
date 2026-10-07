import * as path from 'path'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../interfaces/IPathProvider'
import {
  parseProposals,
  applyDecisions,
  buildDecisionView,
  buildAgingDecisions,
  summarizeDigest,
  formatDigestLine,
  sanitizeEntryText,
  type Decision,
  type DecisionView,
  type DecisionViewOptions,
  type DecisionDigest,
  type ParsedProposals,
  applyConfirmedTransitions,
  type ConfirmedTransition,
} from './ImprovementProposalManager'

/**
 * ImprovementLedger — 改进提案账本唯一读写入口（决策闭环 + 闪念捕获）
 *
 * 架构与 memoryStore / improvementProposer 平行：init(fsProvider, pathProvider) 注入、
 * 单例供给三壳；纯逻辑全部在 ImprovementProposalManager（本类零判定逻辑，只做 IO 编排）。
 *
 * 四条纪律：
 * - **唯一写入口**：decide/applyAging/capture 全部经 transact（串行化 + 读新 + 变换 + tmp+rename
 *   原子写 + 缓存失效——R1：写机械一份，三条写路径共用）；进程内 promise 链串行化（防连点竞态），
 *   跨进程为 last-write-wins（低频可接受，并发窗口已在规划声明）
 * - **capture 防线**（R4/R5）：sanitizeEntryText 单行化（结构注入防线）+ 500 字截断 + 10s 同文本防重
 * - **mtime 惰性缓存**：getView/getDigest 用 statFile 对账（renameFile 同款鸭子类型契约），
 *   宿主未实现 statFile 退化为短 TTL 重读（正确性优先）；任何写后缓存失效
 * - Node-free / renderer 安全（无 Node API，经注入的 provider 访问文件）
 */

export interface LedgerReadResult {
  ok: boolean
  applied: number
  error?: string
}

export interface AgingApplyResult extends LedgerReadResult {
  /** 老化摘要行（无老化时 null） */
  summary: string | null
}

export interface CaptureResult extends LedgerReadResult {
  /** 10s 同文本防重命中（未写入，幂等成功） */
  duplicated?: boolean
  /** 超 500 字被截断 */
  truncated?: boolean
}

interface LedgerCache {
  raw: string
  parsed: ParsedProposals
  at: number
  mtimeMs?: number
  size?: number
}

/** 无 statFile 宿主的缓存 TTL（ms）：TUI statusline 高频渲染与正确性的折中 */
const CACHE_TTL_MS = 5000

/** capture 单条长度上限（R4：防误粘大段灌账本；人机共写文件的体积防线） */
const MAX_CAPTURE_CHARS = 500

/** capture 同文本防重窗口（ms）：离线补跑的紧凑 drain 使该窗口在迟到场景同样有效 */
const CAPTURE_DEDUP_MS = 10_000

export class ImprovementLedger {
  private static instance: ImprovementLedger
  private fsProvider: IFileSystemProvider | null = null
  private pathProvider: IPathProvider | null = null
  private cache: LedgerCache | null = null
  /** 写串行化链（R4）：同进程决策/老化/捕获逐个落盘，防读-改-写竞态 */
  private writeChain: Promise<unknown> = Promise.resolve()
  /** capture 近期记录（10s 同文本防重；进程内——跨进程并发面已声明接受） */
  private recentCaptures: Array<{ text: string; at: number }> = []

  private constructor() {}

  static getInstance(): ImprovementLedger {
    if (!ImprovementLedger.instance) ImprovementLedger.instance = new ImprovementLedger()
    return ImprovementLedger.instance
  }

  init(fsProvider: IFileSystemProvider, pathProvider: IPathProvider): void {
    this.fsProvider = fsProvider
    this.pathProvider = pathProvider
    this.cache = null
    this.recentCaptures = []
  }

  /** 是否已装配（壳侧未装配时静默降级为无账本） */
  isInitialized(): boolean {
    return this.fsProvider !== null && this.pathProvider !== null
  }

  private proposalsPath(): string {
    return path.join(this.pathProvider!.getUserDataPath(), 'improvement-proposals.md')
  }

  /** 跳过缓存直读磁盘（写前必经），并记录 stat 指纹 */
  private async readFresh(): Promise<LedgerCache | null> {
    if (!this.isInitialized()) return null
    const read = await this.fsProvider!.readFile(this.proposalsPath())
    if (!read.success) {
      this.cache = null
      return null
    }
    const content = read.data?.content ?? read.data
    const raw = typeof content === 'string' ? content : String(content ?? '')
    const cache: LedgerCache = { raw, parsed: parseProposals(raw), at: Date.now() }
    if (this.fsProvider!.statFile) {
      try {
        const st = await this.fsProvider!.statFile(this.proposalsPath())
        if (st.success && st.data) {
          cache.mtimeMs = st.data.mtimeMs
          cache.size = st.data.size
        }
      } catch {
        /* stat 失败按无指纹处理（TTL 兜底） */
      }
    }
    this.cache = cache
    return cache
  }

  /** 缓存读：statFile 对账优先，缺失退化为短 TTL；任何异常退化直读 */
  private async readCached(): Promise<ParsedProposals | null> {
    if (!this.isInitialized()) return null
    if (this.cache) {
      if (this.fsProvider!.statFile) {
        try {
          const st = await this.fsProvider!.statFile(this.proposalsPath())
          if (st.success && st.data && st.data.mtimeMs === this.cache.mtimeMs && st.data.size === this.cache.size) {
            return this.cache.parsed
          }
        } catch {
          /* fallthrough：指纹不可得走 TTL/重读 */
        }
      } else if (Date.now() - this.cache.at < CACHE_TTL_MS) {
        return this.cache.parsed
      }
    }
    return (await this.readFresh())?.parsed ?? null
  }

  /** 原子写：tmp+rename（renameFile 鸭子类型契约，TaskStore 先例）；未实现/失败退化直写 */
  private async atomicWrite(content: string): Promise<boolean> {
    const target = this.proposalsPath()
    const tmp = `${target}.tmp`
    const w = await this.fsProvider!.writeFile(tmp, content)
    if (w.success && typeof this.fsProvider!.renameFile === 'function') {
      const r = await this.fsProvider!.renameFile(tmp, target)
      if (r.success) return true
      // rename 失败退化直写（tmp 残留容忍——下次写覆盖）
    }
    const d = await this.fsProvider!.writeFile(target, content)
    return !!d.success
  }

  /**
   * 写事务统一机械（R1）：串行化 → 读新 → transform（返回新全文；null=无变更不落盘）
   * → 原子写 → 缓存失效 → 回读。decide/applyAging/capture 三条写路径共用本机械。
   */
  private async transact(
    transform: (fresh: LedgerCache) => string | null,
  ): Promise<{ ok: boolean; error?: string; fresh: LedgerCache | null }> {
    const exec = async (): Promise<{ ok: boolean; error?: string; fresh: LedgerCache | null }> => {
      const fresh = await this.readFresh()
      if (!fresh) return { ok: false, error: '未找到 ~/.chill/improvement-proposals.md', fresh: null }
      let next: string | null
      try {
        next = transform(fresh)
      } catch (err: unknown) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), fresh }
      }
      if (next === null) return { ok: true, fresh }
      if (!(await this.atomicWrite(next))) {
        return { ok: false, error: '提案文件写入失败（磁盘/权限）', fresh }
      }
      this.cache = null
      const refreshed = await this.readFresh()
      return { ok: true, fresh: refreshed }
    }
    return (this.writeChain = this.writeChain.then(exec, exec)) as Promise<{
      ok: boolean
      error?: string
      fresh: LedgerCache | null
    }>
  }

  /** 待确认区决策视图（簇聚合 + 可选 TopN）；无文件返回 null */
  async getView(opts: DecisionViewOptions = {}): Promise<DecisionView | null> {
    const parsed = await this.readCached()
    return parsed ? buildDecisionView(parsed, opts) : null
  }

  /** 四区完整解析（GUI 面板四区 tab 数据源）；无文件返回 null */
  async getParsed(): Promise<ParsedProposals | null> {
    return this.readCached()
  }

  /** 账本摘要（状态块/药丸/statusline 的一行数据源）；无文件返回 null */
  async getDigest(opts: DecisionViewOptions = {}): Promise<DecisionDigest | null> {
    const parsed = await this.readCached()
    return parsed ? summarizeDigest(parsed, opts) : null
  }

  /** 账本摘要的一行文案（core 单一格式化点，三壳共享） */
  async getDigestLine(opts: DecisionViewOptions = {}): Promise<string | null> {
    const digest = await this.getDigest(opts)
    return digest ? formatDigestLine(digest) : null
  }

  /**
   * 应用决策（唯一写入口）：读新 → applyDecisions → 原子写；进程内串行化。
   * 决策按 title 匹配待确认区，未命中即无操作（幂等——面板与对话内决策并发安全）。
   */
  async decide(decisions: Decision[]): Promise<LedgerReadResult> {
    if (decisions.length === 0) return { ok: true, applied: 0 }
    const r = await this.transact((fresh) => applyDecisions(fresh.raw, decisions))
    return r.ok ? { ok: true, applied: decisions.length } : { ok: false, applied: 0, error: r.error }
  }

  /**
   * 四向流转（C+D 手机端命令面）：close/implement/requeue 作用于已确认区、reopen 作用于已关闭区；
   * 未命中幂等无操作（applied=0 不落盘）；与 decide/applyAging/capture 共用 transact 写机械。
   */
  async applyConfirmedTransitions(transitions: ConfirmedTransition[]): Promise<LedgerReadResult & { applied: number }> {
    if (transitions.length === 0) return { ok: true, applied: 0 }
    let applied = 0
    const r = await this.transact((fresh) => {
      const out = applyConfirmedTransitions(fresh.raw, transitions)
      applied = out.applied
      return out.markdown === fresh.raw ? null : out.markdown
    })
    return r.ok ? { ok: true, applied } : { ok: false, applied: 0, error: r.error }
  }

  /**
   * 老化（只在决策面板打开时调用）：超期 pending → 移入已关闭区（可恢复）。
   * 返回摘要行供面板置顶提示；无文件/无老化返回 ok + summary:null。
   */
  async applyAging(opts: { days?: number; now?: Date } = {}): Promise<AgingApplyResult> {
    let summary: string | null = null
    let closed = 0
    const r = await this.transact((fresh) => {
      const aging = buildAgingDecisions(fresh.parsed, opts)
      if (aging.decisions.length === 0) return null
      summary = aging.summary
      closed = aging.closed
      return applyDecisions(fresh.raw, aging.decisions)
    })
    if (!r.ok) return { ok: false, applied: 0, error: r.error, summary: null }
    return { ok: true, applied: closed, summary }
  }

  /**
   * 闪念捕获（第三写入者 · 人类直报）：sanitize（结构注入防线）→ 500 字截断 → 10s 同文本防重
   * → 最小条目原子追加到「## 待确认」标记后（组=闪念）。回执语义：duplicated=幂等成功未写入。
   */
  async capture(text: string, source: string, opts: { sessionId?: string } = {}): Promise<CaptureResult> {
    if (!this.isInitialized()) return { ok: false, applied: 0, error: '账本未装配' }
    const clean = sanitizeEntryText(text)
    if (!clean) return { ok: false, applied: 0, error: '点子内容为空' }
    const truncated = clean.length > MAX_CAPTURE_CHARS
    const body = truncated ? `${clean.slice(0, MAX_CAPTURE_CHARS)}…` : clean
    // 10s 同文本防重（进程内；信封级去重已在 RelayBridge 挡投递重复——U2 三层防线之一）
    const now = Date.now()
    this.recentCaptures = this.recentCaptures.filter((r) => now - r.at < CAPTURE_DEDUP_MS)
    if (this.recentCaptures.some((r) => r.text === body)) {
      return { ok: true, applied: 0, duplicated: true }
    }
    this.recentCaptures.push({ text: body, at: now })
    const today = new Date().toISOString().split('T')[0]
    const srcLabel = sanitizeEntryText(source + (opts.sessionId ? ` · 会话 #${opts.sessionId}` : ''))
    const entry = `- [${today}] **功能**：${body}\n  **组**：闪念\n  **来源**：${srcLabel}\n`
    const r = await this.transact((fresh) => {
      const marker = '## 待确认'
      const idx = fresh.raw.indexOf(marker)
      if (idx < 0) {
        // 无待确认区（异常形态）：文件尾重建四区骨架后追加
        return `${fresh.raw}\n\n## 待确认\n${entry}`
      }
      const afterMarker = idx + marker.length
      return fresh.raw.slice(0, afterMarker) + '\n' + entry + fresh.raw.slice(afterMarker)
    })
    if (!r.ok) return { ok: false, applied: 0, error: r.error }
    return { ok: true, applied: 1, truncated }
  }

  /** 显式失效缓存（壳侧写后/测试用） */
  invalidate(): void {
    this.cache = null
  }
}

export const improvementLedger = ImprovementLedger.getInstance()
