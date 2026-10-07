import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import type { IsolatedEnvironment } from '../../src/orchestrator/isolation/types.ts'
import type { TaskToolOutput, TaskExecutionStatus } from '../../src/orchestrator/types.ts'

// TaskExecutionStatus 是 enum（不可经 node 类型擦除运行时导入），测试里用字符串字面量替代
const COMPLETED = 'completed' as TaskExecutionStatus
const FAILED = 'failed' as TaskExecutionStatus
const TIMEOUT = 'timeout' as TaskExecutionStatus

const completedOutput: TaskToolOutput = { status: COMPLETED, final_output: 'ok' }
const failedOutput: TaskToolOutput = { status: FAILED, final_output: '', error_info: { message: 'x' } }
const timeoutOutput: TaskToolOutput = { status: TIMEOUT, final_output: '', error_info: { message: 't' } }

function reg(r: TaskRegistry, toolCallId: string, batchId: string, taskId = toolCallId) {
  return r.register({ taskId, toolCallId, subagentType: 'test-agent', description: 'd', batchId })
}

test('CRUD: 登记/按 toolCallId 或 taskId 查/列出', () => {
  const r = new TaskRegistry()
  reg(r, 'tc-1', r.newBatchId(), 'alias-1')
  reg(r, 'tc-2', r.newBatchId())

  const byToolCallId = r.getByToolCallId('tc-1')!
  assert.equal(byToolCallId.taskId, 'alias-1')
  assert.equal(byToolCallId.status, 'running')
  assert.ok(byToolCallId.startedAt > 0)

  assert.equal(r.getByTaskId('alias-1')!.toolCallId, 'tc-1')
  // task_id 缺省回退 toolCallId
  assert.equal(r.getByTaskId('tc-2')!.toolCallId, 'tc-2')

  assert.equal(r.list().length, 2)
  assert.equal(r.listRunning().length, 2)

  r.markSettled('tc-1', completedOutput)
  assert.equal(r.getByToolCallId('tc-1')!.status, 'completed')
  assert.equal(r.getByToolCallId('tc-1')!.output!.final_output, 'ok')
  assert.ok(r.getByToolCallId('tc-1')!.settledAt)
  assert.equal(r.listRunning().length, 1)

  // 重复 settle 忽略
  r.markSettled('tc-1', failedOutput)
  assert.equal(r.getByToolCallId('tc-1')!.status, 'completed')
})

test('批次齐否: 同批未齐不入队，齐后整批入待汇报，drain 后清空', () => {
  const r = new TaskRegistry()
  const b = r.newBatchId()
  reg(r, 'tc-a', b)
  reg(r, 'tc-b', b)

  r.markSettled('tc-a', completedOutput)
  assert.equal(r.isBatchSettled(b), false)
  assert.deepEqual(r.drainPendingReports(), [])

  r.markSettled('tc-b', completedOutput)
  assert.equal(r.isBatchSettled(b), true)
  const drained = r.drainPendingReports()
  assert.equal(drained.length, 1)
  assert.equal(drained[0].length, 2) // 入队 = 整批
  assert.deepEqual(r.drainPendingReports(), []) // drain 后清空
})

test('批次齐否: 取消/失败/超时都算落地（超时按 failed 记入）', () => {
  const r = new TaskRegistry()
  const b = r.newBatchId()
  reg(r, 'tc-1', b)
  reg(r, 'tc-2', b)
  reg(r, 'tc-3', b)

  r.markCancelled('tc-1')
  r.markSettled('tc-2', failedOutput)
  r.markSettled('tc-3', timeoutOutput)

  assert.equal(r.getByToolCallId('tc-1')!.status, 'cancelled')
  assert.equal(r.getByToolCallId('tc-2')!.status, 'failed')
  assert.equal(r.getByToolCallId('tc-3')!.status, 'failed')
  assert.equal(r.isBatchSettled(b), true)
  assert.equal(r.drainPendingReports().length, 1)
})

test('批次齐否: 不同批次互不等待', () => {
  const r = new TaskRegistry()
  const b1 = r.newBatchId()
  const b2 = r.newBatchId()
  reg(r, 'tc-a', b1)
  reg(r, 'tc-b', b1)
  reg(r, 'tc-c', b2)

  r.markSettled('tc-c', completedOutput) // b2 齐（单任务批次）
  assert.equal(r.drainPendingReports().length, 1)

  r.markSettled('tc-a', completedOutput) // b1 未齐
  assert.deepEqual(r.drainPendingReports(), [])

  r.markSettled('tc-b', completedOutput) // b1 齐
  assert.equal(r.drainPendingReports().length, 1)
})

test('主动取消: 单任务批次取消算落地但不进待汇报；批内有非取消落地任务时整批仍汇报', () => {
  const r = new TaskRegistry()

  // 单任务批次：取消后批次虽齐，但不进待汇报（cancel_task 的工具结果已告知模型）
  const b1 = r.newBatchId()
  reg(r, 'tc-x', b1)
  r.markCancelled('tc-x')
  assert.equal(r.isBatchSettled(b1), true)
  assert.deepEqual(r.drainPendingReports(), [])

  // 多任务批次：取消计入齐否判定——取消最后落地时，整批（含已完成成员）仍正常汇报
  const b2 = r.newBatchId()
  reg(r, 'tc-y', b2)
  reg(r, 'tc-z', b2)
  r.markSettled('tc-y', completedOutput)
  assert.deepEqual(r.drainPendingReports(), [])
  r.markCancelled('tc-z')
  assert.equal(r.isBatchSettled(b2), true)
  assert.equal(r.drainPendingReports().length, 1)
})

test('Worker 环境映射: bind/get/unbind', () => {
  const r = new TaskRegistry()
  const env = { id: 'env-1' } as IsolatedEnvironment
  r.bindEnvironment('task-1', env)
  assert.equal(r.getEnvironment('task-1')!.id, 'env-1')
  r.unbindEnvironment('task-1')
  assert.equal(r.getEnvironment('task-1'), undefined)
})
