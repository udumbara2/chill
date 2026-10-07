/**
 * 能力网关：会话读写与搜索 + 项目存储（M1.5 四件套之四）
 *
 * core SessionPersistence 单实例（NodePathProvider → ~/.chill/sessions/，与 CLI/UI
 * 共享 ndjson）+ sessionSearch。方法面 = hostApi 合同的 session 族与 project 族。
 * watch 事件桥在 M3.8 落地（规划排期），M1 的 session:watch 返回成功但暂无推送——
 * 如实声明，不伪装实时。
 */
import {
  SessionPersistence,
  ProjectPersistence,
  NodePathProvider,
  searchSessionRecords,
  toSessionSummary,
  type SessionRecord,
  type SaveMode,
} from '@assistant-ai/core'
import { homedir } from 'node:os'

export class SessionsGateway {
  private persistence: SessionPersistence
  private projects: ProjectPersistence

  constructor(userDataPath: string) {
    const pathProvider: NodePathProvider = {
      getUserDataPath: () => userDataPath,
      getUserHomePath: () => homedir(),
    } as NodePathProvider
    this.persistence = new SessionPersistence(pathProvider)
    this.projects = new ProjectPersistence(pathProvider)
  }

  /** 会话目录（M3.8 watch 桥的监听锚点） */
  getSessionsDir(): string {
    return this.persistence.getSessionsDir()
  }

  async listMeta(): Promise<unknown> {
    const result = await this.persistence.list()
    if (!result.success) return { success: false, error: result.error }
    return { success: true, records: (result.records ?? []).map(toSessionSummary) }
  }

  async load(id: string): Promise<unknown> {
    const result = await this.persistence.load(id)
    if (!result.success) return { success: false, error: result.error }
    return { success: true, record: result.record ?? null }
  }

  async save(record: SessionRecord, mode?: SaveMode): Promise<unknown> {
    const result = await this.persistence.save(record, mode)
    return result.success ? { success: true } : { success: false, error: result.error }
  }

  async patchProject(id: string, projectId: string | null): Promise<unknown> {
    const result = await this.persistence.patchProjectId(id, projectId ?? undefined)
    return result.success ? { success: true } : { success: false, error: result.error }
  }

  async patchTitle(id: string, title: string): Promise<unknown> {
    const result = await this.persistence.patchTitle(id, title)
    return result.success ? { success: true } : { success: false, error: result.error }
  }

  async delete(id: string): Promise<unknown> {
    const result = await this.persistence.delete(id)
    return result.success ? { success: true } : { success: false, error: result.error }
  }

  async loadIfNewer(id: string): Promise<unknown> {
    const result = await this.persistence.loadIfNewer(id)
    if (!result.success) return { success: false, error: result.error }
    return { success: true, record: result.record ?? null }
  }

  search(query: string): unknown {
    try {
      return { success: true, hits: searchSessionRecords(this.persistence.getSessionsDir(), query) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '搜索失败' }
    }
  }

  /** M1：watch 重定向记账（单连接单当前会话）；事件推送 M3.8 接入 */
  watch(id: string): unknown {
    void id
    return { success: true }
  }

  async projectList(): Promise<unknown> {
    const result = await this.projects.list()
    return result.success ? { success: true, records: result.records ?? null } : { success: false, error: result.error }
  }

  async projectSave(record: unknown): Promise<unknown> {
    const result = await this.projects.save(record as never)
    return result.success ? { success: true } : { success: false, error: result.error }
  }

  async projectDelete(id: string): Promise<unknown> {
    const result = await this.projects.delete(id)
    return result.success ? { success: true } : { success: false, error: result.error }
  }
}
