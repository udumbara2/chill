import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { EVENTS } from '../../src/utils/eventBus.ts'

/**
 * R2 自动压缩（maybeAutoCompact）引擎测试：真实 ChatEngine + fake deps（模式同 compaction.test.ts）。
 * 验证：阈值触发 / 各不触发条件（低压、窗口缺失、开关关、非交互、后台任务静默降级、压缩失败降级、abort 轮）/
 * CONTEXT_AUTO_COMPACTED 事件发出 / 手动 compactHistory 语义不回归（trigger 缺省 manual）。
 */

const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole

const D = (h: number, m: number) => new Date(2025, 0, 1, h, m)

const SUMMARY = '## 目标与意图\n自动压缩测试\n## 会话主题索引\n- 讨论（14:00–14:20）'

/** 三轮对话（满足 compactHistory 的 user ≥ 3 护栏） */
function makeHistory(): Message[] {
  return [
    { role: USER, content: '第一轮问题', timestamp: D(14, 0) },
    { role: ASSISTANT, content: '第一轮回答', timestamp: D(14, 1) },
    { role: USER, content: '第二轮问题', timestamp: D(14, 10) },
    { role: ASSISTANT, content: '第二轮回答', timestamp: D(14, 11) },
    { role: USER, content: '第三轮问题', timestamp: D(14, 20) },
    { role: ASSISTANT, content: '第三轮回答', timestamp: D(14, 21) },
  ]
}

function makeRecord(messages: Message[]): SessionRecord {
  return {
    id: 's1',
    title: 't',
    titleSource: 'default',
    messages,
    createdAt: '2025-01-01T13:00:00.000Z',
    updatedAt: '2025-01-01T13:00:00.000Z',
  }
}

interface MakeDepsOptions {
  /** 正常轮返回的实测用量（prompt/completion）；缺省低压（不触发） */
  usage?: { promptTokens: number; completionTokens: number }
  /** 模型窗口上限；undefined = 窗口未登记 */
  maxContextTokens?: number
  /** 自动压缩开关闭包（缺省开） */
  autoCompactEnabled?: () => boolean
  /** 非交互模式（缺省 null = 交互） */
  nonInteractive?: 'readonly' | 'auto' | null
  /** 压缩总结依次返回；Error 模拟失败 */
  compactionSummaries?: Array<string | Error>
}

function makeDeps(options: MakeDepsOptions = {}) {
  const compactionCalls: Message[][] = []
  const sentCalls: Message[][] = []
  const emitted: Array<{ event: string; payload: any }> = []
  let compactionIndex = 0
  const usage = options.usage ?? { promptTokens: 3000, completionTokens: 200 }
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        const first = params.messages[0]?.content
        if (typeof first === 'string' && first.includes('你是上下文压缩器')) {
          compactionCalls.push(params.messages)
          const next = options.compactionSummaries?.[compactionIndex++] ?? SUMMARY
          if (next instanceof Error) throw next
          return { content: next }
        }
        sentCalls.push(params.messages)
        return { content: 'ok', usage: { ...usage, totalTokens: usage.promptTokens + usage.completionTokens } }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () =>
        options.maxContextTokens !== undefined ? ({ maxContextTokens: options.maxContextTokens } as any) : undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: true, record: makeRecord(makeHistory()) }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: async () => ({ success: true }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => options.nonInteractive ?? null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: {
      on: () => {},
      off: () => {},
      emit: (event: string, payload: any) => {
        emitted.push({ event, payload })
      },
    },
    autoCompactEnabled: options.autoCompactEnabled,
  }
  return { deps, compactionCalls, sentCalls, emitted }
}

