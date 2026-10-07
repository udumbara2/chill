import * as path from 'path'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../interfaces/IPathProvider'
import type { Message } from '../types/models'
import { ModelServiceFactory } from './models/modelServiceFactory'
import { SelectedModelsService } from './selectedModelsService'
import { parseProposals as parseProposalMarkdown, extractGroupNames, sanitizeEntryText, IMPROVEMENT_EXTRACTION_STANDARD } from './ImprovementProposalManager'

/**
 * 改进提议器：启动时认领最新未分析会话，自动发现改进点，
 * 追加到 ~/.chill/improvement-proposals.md。
 *
 * 启动时认领 → 水位增量 → 调模型提取 → 静默失败。
 * 区别：关注程序表现（改进点）而非用户记忆，无审批制。
 */

export interface ProposeResult {
  proposed: boolean
  skipped?: boolean
  reason?: string
  proposals?: number
  lastTs?: number
  error?: string
}

interface SessionLite {
  id: string
  updatedAt: string
  messages: Message[]
}

const MAX_MSG_CHARS = 1500
const MAX_TRANSCRIPT_CHARS = 12000
const MAX_PROPOSALS = 5

/**
 * 动态构建改进分析 prompt：注入当前已有组名清单，模型优先复用，避免同义变体；
 * 同时授权模型在现有组不涵盖时创建新标签（≤6 字），保证分组空间开放。
 */
function buildProposePrompt(existingGroups: string[]): string {
  const groupList = existingGroups.length > 0
    ? existingGroups.join('、')
    : '（暂无）——请为每条建议创建合适的简短标签'
  return `你是 chill（一个 AI 助手程序）的改进分析器。阅读下面的对话记录，找出 chill 这个产品本身应该改变的功能。

${IMPROVEMENT_EXTRACTION_STANDARD}

【从哪里找】
- 用户明确表达不满或抱怨
- 用户反复要求同一件事（说明产品没做好）
- 用户中断、放弃，或手动绕过产品去做某件事
- 自迭代 / 工具调用暴露出的机制缺口

【输出格式】每条包含五个字段：
- 功能：需要改变的功能（一句话，从用户角度说清「什么变了」）
- 标签：分组标签（≤6 字；优先复用现有分组，若主题不属于任何现有分组则新建简短标签）
- 理由：证据——引用对话中的具体行为或用户原话
- 难度：低（改几行代码/prompt）、中（涉及多文件）、高（架构调整）
- 收益：从用户角度，此改进带来的便利或好处

当前已存在的分组（请优先复用，避免同义变体）：${groupList}

【输出】只输出 JSON 数组，不要输出任何其他文字；无发现时输出空数组 []：
[{"功能":"xxx","标签":"xxx","理由":"xxx","难度":"低","收益":"xxx"}]`
}

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

interface Proposal {
  功能: string
  标签: string
  理由: string
  难度: string
  收益: string
  来源: string
}

function parseProposals(raw: string): Proposal[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const out: Proposal[] = []
    for (const item of parsed) {
      if (!item || typeof item.功能 !== 'string' || typeof item.理由 !== 'string') continue
      if (!item.功能.trim() || !item.理由.trim()) continue
      out.push({
        功能: item.功能.trim(),
        标签: typeof item.标签 === 'string' && item.标签.trim() ? item.标签.trim() : '未分组',
        理由: item.理由.trim(),
        难度: typeof item.难度 === 'string' ? item.难度.trim() : '中',
        收益: typeof item.收益 === 'string' ? item.收益.trim() : '',
        来源: typeof item.来源 === 'string' ? item.来源.trim() : '',
      })
      if (out.length >= MAX_PROPOSALS) break
    }
    return out
  } catch {
    return []
  }
}

const PROPOSALS_FILE = 'improvement-proposals.md'
const WATERMARKS_FILE = 'improvement-watermarks.json'

export class ImprovementProposer {
  private static instance: ImprovementProposer
  private fsProvider: IFileSystemProvider | null = null
  private pathProvider: IPathProvider | null = null
  private running = false

  private constructor() {}

  static getInstance(): ImprovementProposer {
    if (!ImprovementProposer.instance) ImprovementProposer.instance = new ImprovementProposer()
    return ImprovementProposer.instance
  }

  init(fsProvider: IFileSystemProvider, pathProvider: IPathProvider): void {
    this.fsProvider = fsProvider
    this.pathProvider = pathProvider
  }

  private sessionsDir(): string {
    return path.join(this.pathProvider!.getUserDataPath(), 'sessions')
  }

  private userDataDir(): string {
    return this.pathProvider!.getUserDataPath()
  }

  private async readWatermarks(): Promise<Record<string, number>> {
    if (!this.fsProvider) return {}
    const filePath = path.join(this.userDataDir(), WATERMARKS_FILE)
    const read = await this.fsProvider.readFile(filePath)
    if (!read.success) return {}
    try {
      const raw = read.data?.content ?? read.data ?? ''
      return JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return {}
    }
  }

  private async writeWatermarks(watermarks: Record<string, number>): Promise<void> {
    if (!this.fsProvider) return
    const filePath = path.join(this.userDataDir(), WATERMARKS_FILE)
    await this.fsProvider.writeFile(filePath, JSON.stringify(watermarks, null, 2))
  }

