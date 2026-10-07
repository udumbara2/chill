import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'

/**
 * M0.2（多会话并行规划）守卫收窄回归：assertNoRunningBackgroundTasks 按 engineHandle 过滤——
 * ① 本引擎的 running 任务仍拦（不变量：running 任务必属其登记引擎的会话）；
 * ② 他引擎的 running 任务不拦（跨引擎无因果——多会话并行的核心解锁）；
 * ③ 无归因任务保守拦截（legacy 行为逐位不变）。
 */

function makeEngine(): ChatEngine {
  const deps: ChatEngineDeps = {
    modelCaller: { callOnce: async () => ({ content: 'ok' }) },
    modelInfo: { getModelsWithApiKeys: async () => [], getModelInfoByName: () => undefined } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      // load 恒失败：loadSession 在守卫之后才到装载——被拦场景抛在 load 前，放行场景返回 false
      load: async () => ({ success: false }),
    } as any,
    builtInToolExecutor: {} as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
  }
  return new ChatEngine(deps)
}

let seq = 0
function registerRunning(handle: string | undefined): { toolCallId: string } {
  const n = ++seq
  const toolCallId = `tc-g${n}`
  getTaskRegistry().register({
    taskId: `task-g${n}`,
    toolCallId,
    subagentType: 'general-purpose',
    description: '守卫测试任务',
    batchId: `batch-g${n}`,
    ...(handle !== undefined ? { engineHandle: handle } : {}),
  })
  return { toolCallId }
}

test('M0.2 守卫收窄：本引擎任务拦 / 他引擎任务不拦 / 无归因保守拦', async (t) => {
  resetTaskRegistry()
  t.after(() => {
    resetTaskRegistry()
  })
  const a = makeEngine()
  const b = makeEngine()
  t.after(() => {
    a.dispose()
    b.dispose()
  })

  // ① 本引擎 running 任务 → 自己的 loadSession 抛守卫错误（load 未被触达）
  const own = registerRunning(a.getScopeHandle())
  await assert.rejects(a.loadSession('s-any'), /后台任务进行中/)
  // ② 他引擎 running 任务 → B 的 loadSession 不被 A 的任务拦（返回 false = 记录不存在，未抛守卫）
  await assert.doesNotReject(b.loadSession('s-any'))
  // ③ 无归因 running 任务 → 保守拦截（legacy 行为：两个引擎都拦）
  getTaskRegistry().markSettled(own.toolCallId, { status: 'completed', final_output: 'done' })
  registerRunning(undefined)
  await assert.rejects(a.loadSession('s-any'), /后台任务进行中/)
  await assert.rejects(b.loadSession('s-any'), /后台任务进行中/)
})

test('M0.2 守卫收窄：跨引擎任务在跑时新引擎装载/本引擎 startNewSession 语义', async (t) => {
  resetTaskRegistry()
  t.after(() => {
    resetTaskRegistry()
  })
  const a = makeEngine()
  const fresh = makeEngine()
  t.after(() => {
    a.dispose()
    fresh.dispose()
  })
  registerRunning(a.getScopeHandle())
  // registry.open 装载既有会话 = 新引擎 loadSession——他引擎任务不拦（多会话并行关键路径）
  await assert.doesNotReject(fresh.loadSession('s-any'))
  // 本引擎 startNewSession 仍被自己任务拦（不变量保持）
  assert.throws(() => a.startNewSession(), /后台任务进行中/)
})