test('压力达阈值：轮正常结束后自动压缩触发，并发 CONTEXT_AUTO_COMPACTED 事件', async () => {
  // 占用 9500/10000 = 95% > 80%
  const { deps, compactionCalls, emitted } = makeDeps({
    usage: { promptTokens: 9300, completionTokens: 200 },
    maxContextTokens: 10000,
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.sendMessage({ text: '新一轮' })

  assert.equal(compactionCalls.length, 1, '自动压缩恰好发生一次')
  const events = emitted.filter((e) => e.event === EVENTS.CONTEXT_AUTO_COMPACTED)
  assert.equal(events.length, 1, '压缩完成事件已发出')
  assert.ok(events[0].payload?.checkpoint?.summary?.includes('自动压缩测试'), '载荷携带 checkpoint')
  assert.equal(engine.getSessionState().compactions.length, 1, 'checkpoint 已入会话状态')
  // 压缩后 lastUsage 重置（盲区：下一轮实测回填）→ 余量段隐藏
  assert.equal(engine.getContextStatus(), null)
})

test('低压不触发：占用低于阈值 → 零压缩调用', async () => {
  const { deps, compactionCalls } = makeDeps({
    usage: { promptTokens: 5000, completionTokens: 500 },
    maxContextTokens: 10000,
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.sendMessage({ text: '新一轮' })
  assert.equal(compactionCalls.length, 0)
})

test('窗口未登记不触发（宁可不压不可盲压）', async () => {
  const { deps, compactionCalls } = makeDeps({
    usage: { promptTokens: 9999, completionTokens: 1 },
    maxContextTokens: undefined,
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.sendMessage({ text: '新一轮' })
  assert.equal(compactionCalls.length, 0)
})

test('总开关关不触发（auto_compact = false）', async () => {
  const { deps, compactionCalls } = makeDeps({
    usage: { promptTokens: 9900, completionTokens: 100 },
    maxContextTokens: 10000,
    autoCompactEnabled: () => false,
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.sendMessage({ text: '新一轮' })
  assert.equal(compactionCalls.length, 0)
})

test('非交互模式（-p 单轮执行）不触发', async () => {
  for (const mode of ['readonly', 'auto'] as const) {
    const { deps, compactionCalls } = makeDeps({
      usage: { promptTokens: 9900, completionTokens: 100 },
      maxContextTokens: 10000,
      nonInteractive: mode,
    })
    const engine = new ChatEngine(deps)
    await engine.loadSession('s1')
    await engine.sendMessage({ text: '单轮' })
    assert.equal(compactionCalls.length, 0, `mode=${mode}`)
  }
})

test('后台任务在途：静默降级不抛错、不压缩（下轮再评估）', async (t) => {
  resetTaskRegistry()
  t.after(() => resetTaskRegistry())
  const { deps, compactionCalls } = makeDeps({
    usage: { promptTokens: 9900, completionTokens: 100 },
    maxContextTokens: 10000,
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  // loadSession 也有后台任务护栏：先加载会话，再注册在途任务
  getTaskRegistry().register({
    taskId: 'task-bg',
    toolCallId: 'tc-bg',
    subagentType: 'code-reviewer',
    description: '在途任务',
    batchId: 'b1',
  })
  // 正常返回（不抛）且未压缩
  await engine.sendMessage({ text: '新一轮' })
  assert.equal(compactionCalls.length, 0)
  resetTaskRegistry()
})

test('压缩失败（降级链耗尽）：静默降级不抛错，会话状态零改动', async () => {
  const { deps, compactionCalls } = makeDeps({
    usage: { promptTokens: 9900, completionTokens: 100 },
    maxContextTokens: 10000,
    compactionSummaries: [new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom')],
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.sendMessage({ text: '新一轮' }) // 不抛
  assert.ok(compactionCalls.length > 0, '压缩被尝试过')
  assert.equal(engine.getSessionState().compactions.length, 0, '失败零副作用')
})

test('abort 轮不触发自动压缩', async () => {
  const { deps, compactionCalls } = makeDeps({
    usage: { promptTokens: 9900, completionTokens: 100 },
    maxContextTokens: 10000,
  })
  // 正常轮返回前打断：callOnce 永不返回 + 立即 abort
  deps.modelCaller.callOnce = () => new Promise(() => {}) as any
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  const turn = engine.sendMessage({ text: '会被打断' })
  const start = Date.now()
  while (!engine.getSessionState().isRunning) {
    if (Date.now() - start > 3000) throw new Error('等待 running 超时')
    await new Promise((r) => setTimeout(r, 20))
  }
  engine.abort()
  const result = await turn
  assert.equal(result.aborted, true)
  assert.equal(compactionCalls.length, 0, '打断轮不追压缩')
})

test('手动 compactHistory 语义不回归：显式调用仍可用（trigger 缺省 manual）', async () => {
  const { deps, compactionCalls } = makeDeps({
    usage: { promptTokens: 1000, completionTokens: 100 },
    maxContextTokens: 10000,
  })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  const { checkpoint } = await engine.compactHistory()
  assert.ok(checkpoint.summary.includes('自动压缩测试'))
  assert.equal(compactionCalls.length, 1)
})

test('R1 接入：发送视图剪枝旧轮超大 TOOL，权威历史原样', async () => {
  // 5 轮历史：第 1-3 轮带超大 TOOL 结果（>8192），第 4-5 轮小结果
  const big = 8192 + 500
  const history: Message[] = []
  for (let i = 0; i < 5; i++) {
    const len = i < 3 ? big : 40
    history.push({ role: USER, content: `第${i + 1}轮`, timestamp: D(14, i * 2) })
    history.push({
      role: ASSISTANT,
      content: '调工具',
      toolCalls: [{ id: `tc-${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      timestamp: D(14, i * 2 + 1),
    } as Message)
    history.push({ role: 'tool' as MessageRole, content: 'x'.repeat(len), toolCallId: `tc-${i}`, timestamp: D(14, i * 2 + 1) })
    history.push({ role: ASSISTANT, content: `答${i + 1}`, timestamp: D(14, i * 2 + 1) })
  }
  const { deps, sentCalls } = makeDeps({
    usage: { promptTokens: 1000, completionTokens: 100 },
    maxContextTokens: 1000000, // 低压：只验证 R1，不触发 R2
  })
  ;(deps.sessionStore as any).load = async () => ({ success: true, record: makeRecord(history) })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.sendMessage({ text: '新一轮' })

  // 发送视图（去掉注入器 system）：旧轮大 TOOL 被剪、新轮与最近 2 轮原样
  const sent = sentCalls[sentCalls.length - 1].filter((m) => m.role !== 'system')
  const sentTool = (i: number) => sent.find((m) => (m as any).toolCallId === `tc-${i}`)
  for (const i of [0, 1, 2]) {
    const c = sentTool(i)?.content as string
    assert.ok(typeof c === 'string' && c.includes('已剪枝'), `旧轮 ${i + 1} 在发送视图中被剪`)
    assert.ok((c as string).length < big)
  }
  assert.equal(sentTool(3)?.content, 'x'.repeat(40), '保留窗口内小结果原样')
  // 权威历史不动（纯投影）
  const authoritative = engine.getHistory().find((m) => (m as any).toolCallId === 'tc-0')?.content as string
  assert.equal(authoritative.length, big, '权威历史零改动')
})
