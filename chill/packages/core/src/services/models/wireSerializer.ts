/**
 * wireSerializer.ts — 历史消息 → OpenAI 线缆格式的全函数序列化（纯函数、Node-free）。
 *
 * 边界防御第三闸（M7增量3·决策29·出口闸）：无论历史里有什么（旧版污染/手改/上游漏网），
 * 本模块保证产出【发得出去的合法请求】——"被自己的历史毒死"在构造上不可表示。
 * 合成只补结构（id 合成 / 配对 / content 类型归一），绝不发明内容；
 * 无法挽救的项丢弃并记录于 dropped。anthropic 路径不经此模块（其构造方式无 null 合并隐患）。
 */

export interface WireDropped {
  reason: string
  role?: string
}

export interface WireSerializeResult {
  messages: any[]
  dropped: WireDropped[]
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 配对完整性检查器（"全函数"的判据单源）：serializer 的输出必过此关，
 * fuzz 测试与运行时自校验共用。违反即抛——这是 serializer 自身 bug 的绊线，
 * 不是可恢复状态（请求宁可失败可见，不带病发出）。
 * 判据：role ∈ 四值；assistant.tool_calls 每项 id/name 非空字符串、arguments 为 string；
 * tool 消息 tool_call_id 非空且配对到**更早** assistant 的 toolCall id；配对一次性。
 */
export function assertWireValid(messages: any[]): void {
  const pairable = new Set<string>()
  for (const m of messages) {
    if (!m || typeof m.role !== 'string' || !VALID_ROLES.has(m.role)) {
      throw new Error(`assertWireValid: role 非法: ${String(m?.role)}`)
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!nonEmptyString(tc?.id)) throw new Error(`assertWireValid: assistant.tool_calls.id 空`)
        if (!nonEmptyString(tc?.function?.name)) throw new Error(`assertWireValid: toolCall name 空`)
        if (typeof tc?.function?.arguments !== 'string') throw new Error(`assertWireValid: arguments 非 string`)
        pairable.add(tc.id)
      }
    }
    if (m.role === 'tool') {
      if (!nonEmptyString(m.tool_call_id)) throw new Error(`assertWireValid: tool 消息缺 tool_call_id`)
      if (!pairable.has(m.tool_call_id)) throw new Error(`assertWireValid: tool_call_id 无前文配对: ${m.tool_call_id}`)
      pairable.delete(m.tool_call_id)
    }
  }
}