  /** 原子写（tmp+rename，renameFile 鸭子类型契约同 TaskStore；未实现/失败退化直写） */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    if (!this.fsProvider) return
    const tmp = `${filePath}.tmp`
    const w = await this.fsProvider.writeFile(tmp, content)
    if (w.success && typeof this.fsProvider.renameFile === 'function') {
      const r = await this.fsProvider.renameFile(tmp, filePath)
      if (r.success) return
      // rename 失败退化直写（tmp 残留容忍——下次写覆盖）
    }
    await this.fsProvider.writeFile(filePath, content)
  }

  private async appendProposals(proposals: Proposal[]): Promise<void> {
    if (!this.fsProvider) return
    const filePath = path.join(this.userDataDir(), PROPOSALS_FILE)
    const today = new Date().toISOString().split('T')[0]

    // 构建新增条目文本（单行字段经 sanitizeEntryText——R5 结构注入防线：模型输出的换行/控制字符
    // 不得伪造四区边界；理由/收益允许多行，parseSection 字段正则天然容忍）
    const lines: string[] = []
    for (const p of proposals) {
      lines.push(`- [${today}] **功能**：${sanitizeEntryText(p.功能)}`)
      lines.push(`  **组**：${sanitizeEntryText(p.标签)}`)
      lines.push(`  **理由**：${p.理由}`)
      lines.push(`  **难度**：${p.难度}`)
      lines.push(`  **收益**：${p.收益}`)
      lines.push(`  **来源**：${p.来源}`)
      lines.push('')
    }

    // 读取现有文件或创建新文件（写入一律走原子写，与 ImprovementLedger.decide 同纪律）
    const read = await this.fsProvider.readFile(filePath)
    if (read.success) {
      const content = read.data?.content ?? read.data ?? ''
      const raw = typeof content === 'string' ? content : String(content)
      // 在"待确认"标题后插入
      const marker = '## 待确认'
      const idx = raw.indexOf(marker)
      if (idx >= 0) {
        const afterMarker = idx + marker.length
        const newContent = raw.slice(0, afterMarker) + '\n' + lines.join('\n') + raw.slice(afterMarker)
        await this.atomicWrite(filePath, newContent)
      } else {
        // 文件存在但没有"待确认"区，追加
        await this.atomicWrite(filePath, raw + '\n' + lines.join('\n'))
      }
    } else {
      // 文件不存在，创建
      const header = '# 改进候选\n\n## 待确认\n'
      await this.atomicWrite(filePath, header + lines.join('\n') + '\n## 已确认\n（用户已认可，等待实施）\n\n## 已实现\n（已实施的项移入此处）\n')
    }
  }

  /** 读取最新的会话文件 */
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

  /** 读取现有 proposals.md 提取已有组名清单（供 prompt 注入） */
  private async readExistingGroups(): Promise<string[]> {
    if (!this.fsProvider) return []
    const filePath = path.join(this.userDataDir(), PROPOSALS_FILE)
    const read = await this.fsProvider.readFile(filePath)
    if (!read.success) return []
    try {
      const raw = read.data?.content ?? read.data ?? ''
      const markdown = typeof raw === 'string' ? raw : String(raw)
      return extractGroupNames(parseProposalMarkdown(markdown))
    } catch {
      return []
    }
  }

  /** 调模型提取改进建议 */
  private async extract(messages: Message[], sinceTs = 0): Promise<{ proposals: Proposal[]; lastTs: number }> {
    const empty = { proposals: [], lastTs: 0 }
    const modelName = SelectedModelsService.getInstance().getCurrentModelName()
    if (!modelName) return empty

    let lastTs = 0
    for (const m of messages) {
      const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0
      if (ts > sinceTs && ts > lastTs) lastTs = ts
    }

    const transcript = buildTranscript(messages, sinceTs)
    if (!transcript) return { proposals: [], lastTs }

    // 生成前读取现有组名清单并注入 prompt：模型优先复用，避免同义变体
    const existingGroups = await this.readExistingGroups()
    const promptMessages: Message[] = [
      { role: 'system' as Message['role'], content: buildProposePrompt(existingGroups), timestamp: new Date() },
      { role: 'user' as Message['role'], content: `【对话记录】\n${transcript}`, timestamp: new Date() },
    ]

    const response = await ModelServiceFactory.getInstance().sendChatMessage(modelName, promptMessages, {})
    return { proposals: parseProposals(response?.content ?? ''), lastTs }
  }

  /** 启动时认领：对最新会话做水位增量分析（幂等、并发去重、静默失败） */
  async proposeFromLatestSession(): Promise<ProposeResult> {
    if (this.running) return { proposed: false, skipped: true, reason: '已有分析进行中' }
    if (!this.fsProvider || !this.pathProvider) {
      return { proposed: false, skipped: true, reason: '未初始化' }
    }
    this.running = true
    try {
      const session = await this.latestSession()
      if (!session) return { proposed: false, skipped: true, reason: '无会话' }
      if (session.messages.length < 4) {
        return { proposed: false, skipped: true, reason: '会话过短' }
      }
      const watermarks = await this.readWatermarks()
      const sinceTs = (watermarks[session.id] ?? 0) - 1
      const { proposals, lastTs } = await this.extract(session.messages, sinceTs)

      if (proposals.length > 0) {
        // 来源强制覆盖为真实会话 ID（唯一编号），不依赖模型输出
        for (const p of proposals) {
          p.来源 = session.id ? `会话 #${session.id}` : p.来源 || '未知'
        }
        await this.appendProposals(proposals)
      }

      // 推进水位
      const nextWatermark = lastTs ?? (watermarks[session.id] ?? 0)
      await this.writeWatermarks({
        ...watermarks,
        [session.id]: Math.max(nextWatermark, watermarks[session.id] ?? 0),
      })

      return { proposed: true, proposals: proposals.length, lastTs }
    } catch (error) {
      return { proposed: false, error: error instanceof Error ? error.message : '分析失败' }
    } finally {
      this.running = false
    }
  }
}

export const improvementProposer = ImprovementProposer.getInstance()
