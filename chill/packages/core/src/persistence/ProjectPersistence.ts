import { basename, dirname, join } from 'path'
import * as fs from 'fs'
import type { IPathProvider } from '../interfaces/IPathProvider'

export interface ProjectRecord {
  id: string
  name: string
  /** ISO 时间串 */
  createdAt: string
  /** ISO 时间串 */
  updatedAt: string
  /** 列表排序（预留拖拽排序，本期按创建顺序递增） */
  order: number
  /** 归档标记（预留，本期 UI 不消费） */
  archived?: boolean
  /** 项目绑定的文件夹路径（「项目=文件夹」绑定；可选字段，旧记录向后兼容） */
  folderPath?: string
}

export interface ProjectResult {
  success: boolean
  error?: string
}

/** records 为 null 表示"磁盘不比本端新"（loadIfNewer 专用；list 恒为数组） */
export interface ListProjectsResult extends ProjectResult {
  records?: ProjectRecord[] | null
}

/** watch 回调：records 为外部变更后的整表；null 表示 projects.json 已被删除 */
export type ProjectWatchCallback = (records: ProjectRecord[] | null) => void

/**
 * 项目持久化：单文件存整个项目数组（~/.chill/projects.json）。
 * 单文件结构仿 DraftPersistence，写路径安全机制对齐 SessionPersistence：
 * 原子写 tmp+rename、save 读盘按 id 合并（双端互写不丢对方项目）、
 * mtime 基线 + watch/loadIfNewer 回声过滤（照搬到单文件语义）。
 */
export class ProjectPersistence {
  private projectsFilePath: string
  /** 整表最后一次由本实例写入/采纳的 mtime（ms）：watch 回声过滤与 loadIfNewer 锚定的判据 */
  private lastWrittenMtime: number | null = null
  private watcher: fs.FSWatcher | null = null

  constructor(pathProvider: IPathProvider, projectsFileOverride?: string) {
    this.projectsFilePath = projectsFileOverride ?? join(pathProvider.getUserDataPath(), 'projects.json')
    const dir = dirname(this.projectsFilePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  private readAll(): ProjectRecord[] {
    if (!fs.existsSync(this.projectsFilePath)) return []
    const parsed = JSON.parse(fs.readFileSync(this.projectsFilePath, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as ProjectRecord[]) : []
  }

  /** 原子写：先写 .tmp 再 rename 覆盖；写后 stat 记录 mtime 基线（同 SessionPersistence，同步 fs 天然排队） */
  private writeAll(records: ProjectRecord[]): void {
    const tmpPath = `${this.projectsFilePath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf-8')
    fs.renameSync(tmpPath, this.projectsFilePath)
    this.lastWrittenMtime = fs.statSync(this.projectsFilePath).mtimeMs
  }

  /** 按 order 升序返回全部项目 */
  async list(): Promise<ListProjectsResult> {
    try {
      const records = this.readAll()
      records.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      return { success: true, records }
    } catch (error: unknown) {
      console.error('Failed to list projects:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * upsert 一条项目：读盘 → 按 id 合并（标量 incoming wins；可选字段 incoming 缺失时保留盘上值；
   * 盘上独有记录保留——双端互写不丢对方项目）→ 原子写。
   * 磁盘损坏时以新记录为准整表写入（与 SessionPersistence 同一取舍）。
   */
  async save(record: ProjectRecord): Promise<ProjectResult> {
    try {
      let existing: ProjectRecord[] = []
      try {
        existing = this.readAll()
      } catch {
        existing = []
      }
      const idx = existing.findIndex(p => p.id === record.id)
      if (idx >= 0) {
        // 可选字段合并：incoming 缺失时保留盘上值（防旧版/不带字段的写入整记录覆盖抹掉绑定，
        // 与 SessionPersistence.mergeRecord 的 projectId 防护同一取舍）
        existing[idx] = { ...record, folderPath: record.folderPath ?? existing[idx].folderPath }
      } else {
        existing.push(record)
      }
      this.writeAll(existing)
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to save project:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async delete(id: string): Promise<ProjectResult> {
    try {
      let existing: ProjectRecord[] = []
      try {
        existing = this.readAll()
      } catch {
        existing = []
      }
      this.writeAll(existing.filter(p => p.id !== id))
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to delete project:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 锚定：仅当磁盘整表比本实例最后一次写入/采纳更新时才读盘返回 records。
   * mtime 与基线相同 → records: null（零读盘）；无基线时先 stat 建基线并返回 null（首次不视为"更新"）。
   */
  async loadIfNewer(): Promise<ListProjectsResult> {
    try {
      if (!fs.existsSync(this.projectsFilePath)) {
        return { success: true, records: null }
      }
      const mtime = fs.statSync(this.projectsFilePath).mtimeMs
      if (this.lastWrittenMtime === null || mtime === this.lastWrittenMtime) {
        this.lastWrittenMtime = mtime
        return { success: true, records: null }
      }
      const records = this.readAll()
      this.lastWrittenMtime = mtime
      return { success: true, records }
    } catch (error: unknown) {
      console.error('Failed to load projects if newer:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * 监听 projects.json 的外部变更。必须盯所在目录而非文件：tmp+rename 原子写会换文件，
   * 盯文件会在第一次保存后丢监听。启动先 stat 建基线；自身 save 造成的变更被基线过滤，绝不触发 cb。
   */
  watch(cb: ProjectWatchCallback): void {
    this.unwatch()
    try {
      this.lastWrittenMtime = fs.statSync(this.projectsFilePath).mtimeMs
    } catch {
      this.lastWrittenMtime = null
    }
    const dir = dirname(this.projectsFilePath)
    const base = basename(this.projectsFilePath)
    const watcher = fs.watch(dir, (_eventType, filename) => {
      // 只关心 projects.json 本体；原子写的 .tmp 事件天然被过滤
      if (filename === base) {
        this.handleFileEvent(cb)
      }
    })
    // 目录 watch 失败（如目录被删）不抛出，由 loadIfNewer 锚定兜底
    watcher.on('error', () => {})
    this.watcher = watcher
  }

  unwatch(): void {
    this.watcher?.close()
    this.watcher = null
  }

  private handleFileEvent(cb: ProjectWatchCallback): void {
    let mtime: number
    try {
      mtime = fs.statSync(this.projectsFilePath).mtimeMs
    } catch (error: unknown) {
      // projects.json 被（对端）删除：回调 null，不抛错
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.lastWrittenMtime = null
        cb(null)
      }
      return
    }
    if (mtime === this.lastWrittenMtime) return
    try {
      const records = this.readAll()
      // 采纳后同步基线：防同一变更的后续事件重复触发
      this.lastWrittenMtime = mtime
      cb(records)
    } catch {
      // 对端直接写（非原子写）中途的瞬时事件：不更新基线，等后续事件重试
    }
  }
}
