/**
 * 工作流运行记录存储(M6)
 *
 * 每个 run 一个 JSON 文件:`~/.chill/workflow-runs/<runId>.json`。
 * 写入纪律:tmp+rename 原子写(IFileSystemProvider.renameFile 鸭子类型检出,
 * 未实现的宿主退化直写),CLI 与 UI 两进程同时运行互不写坏。
 * 与资产文件严格分离:执行过程只写本目录,永不写 YAML 资产。
 */

import { createHash } from 'crypto'
import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { Message } from '../../types/models'
import type { WorkflowDefinition } from '../../workflow/dsl/types'

export interface WorkflowRunRecord {
  runId: string
  workflowName: string
  /** 工作流内容哈希(定义变更后旧记录不可续跑,防"跑的是另一版") */
  contentHash: string
  input?: Record<string, any>
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  updatedAt: number
  /** 已完成节点及其产生的消息增量(续跑时按序回填,节点不重跑) */
  completedNodes: Array<{ nodeId: string; messages: Message[] }>
  finalOutput?: string
  error?: string
}

/** 定义内容哈希(canonical:仅语义字段,与 position/sourcePath 无关) */
export function workflowContentHash(def: WorkflowDefinition): string {
  const canonical = {
    name: def.name,
    version: def.version,
    inputs: def.inputs,
    nodes: def.nodes.map(({ position: _p, ...rest }) => rest),
    edges: def.edges,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export class WorkflowRunStore {
  private fs: IFileSystemProvider
  private dir: string

  constructor(fs: IFileSystemProvider, dir: string) {
    this.fs = fs
    this.dir = dir
  }

  private pathOf(runId: string): string {
    return `${this.dir}/${runId}.json`
  }

  /** 原子写(tmp+rename;宿主无 renameFile 时退化直写) */
  async save(record: WorkflowRunRecord): Promise<void> {
    record.updatedAt = Date.now()
    const content = JSON.stringify(record, null, 2)
    const path = this.pathOf(record.runId)
    if (this.fs.renameFile) {
      const tmp = `${path}.tmp`
      const write = await this.fs.writeFile(tmp, content)
      if (!write.success) throw new Error(write.error ?? '运行记录写入失败')
      const renamed = await this.fs.renameFile(tmp, path)
      if (!renamed.success) throw new Error(renamed.error ?? '运行记录改名失败')
      return
    }
    const write = await this.fs.writeFile(path, content)
    if (!write.success) throw new Error(write.error ?? '运行记录写入失败')
  }

  async load(runId: string): Promise<WorkflowRunRecord | undefined> {
    const read = await this.fs.readFile(this.pathOf(runId))
    if (!read.success || !read.data) return undefined
    try {
      return JSON.parse(read.data.content) as WorkflowRunRecord
    } catch {
      return undefined
    }
  }

  async list(): Promise<WorkflowRunRecord[]> {
    const result = await this.fs.listDirectory(this.dir)
    if (!result.success || !result.data) return []
    const files: Array<{ name: string }> = (result.data.files || []).filter(
      (f: { name: string }) => f.name.endsWith('.json') && !f.name.endsWith('.tmp'),
    )
    const records: WorkflowRunRecord[] = []
    for (const f of files) {
      const read = await this.fs.readFile(`${this.dir}/${f.name}`)
      if (!read.success || !read.data) continue
      try {
        records.push(JSON.parse(read.data.content))
      } catch {
        // 损坏记录跳过(列表职责是可见性,不因单个坏文件中断)
      }
    }
    return records.sort((a, b) => b.startedAt - a.startedAt)
  }
}
