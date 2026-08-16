import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message } from '../../src/types/models.ts'

/**
 * explicit-agent 注入器测试：真实 ChatEngine + 最小 fake deps。
 * modelCaller 逐次捕获发给模型的消息序列，断言注入器产出的 system 指令。
 */

/** 找注入器产出的点名指令（system 消息且含指令特征文本） */
function findExplicitAgentMessage(messages: Message[]): Message | undefined {
  return messages.find(
    (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('显式指定由 Subagent'),
  )
}

function makeDeps(capturedCalls: Message[][]): ChatEngineDeps {
  return {
    modelCaller: {
      callOnce: async (params) => {
        capturedCalls.push(params.messages)
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    },
    selectedModels: {
      getCurrentModelName: () => 'fake-model',
    },
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: false }),
    },
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: async () => ({ success: true }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    },
    mcpService: {
      getAggregatedOpenAITools: async () => [],
    },
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
  }
}

test('注入器: explicitAgent 存在时注入委派指令（含 subagent_type）', async () => {
  const calls: Message[][] = []
  const engine = new ChatEngine(makeDeps(calls))

  await engine.sendMessage({ text: '@code-reviewer 审查一下', explicitAgent: 'code-reviewer' })

  // 首轮调用（captured[0] 为本轮组装结果；若有第二次调用是自动标题，不带注入上下文）
  const injected = findExplicitAgentMessage(calls[0])
  assert.ok(injected, '应注入点名委派指令')
  assert.ok(typeof injected.content === 'string')
  assert.ok(injected.content.includes('subagent_type=`code-reviewer`'))
  assert.ok(injected.content.includes('不得改用其他 agent'))
  assert.ok(injected.content.includes('不要重复委派'))
  engine.dispose()
})

test('注入器: 未点名时不注入', async () => {
  const calls: Message[][] = []
  const engine = new ChatEngine(makeDeps(calls))

  await engine.sendMessage({ text: '普通消息' })

  assert.equal(findExplicitAgentMessage(calls[0]), undefined)
  engine.dispose()
})

test('注入器: per-turn 生命周期——runTurn 结束清空，下一轮不带 explicitAgent 不再注入', async () => {
  const calls: Message[][] = []
  const engine = new ChatEngine(makeDeps(calls))

  await engine.sendMessage({ text: '@code-reviewer 审查一下', explicitAgent: 'code-reviewer' })
  assert.ok(findExplicitAgentMessage(calls[0]), '第一轮应注入')

  const before = calls.length
  await engine.sendMessage({ text: '第二轮普通消息' })
  assert.equal(calls.length, before + 1)
  assert.equal(findExplicitAgentMessage(calls[before]), undefined, '第二轮不应再注入')
  engine.dispose()
})

test('注入器: plan 模式下点名仍注入（task 委派已豁免，Subagent 仅获只读工具）', async () => {
  const calls: Message[][] = []
  const engine = new ChatEngine(makeDeps(calls))

  engine.setPlanMode(true)
  await engine.sendMessage({ text: '@code-reviewer 审查一下', explicitAgent: 'code-reviewer' })

  assert.ok(findExplicitAgentMessage(calls[0]), 'plan 模式下点名仍应注入（只读委派已放行）')
  engine.dispose()
})
