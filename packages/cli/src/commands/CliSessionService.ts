import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SessionPersistence,
  NodePathProvider,
  type SessionRecord,
  type SessionResult,
  type ListSessionsResult,
  type SessionWatchCallback,
  type SessionStoreAdapter,
} from '@assistant-ai/core'

export interface SessionActionResult extends SessionResult {
  record?: SessionRecord
  title?: string
  /** 被删记录的 id（/session delete 后由 cli.ts 判定是否删的是当前会话） */
  deletedId?: string
}

/**
 * 体验窗口检测与 .preview-sessions 目录解析（单一事实源）：
 * CliSessionService 的持久化重定向与 CliContext 注入 executor 的 search_sessions
 * 检索目录覆盖共用本函数——保证"存哪搜哪"不漂移。
 * 检测方式同 cli.ts 的体验版提示（__dirname 含 'chill-workcopy'）。
 */
export function resolvePreviewSessions(): { isPreview: boolean; sessionsDir: string | undefined } {
  const thisDir = path.dirname(fileURLToPath(import.meta.url))
  const segments = thisDir.split(/[\\/]/)
  const workcopyIdx = segments.indexOf('chill-workcopy')
  const isPreview = workcopyIdx >= 0
  const sessionsDir = isPreview
    ? segments.slice(0, workcopyIdx + 1).join(path.sep) + path.sep + '.preview-sessions'
    : undefined
  return { isPreview, sessionsDir }
}

/**
 * CLI 会话壳服务（T4 瘦身）：权威历史/落盘/标题已上收 ChatEngine，
 * 本类只保留——
 * ① SessionPersistence 实例持有（preview 重定向），并经 `store` 共享给引擎
 *   （watch 回声过滤与 loadIfNewer 锚定依赖同一 lastWrittenMtime 基线，必须是同一实例）；
 * ② CLI↔UI 会话同步的 watch/loadIfNewer；
 * ③ /session 壳命令的列表/按序号解析/重命名/删除。
 */
export class CliSessionService {
  private persistence: SessionPersistence

  /** 体验窗口模式（自迭代 workcopy 内运行）：会话重定向到 workcopy 内，随 workcopy 清理自动消失 */
  readonly isPreview: boolean

  constructor() {
    // 体验窗口的会话不进正式版 ~/.chill/sessions/，写到 workcopy 内的 .preview-sessions/，
    // /switch-version 或 /discard-version 清理 workcopy 时随之删除
    const { isPreview, sessionsDir } = resolvePreviewSessions()
    this.isPreview = isPreview
    this.persistence = new SessionPersistence(new NodePathProvider(), sessionsDir)
  }

  /** 引擎持久化适配器：与本服务共享同一 SessionPersistence 实例 */
  get store(): SessionStoreAdapter {
    return {
      save: (record, mode) => {
        // workdir 注入（「项目=文件夹」归组用）：CLI 会话无 projectId，UI 面板按 workdir
        // 匹配项目绑定文件夹完成归组；缺失才补（merge 防护保留盘上旧值），
        // preview 会话为一次性数据，不写
        if (!this.isPreview) record.workdir ??= process.cwd()
        return this.persistence.save(record, mode)
      },
      load: (id) => this.persistence.load(id),
    }
  }

  /** 监听指定会话的外部变更（cb 收 record；null=文件被删，自身写入已内部过滤）。preview 会话为一次性数据，不启动任何 watch */
  watch(id: string, cb: SessionWatchCallback): void {
    if (this.isPreview) return
    this.persistence.watch(id, cb)
  }

  /** 停止监听：传 id 停单个，不传停全部 */
  unwatch(id?: string): void {
    if (this.isPreview) return
    this.persistence.unwatch(id)
  }

  /** 发送前锚定：磁盘记录比本端最后写入/采纳更新时返回整 record，否则 null。preview 模式恒 null（不锚定） */
  async loadIfNewer(id: string): Promise<SessionRecord | null> {
    if (this.isPreview) return null
    const result = await this.persistence.loadIfNewer(id)
    if (!result.success) return null
    return result.record ?? null
  }

  /** 会话列表（updatedAt 降序）；当前会话标记由调用方对照引擎 sessionId 自行标注 */
  async list(): Promise<ListSessionsResult> {
    return this.persistence.list()
  }

  /** 按序号解析会话记录（序号以执行时最新 list() 为准现场建立映射，不缓存） */
  async resolveByIndex(n: number): Promise<SessionRecord | null> {
    const listed = await this.persistence.list()
    if (!listed.success || !listed.records) return null
    return listed.records[n - 1] ?? null
  }

  /** 改指定会话标题并落盘；不刷新 updatedAt，避免改名改变列表排序 */
  async rename(id: string, title: string): Promise<SessionResult> {
    const loaded = await this.persistence.load(id)
    if (!loaded.success) {
      return { success: false, error: loaded.error }
    }
    if (!loaded.record) {
      return { success: false, error: '当前没有进行中的会话' }
    }
    return this.persistence.save({ ...loaded.record, title, titleSource: 'manual' })
  }

  /** 按序号删除会话；返回被删记录 id 供调用方判定是否删的是当前会话 */
  async deleteByIndex(n: number): Promise<SessionActionResult> {
    const listed = await this.persistence.list()
    if (!listed.success || !listed.records) {
      return { success: false, error: listed.error || '读取会话列表失败' }
    }
    const record = listed.records[n - 1]
    if (!record) {
      return { success: false, error: `无效序号: ${n}（共 ${listed.records.length} 条会话）` }
    }
    const result = await this.persistence.delete(record.id)
    return { ...result, title: record.title, deletedId: record.id }
  }
}
