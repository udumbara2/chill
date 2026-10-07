import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { resetApprovalChannel } from '../../src/services/approvals.ts'
import { resetTeamRuntimeService } from '../../src/services/team/TeamRuntimeService.ts'
import { eventBus, EVENTS, type SubagentToolCallPayload } from '../../src/utils/eventBus.ts'
import { BOARD_RESULT_MAX_CHARS } from '../../src/services/team/teamRuntimeTypes.ts'
import type { IsolatedEnvironment } from '../../src/orchestrator/isolation/types.ts'

/**
 * 执行过程面板(迭代 1):fork 网关 SUBAGENT_TOOL_CALL 事件——
 * 入口发 running、统一响应点 respondToolCall 按 payload.success 发 success/failed(全分支覆盖);
 * 旁听不改网关行为(响应内容/时序不变),发射异常静默,载荷截断 4KB/字段。
 */

function setup(t: TestContext): { events: SubagentToolCallPayload[] } {
  resetTaskRegistry()
  resetApprovalChannel()
  resetTeamRuntimeService()
  const events: SubagentToolCallPayload[] = []
  const listener = (p: SubagentToolCallPayload) => events.push(p)
  eventBus.on(EVENTS.SUBAGENT_TOOL_CALL, listener)
  t.after(() => {
    eventBus.off(EVENTS.SUBAGENT_TOOL_CALL, listener)
    resetTaskRegistry()
    resetApprovalChannel()
    resetTeamRuntimeService()
  })
  return { events }
}

/** 登记一个 running 任务并把 toolCallId 绑定到指定 envId(与 workerOrigin.test.ts 同款) */
function registerAndBind(toolCallId: string, subagentType: string, envId: string): void {
  const registry = getTaskRegistry()
  registry.register({
    taskId: `alias-${toolCallId}`,
    toolCallId,
    subagentType,
    description: '测试任务',
    batchId: registry.newBatchId(),
  })
  registry.bindEnvironment(toolCallId, { id: envId } as unknown as IsolatedEnvironment)
}

const ENV_ID = 'doc-writer-1785340000000-abc123xyz'

function makeManager(result: unknown = { success: true, data: { content: 'ok' } }): { fm: TemplateSubagentForkManager; sent: any[] } {
  const fm = new TemplateSubagentForkManager(undefined, async () => result as any)
  const sent: any[] = []
  return { fm, sent }
}

function fakeChild(sent: any[]): any {
  return { send: (msg: any) => sent.push(msg) }
}

test('builtin 成功:入口 running + 响应 success 两事件;归属/摘要/耗时正确;响应内容不变', async (t) => {
  const { events } = setup(t)
  registerAndBind('tc-1', 'doc-writer', ENV_ID)
  const { fm, sent } = makeManager()

  await (fm as any).handleToolCallRequest(fakeChild(sent), {
    id: 'req-1',
    payload: { kind: 'builtin', toolName: 'read_file', args: { path: 'a.txt' }, toolCallId: 'wtc-1' },
  }, ENV_ID)

  assert.equal(events.length, 2)
  const [running, success] = events
  assert.equal(running.status, 'running')
  assert.equal(running.toolName, 'read_file')
  assert.equal(running.toolCallId, 'wtc-1')
  assert.equal(running.taskId, 'tc-1') // 归属经 resolveOrigin(envId) 反查
  assert.equal(running.subagentType, 'doc-writer')
  assert.match(running.argsSummary, /a\.txt/)

  assert.equal(success.status, 'success')
  assert.equal(success.toolCallId, 'wtc-1')
  assert.equal(success.taskId, 'tc-1')
  assert.match(success.resultSummary!, /ok/)
  assert.equal(typeof success.durationMs, 'number')

  // 响应内容/形状不变(IPC 协议零变化)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.success, true)
  // Map 键响应后即删(防泄漏)
  assert.equal((fm as any).toolCallContexts.size, 0)
})

