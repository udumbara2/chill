import * as path from 'path'
import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../../interfaces/IPathProvider'
import type { Message } from '../../types/models'
import { ModelServiceFactory } from '../models/modelServiceFactory'
import { SelectedModelsService } from '../selectedModelsService'
import { memoryStore, MEMORY_TYPES, type PendingCandidate } from './memoryStore'

/**
 * 记忆蒸馏器（二期）：会话结束后自动提炼候选长期记忆，写入待确认区（.pending/）。
 *
 * 业界原型：Codex 启动时认领近期未处理 rollout 后台提取（Phase 1）；
 * Claude Code 后台 extract agent 分析最近消息；Mem0 提取 + 写时对账。
 * 审批制：候选不进正式记忆，由用户在后续对话中确认（防记忆投毒）。
 *
 * 触发方式为"启动时认领最新未蒸馏会话"，不阻塞退出/关闭；全部失败静默。
 */

export interface DistillResult {
  distilled: boolean
  skipped?: boolean
  reason?: string
  candidates?: number
  /** 本批最后一条有效消息时间戳（ms，供水位推进；无新内容时为 undefined） */
  lastTs?: number
  error?: string
}

interface SessionLite {
  id: string
  updatedAt: string
  messages: Message[]
}

/** 单条会话消息转文本的最大字符数 / 整场转录上限 */
const MAX_MSG_CHARS = 1500
const MAX_TRANSCRIPT_CHARS = 12000
const MAX_CANDIDATES = 10

const EXTRACT_PROMPT = `你是记忆提炼器。分析下面的对话记录，提炼值得跨会话长期记住的信息。

【可记四类】
- user：用户的稳定偏好、习惯、身份背景
- feedback：用户纠正或确认的工作方式（"以后别……"、"就这样做"、对回答风格的评价）
- project：无法从代码或 git 历史推导的项目事实（决策、期限、约定、外部依赖）
- reference：外部系统、账号、文档的指针

【不记】可从代码或 git 推导的内容、一次性任务状态、寒暄客套、会话原文堆砌。

【要求】
- 相对日期一律转换为绝对日期
- 每条记忆包含：规则/事实 + 原因（Why）+ 如何应用（How to apply）
- importance 1-10，默认 5，只有特别重要的才给 8+
- 已裁决标题（见下方"已裁决"清单）一律不再提议；与"现有记忆"语义重复时输出空数组

【输出】只输出 JSON 数组，不要输出任何其他文字：
[{"action":"create","type":"user|feedback|project|reference","title":"简短标题","content":"正文","importance":5}]`

function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content.filter((p: any) => p?.type === 'text' && p?.text).map((p: any) => p.text).join(' ')
  }
  return ''
}

function buildTranscript(messages: Message[], sinceTs = 0): string {
  const parts: string[] = []
  let total = 0
  for (const m of messages) {
    if (m.role === 'system') continue
    // 水位增量：只收水位线之后的消息（-1ms 容差由调用方在 sinceTs 上处理）
    const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0
    if (ts > 0 && ts <= sinceTs) continue
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具'
    let text = messageText(m).replace(/\s+/g, ' ').trim()
    if (m.toolCalls?.length) {
      const names = m.toolCalls.map(tc => tc.function?.name).filter(Boolean).join(', ')
      text = `${text} [调用工具: ${names}]`.trim()
    }
    if (!text) continue
    text = text.slice(0, MAX_MSG_CHARS)
    const line = `${role}: ${text}`
    if (total + line.length > MAX_TRANSCRIPT_CHARS) break
    parts.push(line)
    total += line.length
  }
  return parts.join('\n')
}

/** 从模型输出中提取 JSON 数组（容错 ```json 围栏与前后杂文本） */
function parseCandidates(raw: string): PendingCandidate[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const out: PendingCandidate[] = []
    for (const item of parsed) {
      if (!item || typeof item.title !== 'string' || typeof item.content !== 'string') continue
      if (!item.title.trim() || !item.content.trim()) continue
      const type = (MEMORY_TYPES as string[]).includes(item.type) ? item.type : 'user'
      out.push({
        type,
        title: item.title.trim().slice(0, 60),
        content: item.content.trim(),
        importance: typeof item.importance === 'number' ? item.importance : undefined,
      })
      if (out.length >= MAX_CANDIDATES) break
    }
    return out
  } catch {
    return []
  }
}

export class MemoryDistiller {
  private static instance: MemoryDistiller
  private fsProvider: IFileSystemProvider | null = null
  private pathProvider: IPathProvider | null = null
  private running = false

  private constructor() {}

  static getInstance(): MemoryDistiller {
    if (!MemoryDistiller.instance) MemoryDistiller.instance = new MemoryDistiller()
    return MemoryDistiller.instance
  }

  init(fsProvider: IFileSystemProvider, pathProvider: IPathProvider): void {
    this.fsProvider = fsProvider
    this.pathProvider = pathProvider
  }

  private sessionsDir(): string {
    return path.join(this.pathProvider!.getUserDataPath(), 'sessions')
  }

