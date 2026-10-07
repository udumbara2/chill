/**
 * 定时任务清单持久化（~/.chill/scheduled-tasks.json）
 *
 * 读写纪律（先例仿照）：
 * - 走 IFileSystemProvider 抽象，不直接 import fs（hooks 包同款约束）；
 *   mtime 走 hooks 同款 IFileMtimeProvider 窄接口。
 * - 原子写：tmp + rename（SessionPersistence:271-273 先例）。IFileSystemProvider 暂无
 *   rename 能力，对鸭子类型检出 renameFile 的宿主走 tmp+rename；不具备的宿主退化直写
 *  （读取侧 mtime 惰性重载 + 损坏 fail-open 兜底，与 MCP 配置现状同级）。
 * - mtime 惰性重载：每次读取前 stat，签名未变零读盘（HookConfigLoader 先例）；
 *   本实例写盘后立即刷新 mtime 基线——自己的写入不会触发回声重载。
 * - 损坏 fail-open：JSON 损坏 / 结构非法视为"空清单"，不阻断调度主流程；
 *   错误明细收集在 errors 供壳层展示（写错的配置不能无人察觉）。
 * - 不用 state.json（FileKeyValueStore 非原子写 + 内存快照，跨进程互不可见）。
 */

import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { FileSystemResult } from '../../interfaces/IFileSystemProvider'
import type { IFileMtimeProvider } from '../hooks/types'
import type { ScheduledTask, ScheduledTasksFileShape } from './types'

/** 鸭子类型：具备 rename 能力的宿主（原子写 tmp+rename 用；接口未含 rename 时的渐进检出） */
type MaybeRenameFs = IFileSystemProvider & {
  renameFile?: (from: string, to: string) => Promise<FileSystemResult>
}

const VALID_STATUSES = new Set(['active', 'done', 'orphaned'])
const VALID_SCOPES = new Set(['project', 'session'])

/** lastRun 字段清洗（宽松校验：形状非法按无记录处理，不拖垮条目） */
function parseLastRun(raw: unknown): ScheduledTask['lastRun'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.firedAt !== 'string' || (r.outcome !== 'completed' && r.outcome !== 'failed')) return undefined
  return {
    firedAt: r.firedAt,
    coalescedCount: typeof r.coalescedCount === 'number' && Number.isFinite(r.coalescedCount) ? r.coalescedCount : undefined,
    outcome: r.outcome,
  }
}

export class TaskStore {
  private fs: MaybeRenameFs
  private filePath: string | (() => string)
  private mtimeProvider?: IFileMtimeProvider

  private tasks: ScheduledTask[] = []
  private errors: string[] = []
  private loaded = false
  /** 本实例最后一次写入/采纳的 mtime 基线：回声过滤与惰性重载锚点 */
  private lastMtime: number | null = null

  constructor(fs: IFileSystemProvider, filePath: string | (() => string), mtimeProvider?: IFileMtimeProvider) {
    this.fs = fs
    this.filePath = filePath
    this.mtimeProvider = mtimeProvider
  }

  private path(): string {
    return typeof this.filePath === 'function' ? this.filePath() : this.filePath
  }

  /**
   * 惰性重载：mtime 未变且已加载 → 零读盘返回缓存；变化或首次 → 重读重解析。
   * 未注入 mtimeProvider 时无法廉价判变，退化为每次重读（动作触发，无轮询）。
   */
  async checkReload(): Promise<ScheduledTask[]> {
    if (!this.mtimeProvider) {
      await this.reload()
      return this.tasks
    }
    const mtime = await this.safeGetMtime()
    if (this.loaded && mtime !== null && mtime === this.lastMtime) {
      return this.tasks
    }
    await this.reload()
    return this.tasks
  }

  /** 当前缓存（不做 IO；应经 checkReload 刷新后再读） */
  getTasks(): ScheduledTask[] {
    return this.tasks
  }

  /** 最近一次加载/解析收集到的错误明细（供壳层展示） */
  getErrors(): string[] {
    return [...this.errors]
  }

