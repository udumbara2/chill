import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactMessages,
  parseTopicIndex,
  formatTranscript,
  computeTranscriptBudgetTokens,
  buildThinkingOffOverrides,
} from '../../src/services/compaction/compactionService.ts'
import type { Message, MessageRole, ModelInfo } from '../../src/types/models.ts'

// MessageRole 是 enum（不可经 node 类型擦除运行时导入），测试里用字符串字面量替代
const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole
const TOOL = 'tool' as MessageRole

/** 本地时区构造（转录时间戳用本地 HH:MM） */
const D = (h: number, m: number) => new Date(2025, 0, 1, h, m)

function msg(role: MessageRole, time: Date, content: string, extra?: Partial<Message>): Message {
  return { role, content, timestamp: time, ...extra }
}

const VALID_SUMMARY = `## 目标与意图
测试目标
## 会话主题索引
- 首轮讨论（14:00–14:05）`

test('formatTranscript：时间戳前缀、媒体占位、toolCalls 折叠、TOOL 内容截断、时间间隙辅助线', () => {
  const transcript = formatTranscript(
    [
      msg(USER, D(14, 0), '看图说话', {
        content: [
          { type: 'text', text: '看图说话' },
          { type: 'image_url', image_url: { url: 'file://x.png' } },
        ],
      } as any),
      msg(ASSISTANT, D(14, 1), '分析中', {
        toolCalls: [{ id: 'tc-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      } as any),
      msg(TOOL, D(14, 2), 'x'.repeat(100), { toolCallId: 'tc-1' }),
      msg(USER, D(15, 0), '间隔后的新问题'),
    ],
    { maxMsgChars: 8000, maxToolChars: 10, timeGaps: true }
  )
  const lines = transcript.split('\n')
  assert.match(lines[0], /^\[14:00\] 用户: 看图说话 \[图片\]$/)
  assert.match(lines[1], /^\[14:01\] 助手: 分析中 \[调用工具: read_file\]$/)
  // TOOL 消息保留内容截断版（maxToolChars=10），不是纯折叠
  assert.equal(lines[2], `[14:02] 工具: ${'x'.repeat(10)}`)
  // 14:02 → 15:00 间隔 58 分钟 > 30 分钟：插辅助线
  assert.match(lines[3], /^──── 时间间隔 1\.0h ────$/)
  assert.match(lines[4], /^\[15:00\] 用户: 间隔后的新问题$/)
})

test('formatTranscript：跨日消息用 [MM-DD HH:MM] 前缀', () => {
  const prevDay = msg(USER, new Date(2024, 11, 31, 23, 0), '跨日前')
  const nextDay = msg(ASSISTANT, new Date(2025, 0, 1, 0, 30), '跨日后')
  const transcript = formatTranscript([prevDay, nextDay], { maxMsgChars: 100, maxToolChars: 100 })
  const lines = transcript.split('\n')
  assert.match(lines[0], /^\[12-31 23:00\] 用户:/)
  assert.match(lines[1], /^\[00:30\] 助手:/)
})

test('parseTopicIndex：合规矩阵原样保留；缺失/乱序时机械兜底（按时间间隙切段）', () => {
  const messages = [
    msg(USER, D(14, 0), '讨论写边界审批设计的方案细节，这句话很长会被截断到三十字'),
    msg(ASSISTANT, D(14, 1), '答复一'),
    msg(USER, D(17, 0), '换个话题聊部署'), // 与上一段间隔 ~3h → 独立段
  ]

  // 合规索引：原样保留
  const kept = parseTopicIndex(VALID_SUMMARY, messages)
  assert.ok(kept.includes('- 首轮讨论（14:00–14:05）'))

  // 无索引节：追加机械兜底（段名取首条用户消息前 30 字，时间取段首尾）
  const fallback = parseTopicIndex('## 目标与意图\n只有正文', messages)
  assert.ok(fallback.includes('## 会话主题索引'))
  assert.ok(fallback.includes(`（14:00–14:01）`))
  assert.ok(fallback.includes('- 换个话题聊部署（17:00–17:00）'))

  // 乱序索引：整体降级为机械兜底
  const disordered = parseTopicIndex(
    '## 会话主题索引\n- 晚段（17:00–17:05）\n- 早段（14:00–14:05）',
    messages
  )
  assert.ok(disordered.includes('- 换个话题聊部署（17:00–17:00）'))
  assert.ok(!disordered.includes('- 晚段'))
})

test('compactMessages：预算充足一次成功；prevSummary 与引导语拼入 prompt', async () => {
  const calls: Message[][] = []
  const summary = await compactMessages(
    '旧总结内容',
    [msg(USER, D(14, 0), '新增问题'), msg(ASSISTANT, D(14, 1), '新增答复')],
    async (messages) => {
      calls.push(messages)
      return VALID_SUMMARY
    },
    '重点保留接口设计',
    10_000_000
  )
  assert.ok(summary)
  assert.equal(calls.length, 1)
  const userContent = calls[0][1].content as string
  assert.ok(userContent.includes('【此前压缩摘要】\n旧总结内容'))
  assert.ok(userContent.includes('【新增对话转录】'))
  assert.ok(userContent.includes('【用户引导语（压缩侧重点）】\n重点保留接口设计'))
})

test('compactMessages 降级链：超预算跳过模型调用直降档，末档仍超也尝试一次', async () => {
  const big = '长'.repeat(500)
  const messages = [
    msg(USER, D(14, 0), `组1-${big}`),
    msg(ASSISTANT, D(14, 1), big),
    msg(USER, D(15, 0), `组2-${big}`),
    msg(ASSISTANT, D(15, 1), big),
  ]
  const transcripts: string[] = []
  const summary = await compactMessages(
    undefined,
    messages,
    async (messages) => {
      transcripts.push(messages[1].content as string)
      return VALID_SUMMARY
    },
    undefined,
    100 // 极小预算：所有档位转录都超，只有末档会真正调用模型
  )
  assert.ok(summary)
  // 只有末档（丢 3 组后）调用了模型
  assert.equal(transcripts.length, 1)
  // 末档丢了最旧轮次组：组1 不在转录里，组2 在
  assert.ok(!transcripts[0].includes('组1'))
  assert.ok(transcripts[0].includes('组2'))
})

test('compactMessages 降级链：模型调用失败逐档重试，全失败返回 null', async () => {
  const messages = [msg(USER, D(14, 0), '问题'), msg(ASSISTANT, D(14, 1), '答复')]
  let attempts = 0
  const ok = await compactMessages(
    undefined,
    messages,
    async () => {
      attempts++
      if (attempts === 1) throw new Error('context overflow')
      return VALID_SUMMARY
    },
    undefined,
    10_000_000
  )
  assert.ok(ok)
  assert.equal(attempts, 2)

  let failAttempts = 0
  const failed = await compactMessages(
    undefined,
    messages,
    async () => {
      failAttempts++
      throw new Error('always fails')
    },
    undefined,
    10_000_000
  )
  assert.equal(failed, null)
  assert.equal(failAttempts, 6) // 3 档收紧截断 + 3 档丢轮次组
})

test('buildThinkingOffOverrides：判定序 glm-5.3+ → 声明开关 → 声明档位首档 → 旧 glm → 不动', () => {
  const withThinking = {
    supportedParameters: [{ name: 'thinking', type: 'object', description: '', required: false }],
  } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(withThinking), { thinking: false })

  const withQwenSwitch = {
    supportedParameters: [{ name: 'enable_thinking', type: 'boolean', description: '', required: false }],
  } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(withQwenSwitch), { enable_thinking: false })

  const withEffort = {
    supportedParameters: [{ name: 'reasoning_effort', type: 'string', description: '', required: false }],
  } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(withEffort), { reasoning_effort: 'low' })

  // ④ 声明驱动取最低档：enumValues 首档（升序约定）
  const withEffortEnum = {
    supportedParameters: [{ name: 'reasoning_effort', type: 'string', description: '', required: false, enumValues: ['none', 'low', 'high', 'max'] }],
  } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(withEffortEnum), { reasoning_effort: 'none' })

  // ① glm-5.3+ 无视陈旧 thinking 声明（物化副本防 400：官方只收 enabled）
  const glm53StaleThinking = {
    name: 'glm-5.3',
    supportedParameters: [{ name: 'thinking', type: 'object', description: '', required: false }],
  } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(glm53StaleThinking), { reasoning_effort: 'low' })

  const glm53Fresh = {
    name: 'glm-5.3',
    supportedParameters: [{ name: 'reasoning_effort', type: 'string', description: '', required: false, enumValues: ['low', 'high', 'max'] }],
  } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(glm53Fresh), { reasoning_effort: 'low' })

  // ⑤ 旧版 glm 名字匹配 → 关；⑥ 端点级但无版本号 → 不动（猜错两头 400，宁可不覆盖）
  const glmOld = { name: 'glm-4.6', supportedParameters: [] } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(glmOld), { thinking: false })

  const plain = { supportedParameters: [] } as unknown as ModelInfo
  assert.deepEqual(buildThinkingOffOverrides(plain), {})
  assert.deepEqual(buildThinkingOffOverrides(undefined), {})
})

test('computeTranscriptBudgetTokens：窗口驱动、token 口径（准入估算器同源），未知窗口按 128k 兜底', () => {
  assert.equal(computeTranscriptBudgetTokens(200000), 200000 - 16384 - 2000)
  assert.equal(computeTranscriptBudgetTokens(undefined), 128000 - 16384 - 2000)
  // 极小窗口有下限保护
  assert.equal(computeTranscriptBudgetTokens(5000), 10000)
})
