/**
 * GoalEvaluator（目标模式：独立评估器，判定与执行分离）
 *
 * 无工具、非流式的单次模型调用（deps.modelCaller.callOnce，与自动标题/压缩同通道）：
 * 输入 = 目标契约 + 最近若干轮 transcript 摘要；输出 = 结构化判定。
 * 评估器只看对话中已展示的证据（测试输出、退出码、文件事实），不信执行模型的自述。
 *
 * 失败语义：模型调用异常 / JSON 解析失败一律按 { verdict:'continue', progress:false }
 * 处理（计入无进展熔断），绝不让评估器异常打断驱动循环。
 */

import { MessageRole, type Message } from '../types/models'
import type { EngineModelCaller, GoalState } from './types'

/** 评估判定结果（progress 是熔断依据：本轮是否出现朝向判据的新证据） */
export interface GoalVerdict {
  verdict: 'achieved' | 'continue' | 'blocked'
  progress: boolean
  reason: string
}

/** 喂给评估器的最近消息条数与单条截断长度（评估只看近期证据，全量历史在执行模型侧） */
const RECENT_MESSAGE_COUNT = 12
const MESSAGE_MAX_CHARS = 600
const TRANSCRIPT_MAX_CHARS = 8000

const EVALUATOR_SYSTEM_PROMPT =
  '你是目标模式的独立评估器，不负责执行任务，只根据对话记录中的实际证据判定目标是否达成。\n' +
  '判定规则：\n' +
  '1. 只信对话中展示的证据（命令输出、退出码、文件内容等），不信助手"已完成"的自述。\n' +
  '2. verdict 取值：achieved = 完成判据已被证据满足；continue = 未达成但可继续推进；blocked = 缺少关键信息/权限或判据本身不可达，继续推进无意义。\n' +
  '3. progress：本轮对话是否出现了朝向完成判据的新证据（true/false）。continue 不等于有进展。\n' +
  '4. 只输出一个 JSON 对象，不要输出任何其他文字：{"verdict":"achieved|continue|blocked","progress":true|false,"reason":"一句话判定理由"}'

/** 评估器异常/解析失败时的保守判定（计入无进展，由熔断通道兜底） */
function fallbackVerdict(reason: string): GoalVerdict {
  return { verdict: 'continue', progress: false, reason }
}

/** 从模型输出中解析结构化判定：提取首个 JSON 对象并校验字段；任何失败走保守判定 */
export function parseGoalVerdict(text: string): GoalVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return fallbackVerdict('评估结果解析失败（未找到 JSON），本轮按无进展计')
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>
    const verdict = parsed.verdict
    if (verdict !== 'achieved' && verdict !== 'continue' && verdict !== 'blocked') {
      return fallbackVerdict('评估结果解析失败（verdict 非法），本轮按无进展计')
    }
    return {
      verdict,
      progress: parsed.progress === true,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : '（评估器未给出理由）',
    }
  } catch {
    return fallbackVerdict('评估结果解析失败（JSON 非法），本轮按无进展计')
  }
}

/** 最近若干轮消息的纯文本摘要（role 前缀 + 单条/总量截断） */
export function buildTranscriptDigest(messages: Message[]): string {
  const recent = messages.slice(-RECENT_MESSAGE_COUNT)
  const lines: string[] = []
  for (const m of recent) {
    const role =
      m.role === MessageRole.USER ? '用户' : m.role === MessageRole.ASSISTANT ? '助手' : m.role === MessageRole.TOOL ? '工具结果' : '系统'
    const text = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    lines.push(`${role}: ${text.length > MESSAGE_MAX_CHARS ? text.slice(0, MESSAGE_MAX_CHARS) + '…' : text}`)
  }
  const digest = lines.join('\n')
  // 超总量从最新往前保留（近期证据权重最高）
  return digest.length > TRANSCRIPT_MAX_CHARS ? digest.slice(digest.length - TRANSCRIPT_MAX_CHARS) : digest
}

export class GoalEvaluator {
  private readonly deps: { modelCaller: EngineModelCaller }

  constructor(deps: { modelCaller: EngineModelCaller }) {
    this.deps = deps
  }

  /**
   * 评估目标达成情况。modelName 由调用方选定（配置的评估器模型 → 回退当前会话模型）。
   * 永不抛异常：调用失败按 { verdict:'continue', progress:false } 返回。
   */
  async evaluate(params: { modelName: string; goal: GoalState; recentMessages: Message[] }): Promise<GoalVerdict> {
    const { modelName, goal, recentMessages } = params
    const goalText =
      `【目标】${goal.objective}\n【完成判据】${goal.successCriteria}\n` +
      `【轮次】已推进 ${goal.roundCount} 轮 / 上限 ${goal.maxRounds} 轮（连续无进展 ${goal.noProgressCount} 次）\n\n` +
      `【近期对话记录】\n${buildTranscriptDigest(recentMessages) || '（暂无对话记录）'}`
    try {
      const resp = await this.deps.modelCaller.callOnce({
        modelName,
        messages: [
          { role: MessageRole.SYSTEM, content: EVALUATOR_SYSTEM_PROMPT, timestamp: new Date() },
          { role: MessageRole.USER, content: goalText, timestamp: new Date() },
        ],
      })
      const text = typeof resp?.content === 'string' ? resp.content : ''
      return parseGoalVerdict(text)
    } catch {
      return fallbackVerdict('评估器调用失败，本轮按无进展计')
    }
  }
}