/** 历史（Message[] 宽型）→ 合法 OpenAI 线缆消息。永不抛错（自校验绊线除外），无法挽救的项进 dropped */
export function toOpenAIWireMessages(history: unknown[]): WireSerializeResult {
  const dropped: WireDropped[] = []
  const out: any[] = []
  const pairable = new Set<string>() // 可配对且未消费的 toolCall id（含合成 id）
  let lastToolIds: string[] = [] // 最近一条 assistant 的 toolCall id 序列（位置回退配对用）
  let toolPos = 0 // 自最近 assistant 之后已处理的 tool 消息计数（位置回退配对的游标）
  let synthCounter = 0
  // 媒体提升缓冲（2026-10-07 19:19 事故根治）：tool 位非文本块（image_url 等）无法以视觉
  // 计费形态出现在 openai 线缆的 tool 消息里——旧口径 JSON 序列化后按 base64 文本计费
  // （实测 2.93MB 截图帧 = 274 万 token 撞窗 400；480KB 小图也按 ~34 万 token 文本静默浪费、
  // 模型实际看不见）。提升为紧随工具批之后的合成 user 消息：user 位多模态数组是 openai
  // 兼容端点唯一实证的视觉通道（探针实测 677 token/图）。纯投影——历史记录零改动。
  let liftedParts: any[] = []
  const flushLifted = (): void => {
    if (liftedParts.length === 0) return
    out.push({
      role: 'user',
      content: [{ type: 'text', text: '（工具调用的媒体输出，随附供视觉参考）' }, ...liftedParts],
    })
    liftedParts = []
  }

  const messages = Array.isArray(history) ? history : []
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      dropped.push({ reason: '非对象消息' })
      continue
    }
    const msg = m as Record<string, any>
    if (typeof msg.role !== 'string' || !VALID_ROLES.has(msg.role)) {
      dropped.push({ role: String(msg.role), reason: `role 非法: ${String(msg.role)}` })
      continue
    }

    if (msg.role === 'assistant') {
      flushLifted() // 工具批结束，冲刷提升的媒体（严禁插在批内 tool 结果之间——破坏严格端点的批语义）
      const hasContent =
        msg.content &&
        ((typeof msg.content === 'string' && msg.content.trim().length > 0) ||
          (Array.isArray(msg.content) && msg.content.length > 0))
      const rawToolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
      const toolCalls: any[] = []
      for (const tc of rawToolCalls) {
        const fn = (tc && typeof tc.function === 'object' && tc.function) || {}
        if (!nonEmptyString(fn.name)) {
          dropped.push({ role: 'assistant', reason: `toolCall 缺 function.name（id=${String(tc?.id)}），连同其结果一并丢弃` })
          continue
        }
        // id 缺失 → 按序确定性合成（只补结构，绝不发明内容）
        const id = nonEmptyString(tc?.id) ? tc.id : `call_local_${synthCounter++}`
        const args =
          typeof fn.arguments === 'string'
            ? fn.arguments
            : fn.arguments === undefined || fn.arguments === null
              ? ''
              : JSON.stringify(fn.arguments)
        toolCalls.push({ ...tc, id, function: { ...fn, arguments: args } })
      }
      // 空消息判定在 toolCall 过滤之后：内容为空且工具调用全被判废 → 整条丢弃（防发出空壳 assistant）
      if (!hasContent && toolCalls.length === 0) {
        dropped.push({ role: 'assistant', reason: '空 assistant 消息（无内容且无有效工具调用）' })
        continue
      }
      const entry: any = { role: 'assistant', content: msg.content ?? '' }
      if (msg.reasoningContent != null) entry.reasoning_content = msg.reasoningContent
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls
        lastToolIds = toolCalls.map((t) => t.id)
        for (const t of toolCalls) pairable.add(t.id)
      } else {
        lastToolIds = []
      }
      toolPos = 0
      out.push(entry)
      continue
    }

    if (msg.role === 'tool') {
      // 配对：优先 tool_call_id 精确匹配（含合成 id）；缺失时按位置回退（该 assistant 后第 n 条 tool ↔ 第 n 个 toolCall）
      let pairId: string | undefined
      if (nonEmptyString(msg.toolCallId)) {
        pairId = msg.toolCallId
      } else if (lastToolIds[toolPos] !== undefined) {
        pairId = lastToolIds[toolPos]
      }
      if (pairId === undefined || !pairable.has(pairId)) {
        dropped.push({ role: 'tool', reason: `tool 消息无法配对（toolCallId=${String(msg.toolCallId)}）` })
        toolPos++
        continue
      }
      pairable.delete(pairId) // 一次性配对（同 id 第二条 tool 结果无家可归）
      toolPos++
      // content 类型归一：tool 消息线缆上必须是字符串。数组形态（工具结果携带媒体块，
      // 如 capture_screen 截图）只保留文本块拼接；非文本块进提升缓冲（见函数头注释）。
      let content: string
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const texts: string[] = []
        for (const part of msg.content) {
          if (!part || typeof part !== 'object') continue
          if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
          else liftedParts.push(part)
        }
        content = texts.join('\n')
        if (content.trim().length === 0 && liftedParts.length > 0) content = '（媒体内容已随附于下一条消息）'
      } else {
        content = JSON.stringify(msg.content ?? '')
      }
      const entry: any = { role: 'tool', content, tool_call_id: pairId }
      if (msg.reasoningContent != null) entry.reasoning_content = msg.reasoningContent
      out.push(entry)
      continue
    }

    // user / system：content 原样透传（多模态数组保留）；reasoning_content 回传对齐既有行为
    flushLifted() // 工具批结束，冲刷提升的媒体
    const entry: any = { role: msg.role, content: msg.content ?? '' }
    if (msg.reasoningContent != null) entry.reasoning_content = msg.reasoningContent
    out.push(entry)
  }

  flushLifted() // 在途轮的末条 tool 消息之后（截图结果即常见尾形态）
  assertWireValid(out)
  return { messages: out, dropped }
}
