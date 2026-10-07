import type { Message } from '@assistant-ai/core'

/**
 * synthetic 合成消息的折叠摘要助手（MessageItem 的提示行渲染数据源；
 * 抽为独立模块供组件与测试共用——goalTick/回流轮/定时任务三类折叠逻辑的唯一事实源）
 */

/** 合成编排消息（回流轮通知）的条目数（'- [' 行计数；synthetic 消息 content 恒为 string） */
export const syntheticTaskCount = (content: Message['content']): number => {
  const text = typeof content === 'string' ? content : ''
  return (text.match(/^- \[/gm) || []).length
}

/** goalTick 推进消息的折叠摘要（首行去掉轮次前缀，保留其余文本） */
export const goalTickSummary = (content: Message['content']): string => {
  const text = typeof content === 'string' ? content : ''
  const firstLine = text.split('\n')[0] ?? ''
  return firstLine.replace(/^【[^】]*】/, '').trim() || '目标未达成，自动续跑'
}

/**
 * 定时任务触发消息（synthetic:'scheduledTask'）的折叠摘要（goalTick 同款单行弱化展示）：
 * 信封首行是 [定时任务 <id>]，第二行起为 prompt；合并补跑时追加标注。prompt 截断防长行撑版。
 */
export const scheduledTaskSummary = (content: Message['content']): string => {
  const text = typeof content === 'string' ? content : ''
  const lines = text.split('\n')
  const promptFirstLine = (lines[1] ?? '').trim()
  const truncated = promptFirstLine.length > 60 ? `${promptFirstLine.slice(0, 60)}…` : promptFirstLine
  const coalesced = lines.some((l) => l.startsWith('（合并补跑'))
  return `${truncated || '定时触发'}${coalesced ? '（合并补跑）' : ''}`
}
