import type { Message, ToolDefinition, ModelResponse, StreamCallback, ToolCall } from '../../../types/models'

/**
 * Anthropic Messages API 转换与流式处理
 * 转换规格：system 顶层化；tool_use/tool_result 块；连续 tool 结果合并（严格交替）；
 * 空 assistant 剔除；首条必须 user；image_url data URI 拆分为 base64 source 块。
 */

/** 取消息的纯文本（字符串或多模态 parts 的 text 拼接） */
function textOf(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('\n')
  }
  return ''
}

/** 拆分 data URI → { media_type, data }（整段塞入会 400） */
function splitDataUri(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!m) return null
  return { media_type: m[1], data: m[2] }
}

function safeParseJson(text: string): any {
  try { return JSON.parse(text) } catch { return {} }
}

/** content parts → Anthropic content 块数组（image 转 base64 source；video/audio 不支持跳过） */
function convertUserParts(content: Message['content']): any {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const blocks: any[] = []
  for (const part of content as any[]) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const split = splitDataUri(part.image_url.url)
      if (split) {
        blocks.push({ type: 'image', source: { type: 'base64', ...split } })
      }
    }
    // video_url / input_audio：Anthropic 无对应物，跳过（模态声明不应包含）
  }
  return blocks
}

/** 内部 Message[] → { system, messages }（严格 user/assistant 交替） */
export function convertMessagesToAnthropicFormat(messages: Message[]): { system?: string; messages: any[] } {
  const systemParts: string[] = []
  const converted: any[] = []

  const pushUser = (content: any) => {
    const last = converted[converted.length - 1]
    if (last && last.role === 'user') {
      // 相邻同角色合并（含连续 tool_result 合并）
      if (typeof last.content === 'string' && typeof content === 'string') {
        last.content = last.content + '\n' + content
      } else {
        last.content = [...(Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }]),
          ...(Array.isArray(content) ? content : [{ type: 'text', text: content }])]
      }
    } else {
      converted.push({ role: 'user', content })
    }
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      const t = textOf(msg).trim()
      if (t) systemParts.push(t)
      continue
    }
    if (msg.role === 'user') {
      pushUser(convertUserParts(msg.content))
      continue
    }
    if (msg.role === 'assistant') {
      const blocks: any[] = []
      const text = textOf(msg).trim()
      if (text) blocks.push({ type: 'text', text })
      for (const tc of msg.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments),
        })
      }
      if (blocks.length === 0) continue // 空 assistant 剔除（空 content 块数组会被拒）
      converted.push({ role: 'assistant', content: blocks })
      continue
    }
    if (msg.role === 'tool') {
      // content 为数组（工具结果携带媒体块，如 capture_screen 截图）时构造 text+image 块
      //（复用 convertUserParts：image_url data URI → base64 source 块）；字符串维持原逻辑
      const toolContent = Array.isArray(msg.content) ? convertUserParts(msg.content) : textOf(msg)
      pushUser([{ type: 'tool_result', tool_use_id: msg.toolCallId, content: toolContent }])
      continue
    }
  }

  // 首条必须 user（内部历史若以 assistant 开头则丢弃该前缀）
  while (converted.length > 0 && converted[0].role !== 'user') {
    converted.shift()
  }

  return {
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: converted,
  }
}

/** OpenAI 形状工具定义 → Anthropic 形状 */
export function convertToolsToAnthropicFormat(tools: ToolDefinition[]): any[] {
  return (tools ?? []).map((t: any) => ({
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? t.description ?? '',
    input_schema: t.function?.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
  }))
}

/**
 * R0 缓存断点应用（原地修改请求体；纯策略函数，无 IO）：
 * ① system 末块 + ② tools 末项 —— 最长稳定前缀跨轮命中（注入器已按稳定→易变重排）；
 * ③ 最后一条消息末块 —— 同轮工具循环迭代间命中（user 消息不变、TOOL 结果追加）。
 * 共 3 个断点 ≤ Anthropic 官方上限 4；cache_control 位于 content block 级，
 * string 形态的 system/content 需升格为 blocks。字段缺失（无 system/tools/messages）安全跳过。
 */