  /**
   * 整表写回（任务语义校验归 SchedulerService，本层只持久化）。
   * 写后刷新 mtime 基线（自己的写入不触发回声重载）。
   */
  async saveAll(tasks: ScheduledTask[]): Promise<boolean> {
    const target = this.path()
    const content = JSON.stringify({ version: 1, tasks } satisfies ScheduledTasksFileShape, null, 2)
    let ok = false
    if (typeof this.fs.renameFile === 'function') {
      // 原子写：先写 .tmp 再 rename 覆盖（SessionPersistence 先例）
      const tmp = `${target}.tmp`
      const writeResult = await this.fs.writeFile(tmp, content)
      if (writeResult.success) {
        const renameResult = await this.fs.renameFile(tmp, target)
        ok = renameResult.success
        if (!ok) this.errors.push(`定时任务清单 rename 失败: ${target}（${renameResult.error ?? '未知原因'}）`)
      } else {
        this.errors.push(`定时任务清单写入失败: ${tmp}（${writeResult.error ?? '未知原因'}）`)
      }
    } else {
      const writeResult = await this.fs.writeFile(target, content)
      ok = writeResult.success
      if (!ok) this.errors.push(`定时任务清单写入失败: ${target}（${writeResult.error ?? '未知原因'}）`)
    }
    if (ok) {
      this.tasks = tasks
      this.loaded = true
      this.lastMtime = await this.safeGetMtime()
    }
    return ok
  }

  // ---------- 内部实现 ----------

  private async safeGetMtime(): Promise<number | null> {
    try {
      return (await this.mtimeProvider?.getMtimeMs(this.path())) ?? null
    } catch {
      return null
    }
  }

  /** 重读重解析；任何意外异常都不允许逸出到调度主流程 */
  private async reload(): Promise<void> {
    this.errors = []
    const target = this.path()
    try {
      const existsResult = await this.fs.fileExists(target)
      if (!existsResult.success || existsResult.data !== true) {
        this.tasks = []
        this.loaded = true
        this.lastMtime = await this.safeGetMtime()
        return
      }
      const readResult = await this.fs.readFile(target)
      if (!readResult.success || !readResult.data) {
        this.errors.push(`定时任务清单读取失败: ${target}${readResult.error ? `（${readResult.error}）` : ''}`)
        this.tasks = []
      } else {
        this.tasks = this.parse(readResult.data.content, target)
      }
    } catch (err) {
      this.errors.push(`定时任务清单加载异常: ${target}（${err instanceof Error ? err.message : String(err)}）`)
      this.tasks = []
    }
    this.loaded = true
    this.lastMtime = await this.safeGetMtime()
  }

  /**
   * 解析并清洗清单：JSON 损坏 / 根结构非法 → 空清单 + 错误；
   * 逐条校验，非法条目跳过不中断（坏条目不拖垮好条目），合法条目补齐默认值
   */
  private parse(content: string, filePath: string): ScheduledTask[] {
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch (err) {
      this.errors.push(`定时任务清单 JSON 解析失败: ${filePath}（${err instanceof Error ? err.message : String(err)}）`)
      return []
    }
    // 兼容裸数组与 {version, tasks} 信封
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as ScheduledTasksFileShape).tasks)
        ? (raw as ScheduledTasksFileShape).tasks!
        : null
    if (!list) {
      this.errors.push(`定时任务清单根结构非法（应为数组或 {version, tasks}）: ${filePath}`)
      return []
    }

    const tasks: ScheduledTask[] = []
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const where = `第 ${i + 1} 个任务`
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        this.errors.push(`${where} 不是对象，已跳过`)
        continue
      }
      const t = item as Record<string, unknown>
      if (typeof t.id !== 'string' || t.id === '') {
        this.errors.push(`${where} 缺少 id，已跳过`)
        continue
      }
      if (typeof t.prompt !== 'string' || t.prompt === '') {
        this.errors.push(`${where}（${t.id}）缺少 prompt，已跳过`)
        continue
      }
      if (typeof t.cron !== 'string' && typeof t.at !== 'string') {
        this.errors.push(`${where}（${t.id}）cron 与 at 必须二选一，已跳过`)
        continue
      }
      tasks.push({
        id: t.id,
        cron: typeof t.cron === 'string' ? t.cron : undefined,
        at: typeof t.at === 'string' ? t.at : undefined,
        prompt: t.prompt,
        recurring: t.recurring === true,
        scope: VALID_SCOPES.has(t.scope as string) ? (t.scope as ScheduledTask['scope']) : 'project',
        workDir: typeof t.workDir === 'string' ? t.workDir : undefined,
        sessionId: typeof t.sessionId === 'string' ? t.sessionId : undefined,
        until: typeof t.until === 'string' ? t.until : undefined,
        createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
        lastFireAt: typeof t.lastFireAt === 'string' ? t.lastFireAt : undefined,
        lastRun: parseLastRun(t.lastRun),
        fireCount: typeof t.fireCount === 'number' && Number.isFinite(t.fireCount) ? t.fireCount : 0,
        status: VALID_STATUSES.has(t.status as string) ? (t.status as ScheduledTask['status']) : 'active',
      })
    }
    return tasks
  }
}