  /** 读取最新的会话文件（按文件名时间戳降序取第一个） */
  private async latestSession(): Promise<SessionLite | null> {
    if (!this.fsProvider || !this.pathProvider) return null
    const result = await this.fsProvider.listDirectory(this.sessionsDir())
    if (!result.success) return null
    const files: Array<{ name: string; type: string }> = result.data?.files ?? result.data?.data?.files ?? []
    const latest = files
      .filter(f => f.type === 'file' && f.name.endsWith('.json'))
      .map(f => f.name)
      .sort()
      .pop()
    if (!latest) return null
    const read = await this.fsProvider.readFile(path.join(this.sessionsDir(), latest))
    if (!read.success) return null
    try {
      const raw: string = read.data?.content ?? read.data ?? ''
      const record = JSON.parse(typeof raw === 'string' ? raw : String(raw))
      if (!record?.id || !Array.isArray(record?.messages)) return null
      return { id: record.id, updatedAt: record.updatedAt ?? '', messages: record.messages }
    } catch {
      return null
    }
  }

  /** 调模型提取候选（无工具单次调用；失败/无候选返回 []）；sinceTs 水位线之前的消息不参与 */
  private async extract(messages: Message[], sinceTs = 0): Promise<{ candidates: PendingCandidate[]; lastTs: number }> {
    const empty = { candidates: [], lastTs: 0 }
    const modelName = SelectedModelsService.getInstance().getCurrentModelName()
    if (!modelName) return empty

    // 现有记忆索引（供对账去重）
    const existing = await memoryStore.list()
    const existingText = existing.length > 0
      ? existing.map(e => `- ${e.name}: ${e.hook}`).join('\n')
      : '（暂无）'

    // 已裁决标题（approved ∪ rejected，截断最近 200 条仅作 token 优化；
    // "永不再出现"的结构保证在 writePending 的裁决丢弃层，与本清单无关）
    const reviewed = await memoryStore.readReviewed()
    const reviewedKeyList = Object.entries(reviewed)
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, 200)
      .map(([k]) => `- ${k}`)
      .join('\n')

    // 计算本批最后一条有效消息时间戳（供水位推进）
    let lastTs = 0
    for (const m of messages) {
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0
      if (ts > sinceTs && ts > lastTs) lastTs = ts
    }

    const transcript = buildTranscript(messages, sinceTs)
    if (!transcript) return { candidates: [], lastTs }

    const promptMessages: Message[] = [
      { role: 'system' as Message['role'], content: EXTRACT_PROMPT, timestamp: new Date() },
      {
        role: 'user' as Message['role'],
        content: `【现有记忆】\n${existingText}\n\n【已裁决（禁止再次提议）】\n${reviewedKeyList || '（暂无）'}\n\n【对话记录】\n${transcript}`,
        timestamp: new Date(),
      },
    ]

    const response = await ModelServiceFactory.getInstance().sendChatMessage(modelName, promptMessages, {})
    return { candidates: parseCandidates(response?.content ?? ''), lastTs }
  }

  /** 对给定消息列表立即蒸馏（手动入口，不校验水位） */
  async distillMessages(messages: Message[], sourceSessionId: string, sinceTs = 0): Promise<DistillResult> {
    try {
      const { candidates, lastTs } = await this.extract(messages, sinceTs)
      if (candidates.length === 0) {
        return { distilled: true, candidates: 0, lastTs }
      }
      await memoryStore.writePending({
        createdAt: new Date().toISOString(),
        sourceSessionId,
        candidates,
      })
      return { distilled: true, candidates: candidates.length, lastTs }
    } catch (error) {
      return { distilled: false, error: error instanceof Error ? error.message : '蒸馏失败' }
    }
  }

  /** 启动时认领：对最新会话做水位增量蒸馏（幂等、并发去重、静默失败） */
  async distillLatestSessionIfNeeded(): Promise<DistillResult> {
    if (this.running) return { distilled: false, skipped: true, reason: '已有蒸馏进行中' }
    if (!this.fsProvider || !this.pathProvider || !memoryStore.isReady()) {
      return { distilled: false, skipped: true, reason: '未初始化' }
    }
    this.running = true
    try {
      const session = await this.latestSession()
      if (!session) return { distilled: false, skipped: true, reason: '无会话' }
      if (session.messages.length < 4) {
        return { distilled: false, skipped: true, reason: '会话过短' }
      }
      const state = await memoryStore.readDistillState()
      const watermarks = state?.watermarks ?? {}
      // -1ms 容差防同毫秒边界永久漏蒸（重蒸一条因排除日志而幂等）
      const sinceTs = (watermarks[session.id] ?? 0) - 1
      const result = await this.distillMessages(session.messages, session.id, sinceTs)
      if (result.distilled) {
        // 完成（含 0 候选）推进水位：无新内容时 lastTs 回退为当前水位+1，避免每启动一次空扫
        const nextWatermark = result.lastTs ?? (watermarks[session.id] ?? 0)
        await memoryStore.writeDistillState({
          watermarks: { ...watermarks, [session.id]: Math.max(nextWatermark, watermarks[session.id] ?? 0) }
        })
      }
      return result
    } catch (error) {
      return { distilled: false, error: error instanceof Error ? error.message : '蒸馏失败' }
    } finally {
      this.running = false
    }
  }
}

export const memoryDistiller = MemoryDistiller.getInstance()