export function applyAnthropicCacheBreakpoints(body: Record<string, any>): void {
  if (typeof body.system === 'string' && body.system) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }]
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' }
  }
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1]
    if (typeof last.content === 'string') {
      last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
    } else if (Array.isArray(last.content) && last.content.length > 0) {
      last.content[last.content.length - 1].cache_control = { type: 'ephemeral' }
    }
  }
}

/** 非流式响应 → ModelResponse */
export function parseAnthropicResponse(json: any): ModelResponse {
  const textParts: string[] = []
  const toolCalls: ToolCall[] = []
  for (const block of json?.content ?? []) {
    if (block.type === 'text') {
      textParts.push(block.text ?? '')
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  return {
    content: textParts.join(''),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(json?.usage ? {
      usage: {
        promptTokens: json.usage.input_tokens ?? 0,
        completionTokens: json.usage.output_tokens ?? 0,
        totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
        ...(json.usage.cache_read_input_tokens !== undefined
          ? { cacheReadTokens: json.usage.cache_read_input_tokens }
          : {}),
        ...(json.usage.cache_creation_input_tokens !== undefined
          ? { cacheWriteTokens: json.usage.cache_creation_input_tokens }
          : {}),
      },
    } : {}),
  }
}

/** SSE 流式响应处理：逐行解析 → text 流式输出 + tool_use 跨事件累积 → 完整 ModelResponse */
export async function handleAnthropicStream(
  response: Response,
  streamCallback?: StreamCallback,
): Promise<ModelResponse> {
  if (!response.body) throw new Error('Anthropic 流式响应无 body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let text = ''
  const toolCalls: ToolCall[] = []
  let currentTool: { id: string; name: string; jsonStr: string } | null = null
  let stopReason: string | undefined
  let usage: ModelResponse['usage']
  let buffer = ''

  const finalizeCurrentTool = () => {
    if (!currentTool) return
    toolCalls.push({
      id: currentTool.id,
      type: 'function',
      function: { name: currentTool.name, arguments: currentTool.jsonStr || '{}' },
    })
    currentTool = null
  }

  const handleEvent = (data: string) => {
    if (!data.trim()) return
    let event: any
    try { event = JSON.parse(data) } catch { return }
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          finalizeCurrentTool()
          currentTool = {
            id: event.content_block.id,
            name: event.content_block.name,
            jsonStr: '',
          }
        }
        break
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta') {
          text += event.delta.text ?? ''
          streamCallback?.({ content: event.delta.text ?? '', isStreamComplete: false })
        } else if (event.delta?.type === 'input_json_delta' && currentTool) {
          currentTool.jsonStr += event.delta.partial_json ?? ''
        }
        break
      case 'content_block_stop':
        finalizeCurrentTool()
        break
      case 'message_delta':
        stopReason = event.delta?.stop_reason ?? stopReason
        if (event.usage) {
          // prompt 侧（含缓存字段）由 message_start 一次性给全；此处只更新 completion 侧
          usage = {
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: event.usage.output_tokens ?? 0,
            totalTokens: (usage?.promptTokens ?? 0) + (event.usage.output_tokens ?? 0),
            ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
            ...(usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          }
        }
        break
      case 'message_start':
        if (event.message?.usage) {
          usage = {
            promptTokens: event.message.usage.input_tokens ?? 0,
            completionTokens: event.message.usage.output_tokens ?? 0,
            totalTokens: (event.message.usage.input_tokens ?? 0) + (event.message.usage.output_tokens ?? 0),
            ...(event.message.usage.cache_read_input_tokens !== undefined
              ? { cacheReadTokens: event.message.usage.cache_read_input_tokens }
              : {}),
            ...(event.message.usage.cache_creation_input_tokens !== undefined
              ? { cacheWriteTokens: event.message.usage.cache_creation_input_tokens }
              : {}),
          }
        }
        break
      case 'error':
        throw new Error(`Anthropic 流式错误: ${JSON.stringify(event.error ?? event).slice(0, 300)}`)
      default:
        break
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line.startsWith('data:')) {
        handleEvent(line.slice(5).trim())
      }
    }
  }
  if (buffer.trim().startsWith('data:')) {
    handleEvent(buffer.trim().slice(5).trim())
  }
  finalizeCurrentTool()

  streamCallback?.({
    content: '',
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    isStreamComplete: true,
  })

  return {
    content: text,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
  }
}
