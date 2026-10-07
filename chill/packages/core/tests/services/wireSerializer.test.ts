import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toOpenAIWireMessages, assertWireValid } from '../../src/services/models/wireSerializer.ts'

const T = (s: number) => `2026-09-26T05:03:${String(s).padStart(2, '0')}.000Z`

/** 事故实证形态（会话 1790344238830-ro7xyr idx65-68 最小复刻） */
function incidentHistory(): any[] {
  return [
    { role: 'user', content: '组一个团队…', timestamp: T(22) },
    {
      role: 'assistant',
      content: '',
      timestamp: T(55),
      toolCalls: [
        { index: 0, id: null, type: 'function', function: { arguments: '{"action":"post","title":"查当前时间"}', name: null } },
        { index: 1, id: null, type: 'function', function: { arguments: '{"action":"post","title":"查新闻"}', name: null } },
      ],
    },
    { role: 'tool', content: '工具调用失败: 未找到工具: null', timestamp: T(55), toolCallId: null },
    { role: 'tool', content: '工具调用失败: 未找到工具: null', timestamp: T(55), toolCallId: null },
  ]
}

test('事故形态：name 空的 toolCall 与其结果一并丢弃，输出仍合法（会话不再被历史毒死）', () => {
  const { messages, dropped } = toOpenAIWireMessages(incidentHistory())
  assert.doesNotThrow(() => assertWireValid(messages))
  assert.equal(messages.length, 1) // 只剩 user
  assert.equal(messages[0].role, 'user')
  // 2 个 name 空的 toolCall + 2 条配不上的 tool 消息，全部记录在案
  assert.equal(dropped.filter((d) => d.reason.includes('function.name')).length, 2)
  assert.equal(dropped.filter((d) => d.reason.includes('无法配对')).length, 2)
})

test('id 缺失但 name 完好：确定性合成 call_local_N，后续 tool 消息按位置回退配对', () => {
  const { messages, dropped } = toOpenAIWireMessages([
    {
      role: 'assistant',
      content: '',
      timestamp: T(1),
      toolCalls: [
        { type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }, // 无 id
        { type: 'function', function: { name: 'write_file', arguments: '{}' } }, // 无 id
      ],
    },
    { role: 'tool', content: 'r1', timestamp: T(2), toolCallId: undefined }, // 无 toolCallId → 位置配对
    { role: 'tool', content: 'r2', timestamp: T(3), toolCallId: null }, // 同上
  ])
  assert.doesNotThrow(() => assertWireValid(messages))
  const assistant = messages.find((m: any) => m.role === 'assistant')
  assert.deepEqual(assistant.tool_calls.map((t: any) => t.id), ['call_local_0', 'call_local_1'])
  assert.deepEqual(messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id), ['call_local_0', 'call_local_1'])
  assert.equal(dropped.length, 0)
})

test('toolCallId 精确匹配优先（含混合：一条精确一条位置回退）', () => {
  const { messages } = toOpenAIWireMessages([
    {
      role: 'assistant',
      content: '',
      timestamp: T(1),
      toolCalls: [
        { id: 'call_A', type: 'function', function: { name: 'f1', arguments: '{}' } },
        { id: 'call_B', type: 'function', function: { name: 'f2', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: '先到的是 B 的结果', timestamp: T(2), toolCallId: 'call_B' },
    { role: 'tool', content: '位置回退拿第一个', timestamp: T(3), toolCallId: undefined }, // lastToolIds[1] 已消费？——位置回退取 lastToolIds[toolPos]
  ])
  // 注意：位置回退按"第 n 条 tool ↔ 第 n 个 toolCall"，此处第 2 条 tool 位置回退到 call_B，
  // 但 call_B 已被精确匹配消费 → 该条被丢弃（一次性配对）。输出仍然合法：
  assert.doesNotThrow(() => assertWireValid(messages))
  const tools = messages.filter((m: any) => m.role === 'tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].tool_call_id, 'call_B')
})

test('一次性配对：同 id 的第二条 tool 结果丢弃；前向引用（tool 在 assistant 之前）丢弃', () => {
  const { messages, dropped } = toOpenAIWireMessages([
    { role: 'tool', content: '早产的结果', timestamp: T(0), toolCallId: 'call_A' },
    {
      role: 'assistant',
      content: '',
      timestamp: T(1),
      toolCalls: [{ id: 'call_A', type: 'function', function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', content: 'r1', timestamp: T(2), toolCallId: 'call_A' },
    { role: 'tool', content: 'r2 冒充', timestamp: T(3), toolCallId: 'call_A' },
  ])
  assert.doesNotThrow(() => assertWireValid(messages))
  assert.equal(messages.filter((m: any) => m.role === 'tool').length, 1)
  assert.equal(dropped.length, 2)
})

test('类型与角色防线：role 垃圾丢弃、空 assistant 丢弃、tool content 数组归一为字符串、arguments 非字符串序列化', () => {
  const { messages, dropped } = toOpenAIWireMessages([
    { role: 'toolx', content: 'x', timestamp: T(0) },
    { role: 'assistant', content: '   ', timestamp: T(1) }, // 空文本无工具调用 → 丢弃（对齐旧过滤行为）
    {
      role: 'assistant',
      content: '',
      timestamp: T(2),
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: { a: 1 } as any } }], // arguments 对象
    },
    { role: 'tool', content: [{ type: 'text', text: '多模态结果' }] as any, timestamp: T(3), toolCallId: 'c1' },
    { role: 'user', content: [{ type: 'text', text: '多模态输入' }] as any, timestamp: T(4) },
  ])
  assert.doesNotThrow(() => assertWireValid(messages))
  const assistant = messages.find((m: any) => m.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.arguments, '{"a":1}')
  const tool = messages.find((m: any) => m.role === 'tool')
  assert.equal(typeof tool.content, 'string')
  assert.ok(tool.content.includes('多模态结果'))
  const user = messages.find((m: any) => m.role === 'user')
  assert.ok(Array.isArray(user.content)) // user 多模态原样保留
  assert.equal(dropped.length, 2)
})

test('reasoning_content 回传对齐既有行为（各角色均可携带）', () => {
  const { messages } = toOpenAIWireMessages([
    { role: 'assistant', content: '答', reasoningContent: '想', timestamp: T(1) },
    {
      role: 'assistant',
      content: '',
      reasoningContent: '想2',
      timestamp: T(2),
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '' } }],
    },
    { role: 'tool', content: 'r', reasoningContent: 't', timestamp: T(3), toolCallId: 'c1' },
  ])
  assert.equal(messages[0].reasoning_content, '想')
  assert.equal(messages[1].reasoning_content, '想2')
  assert.equal(messages[2].reasoning_content, 't')
})

// ---------- fuzz：随机破坏历史，输出必须始终合法 ----------

/** 确定性 LCG（可复现） */
function lcg(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x))
}

