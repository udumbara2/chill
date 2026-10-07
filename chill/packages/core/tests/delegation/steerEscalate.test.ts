import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IsolatedEnvironment } from '../../src/orchestrator/isolation/types.ts'
import { executeSteerTask, executeSteerTaskPreview } from '../../src/services/delegation/steerTaskTool.ts'
import { executeEscalateToLead, ESCALATE_TOOL_NAME } from '../../src/services/delegation/escalateTool.ts'

function fakeEnv(id: string): IsolatedEnvironment {
  return { id, sendRequest: async () => ({ success: true, output: 'ok' }), destroy: async () => {} }
}

function registerRunningTask(toolCallId: string, taskId: string): void {
  const registry = getTaskRegistry()
  registry.register({
    toolCallId,
    taskId,
    subagentType: 'researcher',
    description: '调研测试',
    batchId: registry.newBatchId(),
  })
  registry.bindEnvironment(toolCallId, fakeEnv(`env-${toolCallId}`))
}

test('steer: 入队→按 envId 出队(经既有 getEnvironmentKeyByEnvId 反查);环境解绑清理', () => {
  const registry = getTaskRegistry()
  const bindKey = `tc-steer-${Date.now()}`
  registry.register({
    toolCallId: bindKey,
    taskId: 'steer-task',
    subagentType: 'researcher',
    description: 'steer 测试',
    batchId: registry.newBatchId(),
  })
  const env = fakeEnv(`env-x-${Date.now()}`)
  registry.bindEnvironment(bindKey, env)

  assert.equal(registry.enqueueSteer(bindKey, '收窄到国内新闻'), true)
  assert.equal(registry.enqueueSteer(bindKey, '优先官方来源'), true)
  // 未绑定的键入队失败
  assert.equal(registry.enqueueSteer('ghost-bind-key', 'x'), false)

  const drained = registry.drainSteerByEnvId(env.id)
  assert.deepEqual(drained, ['收窄到国内新闻', '优先官方来源'])
  // 已清空
  assert.deepEqual(registry.drainSteerByEnvId(env.id), [])

  // 解绑后队列清理
  registry.enqueueSteer(bindKey, 'again')
  registry.unbindEnvironment(bindKey)
  assert.deepEqual(registry.drainSteerByEnvId(env.id), [])
  assert.equal(registry.enqueueSteer(bindKey, 'x'), false)
})

test('steer_task: 校验任务定位(预览不入队);已落地/不存在响亮报错', async () => {
  const registry = getTaskRegistry()
  const bindKey = `tc-steer-tool-${Date.now()}`
  registerRunningTask(bindKey, 'steer-tool-task')

  const bad = await executeSteerTaskPreview({ task_id: 'ghost', message: 'x' })
  assert.equal(bad.success, false)
  assert.match(bad.error!, /未找到任务/)

  const ok = await executeSteerTaskPreview({ toolCallId: bindKey, message: '收窄主题' })
  assert.equal(ok.success, true)
  assert.equal(ok.task?.toolCallId, bindKey)

  const done = await executeSteerTask({ toolCallId: bindKey, message: '收窄主题' })
  assert.equal(done.success, true)
  // 已入队可出队(归因前缀由入队点自带,mergeSteerNote 只并入不加帽——团队消息经同队列不混淆归属)
  const drained = registry.drainSteerByEnvId(registry.getEnvironment(bindKey)!.id)
  assert.deepEqual(drained, ['[来自 Lead 的中途指示]: 收窄主题\n请结合该指示调整后续行动。'])
  registry.unbindEnvironment(bindKey)
})

test('escalate: 入队→drain→requeue;参数校验', async () => {
  const registry = getTaskRegistry()
  const bad = await executeEscalateToLead(JSON.stringify({ message: '  ' }))
  assert.equal(bad.success, false)

  const ok = await executeEscalateToLead(
    JSON.stringify({ message: '素材只有 3 条', suggestion: '建议补充调研' }),
    { subagentType: 'writer', taskId: 'tc-esc-1' },
  )
  assert.equal(ok.success, true)
  assert.match(ok.data!, /已上报 Lead/)

  const drained = registry.drainEscalations()
  assert.equal(drained.length, 1)
  assert.equal(drained[0].subagentType, 'writer')
  assert.equal(drained[0].suggestion, '建议补充调研')
  assert.deepEqual(registry.drainEscalations(), [])

  registry.requeueEscalations(drained)
  assert.equal(registry.drainEscalations().length, 1)
})

test('escalate 工具常量: 非编排工具(不在 ORCHESTRATION_TOOL_NAMES)', async () => {
  const { ORCHESTRATION_TOOL_NAMES } = await import('../../src/orchestrator/types.ts')
  assert.equal(ORCHESTRATION_TOOL_NAMES.includes(ESCALATE_TOOL_NAME), false)
})
