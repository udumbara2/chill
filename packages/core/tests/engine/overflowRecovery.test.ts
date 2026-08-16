import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'
import type { SessionRecord } from '../../src/persistence/SessionPersistence.ts'
import { EVENTS } from '../../src/utils/eventBus.ts'

/**
 * R3 溢出恢复引擎测试：callOnce 报窗口超限 → 强制压缩（compactCore 绕过 running 护栏，
 * 保最小尾 keepRounds=1）→ 重组上下文重试成功 → CONTEXT_OVERFLOW_RECOVERED 事件。
 * 以及：非超限错误不触发恢复；恢复失败保留原始溢出错误上抛。
 */

const USER = 'user' as MessageRole
const ASSISTANT = 'assistant' as MessageRole

const D = (h: number, m: number) => new Date(2025, 0, 1, h, m)

const SUMMARY = '## 目标与意图\n溢出恢复测试\n## 会话主题索引\n- 讨论（14:00–14:20）'

/** 四轮对话（keepRounds=1 需 user ≥ 2；多备一轮）。前 3 轮塞大文本：保证切掉量 >> summary 长度 */
function makeHistory(): Message[] {
  const big = (tag: string) => `${tag}内容 `.repeat(2000)
  return [
    { role: USER, content: big('第一轮'), timestamp: D(14, 0) },
    { role: ASSISTANT, content: '答一', timestamp: D(14, 1) },
    { role: USER, content: big('第二轮'), timestamp: D(14, 5) },
    { role: ASSISTANT, content: '答二', timestamp: D(14, 6) },
    { role: USER, content: big('第三轮'), timestamp: D(14, 10) },
    { role: ASSISTANT, content: '答三', timestamp: D(14, 11) },
    { role: USER, content: '第四轮问题', timestamp: D(14, 15) },
    { role: ASSISTANT, content: '答四', timestamp: D(14, 16) },
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
  /** 前几次正常调用抛窗口超限（模拟满载），之后恢复成功 */
  overflowTimes?: number
  /** 压缩总结；Error 模拟恢复失败 */
  compactionSummary?: string | Error
}

function makeDeps(options: MakeDepsOptions = {}) {
  const sentCalls: Message[][] = []
  const compactionCalls: Message[][] = []
  const emitted: Array<{ event: string; payload: any }> = []
  let normalCall = 0
  let overflowLeft = options.overflowTimes ?? 1
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        const first = params.messages[0]?.content
        if (typeof first === 'string' && first.includes('你是上下文压缩器')) {
          compactionCalls.push(params.messages)
          const next = options.compactionSummary ?? SUMMARY
          if (next instanceof Error) throw next
          return { content: next }
        }
        normalCall++
        sentCalls.push(params.messages)
        if (overflowLeft > 0) {
          overflowLeft--
          throw new Error(
            "This model's maximum context length is 128000 tokens. Error code: context_length_exceeded"
          )
        }
        return { content: 'ok', usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => ({ maxContextTokens: 100000 }) as any,
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
      getNonInteractiveMode: () => null,
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
  }
  return { deps, sentCalls, compactionCalls, emitted, getNormalCallCount: () => normalCall }
}

test('溢出闭环：callOnce 超限 → 强制压缩（running 中，绕护栏）→ 重组重试成功 → 事件发出', async () => {
  const { deps, sentCalls, compactionCalls, emitted } = makeDeps({ overflowTimes: 1 })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await engine.sendMessage({ text: '触发溢出' }) // 不抛：恢复后重试成功

  assert.equal(compactionCalls.length, 1, '强制压缩恰好一次')
  // 恢复发生在 running=true 期间（绕过 running 护栏）——能走通即证明
  const events = emitted.filter((e) => e.event === EVENTS.CONTEXT_OVERFLOW_RECOVERED)
  assert.equal(events.length, 1, '恢复事件已发出')
  assert.ok(events[0].payload?.checkpoint?.summary?.includes('溢出恢复测试'))
  // checkpoint 已落会话状态；keepRounds=1：切点后只保留最后 1 轮 user（第 4 轮 + 本轮新消息）
  assert.equal(engine.getSessionState().compactions.length, 1)
  // 重试的第二次发送视图 = 合成摘要 + 最小尾（比第一次短）
  assert.ok(sentCalls.length >= 2, 'callOnce 被重试')
  const firstLen = sentCalls[0].reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
  const retryLen = sentCalls[sentCalls.length - 1].reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
  assert.ok(retryLen < firstLen, '重试的发送视图显著变短（checkpoint 切片生效）')
})

test('非超限错误不触发恢复：原始错误照常上抛', async () => {
  const { deps, compactionCalls } = makeDeps()
  ;(deps.modelCaller as any).callOnce = async (params: any) => {
    const first = params.messages[0]?.content
    if (typeof first === 'string' && first.includes('你是上下文压缩器')) {
      return { content: SUMMARY }
    }
    throw new Error('网络连接失败')
  }
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await assert.rejects(engine.sendMessage({ text: '触发网络错误' }), /网络连接失败/)
  assert.equal(compactionCalls.length, 0, '非超限不压缩')
})

test('恢复失败：保留原始溢出错误上抛（不暴露压缩内部错误）', async () => {
  const { deps } = makeDeps({ compactionSummary: new Error('压缩内部失败') })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await assert.rejects(
    engine.sendMessage({ text: '触发溢出' }),
    /context_length_exceeded/,
    '上抛的是原始溢出错误'
  )
})

test('连续溢出（重试后仍超限）：不无限循环，第二次失败上抛', async () => {
  const { deps, compactionCalls } = makeDeps({ overflowTimes: 99 })
  const engine = new ChatEngine(deps)
  await engine.loadSession('s1')
  await assert.rejects(engine.sendMessage({ text: '触发持续溢出' }), /context_length_exceeded/)
  assert.equal(compactionCalls.length, 1, '恢复只尝试一次（有界重试）')
})