test('fuzz：500 轮随机破坏（挖空/置 null/乱序/重复/注入垃圾）→ 输出必过 assertWireValid 且永不抛错', () => {
  const rand = lcg(20260926)
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
  for (let round = 0; round < 500; round++) {
    const h = clone(incidentHistory())
    h.push(
      { role: 'assistant', content: '正常回复', toolCalls: [{ id: 'call_ok', type: 'function', function: { name: 'ok', arguments: '{}' } }], timestamp: T(80) },
      { role: 'tool', content: 'ok 结果', toolCallId: 'call_ok', timestamp: T(81) },
      { role: 'user', content: '继续', timestamp: T(82) },
    )
    // 随机破坏 0-6 处
    const mutations = Math.floor(rand() * 7)
    for (let i = 0; i < mutations; i++) {
      const target = pick(h) as any
      const action = Math.floor(rand() * 6)
      switch (action) {
        case 0: target.role = pick(['user', 'tool', 'garbage', undefined, 42]) as any; break
        case 1:
          if (Array.isArray(target.toolCalls) && target.toolCalls.length > 0) pick(target.toolCalls).id = pick([null, '', undefined])
          break
        case 2:
          if (Array.isArray(target.toolCalls) && target.toolCalls.length > 0) pick(target.toolCalls).function = { ...pick(target.toolCalls).function, name: pick([null, '', ' ']) }
          break
        case 3: target.toolCallId = pick([null, '', undefined, 'call_ghost']); break
        case 4: target.content = pick([null, undefined, '', [{ type: 'text', text: 'x' }]]) as any; break
        case 5:
          if (Array.isArray(target.toolCalls)) target.toolCalls = pick([undefined, null, {}, 'x']) as any
          break
      }
    }
    // 随机排序若干次（打乱配对顺序）
    if (rand() < 0.3) h.sort(() => rand() - 0.5)
    // 注入垃圾项
    if (rand() < 0.2) h.push(pick([null, 42, 'x', {}]) as any)
    // 永不抛错 + 输出必合法
    const { messages } = toOpenAIWireMessages(h)
    assert.doesNotThrow(() => assertWireValid(messages), `round=${round}`)
  }
})

// ===== 媒体提升（2026-10-07 19:19 事故根治）：tool 位媒体块 → 紧随工具批的合成 user 消息 =====

