import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { BuiltInToolExecutor } from '../../src/services/builtInToolExecutor.ts'
import { getApprovalChannel, resetApprovalChannel } from '../../src/services/approvals.ts'
import { eventBus, EVENTS } from '../../src/utils/eventBus.ts'

/**
 * P1/P2 回归基线（工具状态如实显示，规划 v2）：
 * - 执行器中间态发射权：审批门进门 pending / 批准后执行前 running；直通路径不重发（调用方受理 running 已是真相）
 * - 载荷完整在源头补齐：执行器事件经归因帧回填 toolCall.function.name（wireToolStatus 的消费形状）
 * 状态语义参照 relayEngineWiring.wireToolStatus（唯一 relay 消费方，CLI 侧有 module 过滤不受执行器事件影响）。
 */

interface StatusEvent {
  toolCallStatus?: unknown
  toolCallId?: unknown
  toolCall?: { function?: { name?: string } } | undefined
  module?: unknown
}

function makeEnv() {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'toolstatus-'))
  const fsProvider: any = {
    getCurrentDirectory: () => home,
    fileExists: async (p: string) => ({ success: fs.existsSync(p) }),
  }
  const calls: Array<{ command?: string; code?: string; language?: string }> = []
  const fakeCodeExecutor: any = {
    executePowerShell: async (command: string) => {
      calls.push({ command })
      return { success: true, output: `ran: ${command}` }
    },
    executeChildProcess: async (language: string, code: string) => {
      calls.push({ language, code })
      return { success: true, output: `ran-code: ${code.slice(0, 12)}` }
    },
  }
  const executor = new BuiltInToolExecutor(fsProvider, {} as any, {} as any, fakeCodeExecutor, home)
  const events: StatusEvent[] = []
  const onStatus = (e: StatusEvent) => events.push(e)
  eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, onStatus as (e: unknown) => void)
  resetApprovalChannel()
  return {
    executor,
    events,
    calls,
    /** 只取执行器发射的事件（载荷无 module 字段；调用方事件带 module='chat' 等） */
    executorEvents: () => events.filter((e) => e.module === undefined),
    approve: (toolCallId: string) =>
      eventBus.emit(EVENTS.APPROVAL_RESOLVED, { toolCallId, approved: true } as never),
    cleanup: () => {
      eventBus.off(EVENTS.TOOL_CALL_STATUS_CHANGED, onStatus as (e: unknown) => void)
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

const PS_ARGS = JSON.stringify({ command: 'Write-Output hello', purpose: 't', intent: 't' })
const CODE_ARGS = JSON.stringify({ language: 'javascript', code: 'console.log(1)', purpose: 't', intent: 't' })

test('S1 直通序列（autoApply）：执行器只发终态，无中间 pending；载荷回填工具名', async () => {
  const env = makeEnv()
  try {
    env.executor.setAutoApply(true)
    const r = await env.executor.executeAsync('execute_powershell', PS_ARGS, 'call-s1')
    assert.equal(r.success, true)
    const seq = env.executorEvents().map((e) => e.toolCallStatus)
    assert.deepEqual(seq, ['success'], '直通：执行器无 pending/running（受理 running 由调用方发射）')
    for (const e of env.executorEvents()) {
      assert.equal(e.toolCall?.function?.name, 'execute_powershell', 'P2：执行器事件回填 toolCall.function.name')
    }
  } finally {
    env.cleanup()
  }
})

test('S2 审批序列（boundary）：进门 pending → 批准后 running → 终态；全程载荷带工具名', async () => {
  const env = makeEnv()
  try {
    const pending = env.executor.executeAsync('execute_powershell', PS_ARGS, 'call-s2')
    // 等审批请求挂起（执行器已进门发 pending）
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(getApprovalChannel().listPending().length === 1, '审批请求已挂起')
    assert.equal(env.executorEvents()[0]?.toolCallStatus, 'pending', '进门即 pending')
    env.approve('call-s2')
    const r = await pending
    assert.equal(r.success, true)
    const seq = env.executorEvents().map((e) => e.toolCallStatus)
    assert.deepEqual(seq, ['pending', 'running', 'success'], '审批路径三段序列')
    for (const e of env.executorEvents()) {
      assert.equal(e.toolCall?.function?.name, 'execute_powershell')
    }
  } finally {
    env.cleanup()
  }
})

test('S3 execute_code 同构：审批进门 pending → 批准后 running → 终态', async () => {
  const env = makeEnv()
  try {
    const pending = env.executor.executeAsync('execute_code', CODE_ARGS, 'call-s3')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(getApprovalChannel().listPending().length === 1)
    env.approve('call-s3')
    const r = await pending
    assert.equal(r.success, true)
    const seq = env.executorEvents().map((e) => e.toolCallStatus)
    assert.deepEqual(seq, ['pending', 'running', 'success'], 'execute_code 与 execute_powershell 同构')
    for (const e of env.executorEvents()) {
      assert.equal(e.toolCall?.function?.name, 'execute_code')
    }
  } finally {
    env.cleanup()
  }
})

test('S4 name 回填边界：无归因帧时载荷保持现状（不加 toolCall 字段、不抛错）', async () => {
  const env = makeEnv()
  try {
    // 绕过 executeAsync 帧 登记直接调发射口（无帧路径）
    const before = env.events.length
    ;(env.executor as any).emitToolStatusChanged({ toolCallStatus: 'running', toolCallId: 'call-ghost' })
    assert.equal(env.events.length, before + 1)
    const e = env.events[env.events.length - 1]!
    assert.equal(e.toolCall, undefined, '无帧不回填（缺归因兜底=现状）')
  } finally {
    env.cleanup()
  }
})
