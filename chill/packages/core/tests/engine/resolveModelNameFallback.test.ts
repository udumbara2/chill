import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'

/**
 * resolveModelName 自动兜底的 deprecated 过滤（迭代 4）：
 * - 自动兜底跳过 deprecated 退役卡（选首个有 key 的非退役 chat 模型）
 * - 用户显式选定（current-model-name）的 deprecated 卡照常生效
 * - 仅剩 deprecated 卡有 key 时兜底不自动选用退役卡
 * 真实 ChatEngine + 最小 fake deps（模式参考 frontAgent.test.ts）
 */

interface FakeDepsOptions {
  models: any[]
  currentModel?: string | null
}

function makeDeps(opts: FakeDepsOptions) {
  const calls: Array<{ modelName: string }> = []
  const saved: string[] = []
  const deps = {
    modelCaller: {
      callOnce: async (params: any) => {
        calls.push({ modelName: params.modelName })
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => opts.models,
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: {
      getCurrentModelName: () => opts.currentModel ?? null,
      saveCurrentModelName: (n: string) => { saved.push(n) },
    } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () => ({ success: false }),
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
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
  } as unknown as ChatEngineDeps
  return { deps, calls, saved }
}

const chat = (name: string, extra: any = {}) => ({ name, adapterConfig: { protocol: 'openai-chat' }, ...extra })

test('自动兜底跳过 deprecated：选首个有 key 的非退役 chat 模型', async (t) => {
  const { deps, calls, saved } = makeDeps({
    models: [chat('old-deprecated', { deprecated: true }), chat('new-normal')],
  })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  await engine.sendMessage({ text: '你好' })
  assert.equal(calls[0].modelName, 'new-normal')
  assert.deepEqual(saved, ['new-normal'], '兜底结果写回 current')
})

test('显式选定 deprecated 卡照常生效（current 分支不过滤）', async (t) => {
  const { deps, calls } = makeDeps({
    models: [chat('new-normal')],
    currentModel: 'old-deprecated',
  })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  await engine.sendMessage({ text: '你好' })
  assert.equal(calls[0].modelName, 'old-deprecated')
})

test('仅剩 deprecated 卡有 key 时兜底不自动选用退役卡', async (t) => {
  const { deps } = makeDeps({ models: [chat('old-deprecated', { deprecated: true })] })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  await assert.rejects(() => engine.sendMessage({ text: '你好' }), /未检测到已配置 API Key/)
})