const IMG = (n: string) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${n}` } })
const CALL = (id: string, name = 'capture_screen') => ({
  role: 'assistant',
  content: '',
  timestamp: T(1),
  toolCalls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
})

test('媒体提升：tool 数组只留文本，image_url 提升为批后合成 user 消息（视觉计费通道）', () => {
  const { messages, dropped } = toOpenAIWireMessages([
    { role: 'user', content: '截图', timestamp: T(0) },
    CALL('call_s'),
    {
      role: 'tool',
      timestamp: T(2),
      toolCallId: 'call_s',
      content: [{ type: 'text', text: '截图尺寸 1280×853' }, IMG('AAAA')],
    },
    { role: 'assistant', content: '看到了', timestamp: T(3) },
  ])
  assert.doesNotThrow(() => assertWireValid(messages))
  assert.equal(dropped.length, 0)
  const tool = messages.find((m: any) => m.role === 'tool')
  assert.equal(tool.content, '截图尺寸 1280×853', 'tool 位只留文本')
  assert.ok(!tool.content.includes('AAAA'), 'base64 绝不进 tool content（文本计费爆炸源）')
  // 提升消息位置：工具批之后、下一条 assistant 之前
  const liftIdx = messages.findIndex((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url'))
  const toolIdx = messages.indexOf(tool)
  const assistantIdx = messages.findIndex((m: any) => m.role === 'assistant' && m.content === '看到了')
  assert.ok(liftIdx > toolIdx && liftIdx < assistantIdx, `提升消息夹在工具批与后续消息之间（${toolIdx}<${liftIdx}<${assistantIdx}）`)
  const lift = messages[liftIdx]
  assert.equal(lift.content[0].type, 'text', '合成消息带文本引导')
  assert.equal(lift.content[1].image_url.url, 'data:image/png;base64,AAAA', '图片原样随附')
})

test('媒体提升：同批多条 tool 媒体合并为一条合成 user 消息；批内不插队', () => {
  const { messages } = toOpenAIWireMessages([
    CALL('c1'),
    { role: 'tool', timestamp: T(2), toolCallId: 'c1', content: [{ type: 'text', text: 't1' }, IMG('AAA')] },
    { role: 'tool', timestamp: T(3), toolCallId: 'c2', content: [{ type: 'text', text: 't2' }, IMG('BBB')] },
    { role: 'assistant', content: 'done', timestamp: T(4) },
  ].map((m: any, i: number) => (m.role === 'assistant' && i === 0 ? {
    ...m,
    toolCalls: [
      { id: 'c1', type: 'function', function: { name: 'capture_screen', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'capture_screen', arguments: '{}' } },
    ],
  } : m)))
  assert.doesNotThrow(() => assertWireValid(messages))
  const lifts = messages.filter((m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url'))
  assert.equal(lifts.length, 1, '同批合并为一条')
  assert.equal(lifts[0].content.filter((p: any) => p?.type === 'image_url').length, 2, '两图都在')
  const t1 = messages.findIndex((m: any) => m.role === 'tool' && m.content === 't1')
  const t2 = messages.findIndex((m: any) => m.role === 'tool' && m.content === 't2')
  const liftIdx = messages.indexOf(lifts[0])
  assert.ok(t2 < liftIdx, '合成消息在批内全部 tool 结果之后（不插队）')
  assert.ok(t1 < t2)
})

test('媒体提升：消息流以 tool 媒体结尾（在途截图轮常态）→ 末尾冲刷', () => {
  const { messages } = toOpenAIWireMessages([
    { role: 'user', content: '看桌面', timestamp: T(0) },
    CALL('call_s'),
    { role: 'tool', timestamp: T(2), toolCallId: 'call_s', content: [{ type: 'text', text: 'ok' }, IMG('CCCC')] },
  ])
  assert.doesNotThrow(() => assertWireValid(messages))
  const last = messages[messages.length - 1]
  assert.equal(last.role, 'user', '末条是合成 user 消息')
  assert.ok(Array.isArray(last.content) && last.content.some((p: any) => p?.type === 'image_url'))
})

test('媒体提升：纯文本数组拼接、无媒体则不产生合成消息；字符串 content 逐字节不变', () => {
  const { messages } = toOpenAIWireMessages([
    CALL('c1'),
    { role: 'tool', timestamp: T(2), toolCallId: 'c1', content: [{ type: 'text', text: '第一行' }, { type: 'text', text: '第二行' }] },
  ])
  assert.equal(messages.filter((m: any) => m.role === 'user').length, 0, '无媒体零合成')
  assert.equal(messages.find((m: any) => m.role === 'tool')?.content, '第一行\n第二行')

  const { messages: m2 } = toOpenAIWireMessages([
    CALL('c1'),
    { role: 'tool', timestamp: T(2), toolCallId: 'c1', content: '原样字符串结果' },
  ])
  assert.equal(m2.find((m: any) => m.role === 'tool')?.content, '原样字符串结果')
})

test('媒体提升：空文本+纯图数组 → 占位说明文本；object content 仍 JSON 序列化（既有行为）', () => {
  const { messages } = toOpenAIWireMessages([
    CALL('c1'),
    { role: 'tool', timestamp: T(2), toolCallId: 'c1', content: [IMG('DDDD')] },
    { role: 'assistant', content: 'end', timestamp: T(3) },
  ])
  const tool = messages.find((m: any) => m.role === 'tool')
  assert.equal(tool.content, '（媒体内容已随附于下一条消息）')

  const { messages: m2 } = toOpenAIWireMessages([
    CALL('c1'),
    { role: 'tool', timestamp: T(2), toolCallId: 'c1', content: { odd: true } },
  ])
  assert.equal(m2.find((m: any) => m.role === 'tool')?.content, '{"odd":true}')
})