test('网关拒绝三分支均发 failed:编排工具/授权名单/团队成员资格门', async (t) => {
  const { events } = setup(t)
  registerAndBind('tc-1', 'doc-writer', ENV_ID)
  const { fm, sent } = makeManager()

  // ① 编排工具永不放行(无团队豁免)
  await (fm as any).handleToolCallRequest(fakeChild(sent), {
    id: 'req-orch',
    payload: { kind: 'builtin', toolName: 'task', args: { description: 'x' }, toolCallId: 'wtc-orch' },
  }, ENV_ID)
  // ② 授权名单复核(名单为空 = 零工具)
  await (fm as any).handleToolCallRequest(fakeChild(sent), {
    id: 'req-allow',
    payload: { kind: 'builtin', toolName: 'read_file', args: {}, toolCallId: 'wtc-allow', authorizedTools: [] },
  }, ENV_ID)
  // ③ 团队工具成员资格门(无活动团队/非成员)
  await (fm as any).handleToolCallRequest(fakeChild(sent), {
    id: 'req-team',
    payload: { kind: 'builtin', toolName: 'team_board', args: { action: 'read' }, toolCallId: 'wtc-team' },
  }, ENV_ID)

  const failed = events.filter((e) => e.status === 'failed')
  assert.equal(events.filter((e) => e.status === 'running').length, 3)
  assert.equal(failed.length, 3)
  assert.match(failed[0].resultSummary!, /编排工具/)
  assert.match(failed[1].resultSummary!, /授权工具名单/)
  assert.match(failed[2].resultSummary!, /团队成员/)
  assert.equal(sent.length, 3) // 每次拒绝仍各回一包,行为不变
})

test('执行失败(mcp 无服务/executor 异常):统一响应点发 failed 附原因', async (t) => {
  const { events } = setup(t)
  registerAndBind('tc-1', 'doc-writer', ENV_ID)
  const { fm } = makeManager()

  await (fm as any).handleToolCallRequest(fakeChild([]), {
    id: 'req-mcp',
    payload: { kind: 'mcp', toolName: 'tavily_search', args: { query: 'x' }, toolCallId: 'wtc-mcp' },
  }, ENV_ID)

  const failed = events.find((e) => e.status === 'failed')
  assert.ok(failed)
  assert.match(failed!.resultSummary!, /MCP 服务未初始化/)
})

test('巨型载荷截断:args/result 超 4KB 强制截断(BOARD_RESULT_MAX_CHARS 先例)', async (t) => {
  const { events } = setup(t)
  registerAndBind('tc-1', 'doc-writer', ENV_ID)
  const huge = 'x'.repeat(BOARD_RESULT_MAX_CHARS * 3)
  const { fm } = makeManager({ success: true, data: { content: huge } })

  await (fm as any).handleToolCallRequest(fakeChild([]), {
    id: 'req-huge',
    payload: { kind: 'builtin', toolName: 'create_file', args: { path: 'a', content: huge }, toolCallId: 'wtc-huge' },
  }, ENV_ID)

  const [running, success] = events
  assert.ok(running.argsSummary.length < BOARD_RESULT_MAX_CHARS + 100)
  assert.match(running.argsSummary, /已截断/)
  assert.ok(success.resultSummary!.length < BOARD_RESULT_MAX_CHARS + 100)
  assert.match(success.resultSummary!, /已截断/)
})

test('无环境绑定:事件仍发但 taskId 缺省(壳侧无归属不显示)', async (t) => {
  const { events } = setup(t)
  const { fm } = makeManager()

  await (fm as any).handleToolCallRequest(fakeChild([]), {
    id: 'req-nobind',
    payload: { kind: 'builtin', toolName: 'read_file', args: {}, toolCallId: 'wtc-nobind' },
  }, ENV_ID)

  assert.equal(events.length, 2)
  assert.equal(events[0].taskId, undefined)
  assert.equal(events[0].subagentType, 'doc-writer') // envId 前缀解析兜底
})

test('发射异常静默:订阅者之外 emit 本身抛错也不影响网关响应', async (t) => {
  setup(t)
  registerAndBind('tc-1', 'doc-writer', ENV_ID)
  const { fm, sent } = makeManager()

  const originalEmit = (eventBus as any).emit
  ;(eventBus as any).emit = () => { throw new Error('观测通道爆炸') }
  t.after(() => { (eventBus as any).emit = originalEmit })

  await (fm as any).handleToolCallRequest(fakeChild(sent), {
    id: 'req-boom',
    payload: { kind: 'builtin', toolName: 'read_file', args: {}, toolCallId: 'wtc-boom' },
  }, ENV_ID)

  // 网关响应照常(观测绝不能影响网关)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.success, true)
})
