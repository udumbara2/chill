import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { Message, MessageRole } from '../../src/types/models.ts'

/**
 * 合成留痕消息（appendSyntheticMessage）测试：真实 ChatEngine + 最小 fake deps（模式同 taskReflow.test.ts）。
 * 覆盖：空闲即入史 / 轮次进行中延迟落史（flush 位置在 tool 结果之后）/ 会话切换清空队列。
 *
 * enum（MessageRole）不可运行时导入，一律字符串字面量。
 */

const USER = 'user' as MessageRole
const TOOL = 'tool' as MessageRole

const LANDING = '[任务列表] 2/2\n  ✓ 任务一\n  ✓ 任务二'

interface MakeDepsOptions {
  onCall?: (messages: Message[], callIndex: number) => Promise<any> | any
  executeAsync?: () => Promise<{ success: boolean; data?: any; error?: string }>
}

function makeDeps(options: MakeDepsOptions = {}) {
  const calls: Message[][] = []
  const state = { saves: 0 }
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        calls.push(params.messages)
        if (options.onCall) return options.onCall(params.messages, calls.length - 1)
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => {
        state.saves++
        return { success: true }
      },
      load: async () => ({ success: false }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: options.executeAsync ?? (async () => ({ success: true })),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
  }
  return { deps, calls, state }
}

test('空闲引擎：appendSyntheticMessage 立即入史 + notify + 落盘', async () => {
  const { deps, state } = makeDeps()
  const engine = new ChatEngine(deps)
  let notifies = 0
  engine.onMessagesChanged = () => notifies++

  const savesBefore = state.saves
  engine.appendSyntheticMessage(LANDING, 'todoLanding')

  const history = engine.getHistory()
  assert.equal(history.length, 1)
  assert.equal(history[0].synthetic, 'todoLanding')
  assert.equal(history[0].role, USER)
  assert.equal(history[0].content, LANDING)
  assert.equal(notifies, 1, '入史后须触发一次 onMessagesChanged')
  assert.ok(state.saves > savesBefore, '空闲入史须触发落盘')
  engine.dispose()
})

test('轮次进行中：留痕先入队不当场入史，tool 结果入史后 flush 到其后（邻接格式约束）', async () => {
  let engine!: ChatEngine
  let historyDuringExec: Message[] = []
  const { deps } = makeDeps({
    onCall: (_m, i) =>
      i === 0
        ? {
            content: '',
            toolCalls: [
              {
                id: 'tc-1',
                type: 'function',
                function: { name: 'task', arguments: '{"task_id":"t1","subagent_type":"code-reviewer","task_description":"审查"}' },
              },
            ],
          }
        : { content: '收尾' },
    executeAsync: async () => {
      // 工具执行期（assistant 工具调用消息已入史、tool 结果未入史）追加留痕
      engine.appendSyntheticMessage(LANDING, 'todoLanding')
      historyDuringExec = engine.getHistory()
      return { success: true, data: { content: '任务已受理' } }
    },
  })
  engine = new ChatEngine(deps)
  let notifies = 0
  engine.onMessagesChanged = () => notifies++

  await engine.sendMessage({ text: '派活' })

  // 执行期快照：留痕不在其中（仍在队列）
  assert.ok(!historyDuringExec.some((m) => m.synthetic === 'todoLanding'), 'running 期间不得当场入史')
  // 最终历史：user → assistant(toolCalls) → tool → 落地块 → assistant(收尾)
  const history = engine.getHistory()
  const landingIdx = history.findIndex((m) => m.synthetic === 'todoLanding')
  const lastToolIdx = history.map((m, i) => (m.role === TOOL ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
  assert.ok(lastToolIdx !== -1, '应有 tool 结果消息')
  assert.ok(landingIdx > lastToolIdx, `落地块下标 ${landingIdx} 须在 tool 结果 ${lastToolIdx} 之后`)
  assert.equal(history[landingIdx].content, LANDING)
  engine.dispose()
})

test('loadSession/startNewSession 清空延迟落史队列（防陈旧留痕注入新会话）', async () => {
  const { deps } = makeDeps()
  const engine = new ChatEngine(deps)
  // 白盒塞入陈旧队列项（真实路径：abort 等中断在 flush 前打断轮次）
  ;(engine as any).pendingSynthetic.push({
    role: USER,
    content: '陈旧留痕',
    timestamp: new Date(),
    synthetic: 'todoLanding',
  })

  engine.startNewSession()
  assert.equal((engine as any).pendingSynthetic.length, 0, 'startNewSession 须清空队列')

  // 清空后的首条留痕不得带出陈旧内容
  engine.appendSyntheticMessage(LANDING, 'todoLanding')
  const contents = engine.getHistory().map((m) => m.content)
  assert.deepEqual(contents, [LANDING])
  engine.dispose()
})
