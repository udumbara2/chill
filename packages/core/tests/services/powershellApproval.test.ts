import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'
import type { ApprovalRequestPayload } from '../../src/services/approvals.ts'

/** 记录调用的假 codeExecutor；其余三个依赖在 PowerShell 路径不触达 */
function makeExecutor(calls: Array<{ command: string; options: any }>) {
  const codeExecutor = {
    executePowerShell: async (command: string, options: any) => {
      calls.push({ command, options })
      return { success: true, output: `ok:${command}` }
    },
  }
  return new BuiltInToolExecutor({} as any, {} as any, {} as any, codeExecutor as any)
}

function once<T = any>(event: string): { fired: () => T[] } {
  const captured: T[] = []
  const listener = (data: T) => captured.push(data)
  eventBus.on(event, listener)
  return {
    fired: () => {
      eventBus.off(event, listener)
      return captured
    },
  }
}

const ARGS = JSON.stringify({ command: 'echo hi', purpose: '测试命令' })

test('PowerShell 迁移回归: autoApply off 时走审批通道（APPROVAL_REQUESTED 含归属）', async (t) => {
  const calls: Array<{ command: string; options: any }> = []
  const executor = makeExecutor(calls)
  const requested = once<ApprovalRequestPayload>(EVENTS.APPROVAL_REQUESTED)
  t.after(() => resetApprovalChannel())

  const pending = executor.executeAsync('execute_powershell', ARGS, 'tc-ps1')

  // 新事件：kind=command、归属缺省主会话
  const req = requested.fired()
  assert.equal(req.length, 1)
  assert.equal(req[0].toolCallId, 'tc-ps1')
  assert.equal(req[0].kind, 'command')
  assert.equal(req[0].command, 'echo hi')
  assert.equal(req[0].origin.source, 'main')

  // 批准 → 执行并返回结果（行为不变）
  getApprovalChannel().resolve('tc-ps1', { approved: true })
  const result = await pending
  assert.equal(result.success, true)
  assert.equal(result.data.content, 'ok:echo hi')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'echo hi')
})

test('PowerShell 迁移回归: 拒绝后返回拒绝文本且不执行', async (t) => {
  const calls: Array<{ command: string; options: any }> = []
  const executor = makeExecutor(calls)
  t.after(() => resetApprovalChannel())

  const pending = executor.executeAsync('execute_powershell', ARGS, 'tc-ps2')
  getApprovalChannel().resolve('tc-ps2', { approved: false, reason: '太危险' })
  const result = await pending

  assert.equal(result.success, false)
  assert.ok(result.error!.includes('用户拒绝执行'))
  assert.ok(result.error!.includes('太危险'))
  assert.equal(calls.length, 0)
})

test('PowerShell 迁移回归: APPROVAL_RESOLVED 携带改过的命令与工作目录批准', async (t) => {
  const calls: Array<{ command: string; options: any }> = []
  const executor = makeExecutor(calls)
  t.after(() => resetApprovalChannel())

  const pending = executor.executeAsync('execute_powershell', ARGS, 'tc-ps3')
  eventBus.emit(EVENTS.APPROVAL_RESOLVED, {
    toolCallId: 'tc-ps3',
    approved: true,
    command: 'echo edited',
    workingDirectory: 'C:\\proj',
  })
  const result = await pending

  assert.equal(result.success, true)
  // 壳侧改过的命令被执行（旧 PowerShell 确认流语义在新通道延续）
  assert.equal(calls[0].command, 'echo edited')
  assert.equal(calls[0].options.workingDirectory, 'C:\\proj')
})
