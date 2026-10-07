/**
 * 模型分层：kind 是派生值，不是存储字段
 *
 * 模型叫什么不决定它是什么，走哪条线协议才决定。
 * kind 决定使用面分流：
 * - 'chat'     → /model list、/model switch、自动选择候选集（一等公民）
 * - '*-gen'    → 不进切换列表，经 generate_<模态> 工具使用
 *
 * 派生顺序：① 生成家族注册表（单一事实源） ② chat protocol 映射表 ③ 名称启发式兜底
 * 本模块必须保持无 node 依赖（Vue renderer 共用）
 */

import { generationFamilies } from './handlers/asyncTask/generationFamilies'

export type ModelKind = 'chat' | 'image-gen' | 'video-gen' | 'audio-gen'

/** chat protocol → kind 映射表（生成家族见 generationFamilies） */
const CHAT_PROTOCOLS: Record<string, ModelKind> = {
  'openai-chat': 'chat',
  'anthropic-messages': 'chat',
}

export function deriveModelKind(protocol?: string): ModelKind {
  if (!protocol) return 'chat'
  // ① 生成家族注册表（单一事实源）
  const family = generationFamilies[protocol]
  if (family) return family.kind
  // ② chat 映射
  const chat = CHAT_PROTOCOLS[protocol]
  if (chat) return chat
  // ③ 名称启发式兜底（未登记的自定义 protocol）
  const p = protocol.toLowerCase()
  if (p.includes('video')) return 'video-gen'
  if (p.includes('image')) return 'image-gen'
  if (p.includes('audio') || p.includes('tts')) return 'audio-gen'
  return 'chat'
}
