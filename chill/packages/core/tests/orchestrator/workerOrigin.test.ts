import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { TemplateSubagentForkManager } from '../../src/orchestrator/isolation/TemplateSubagentForkManager.ts'
import { getTaskRegistry, resetTaskRegistry } from '../../src/services/delegation/taskRegistry.ts'
import { getApprovalChannel, resetApprovalChannel } from '../../src/services/approvals.ts'
import { executeCancelTask } from '../../src/services/delegation/delegationTools.ts'
import type { IsolatedEnvironment } from '../../src/orchestrator/isolation/types.ts'

/** 复位两个相关单例；t.after 恢复 */
function setup(t: TestContext): void {
  resetTaskRegistry()
  resetApprovalChannel()
  t.after(() => {
    resetTaskRegistry()
    resetApprovalChannel()
  })
}

/** 登记一个 running 任务并把 toolCallId 绑定到指定 envId（模拟 StandardSubagentExecutor 上抛） */
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

test('网关归属注入: __origin 随 args 到达宿主 executor（subagentType 与 toolCall.id 来自注册表）', async (t) => {
  setup(t)
  const envId = 'doc-writer-1785340000000-abc123xyz'
  registerAndBind('tc-1', 'doc-writer', envId)

  let receivedArgs: any
  const forkManager = new TemplateSubagentForkManager(undefined, async (_toolName, args) => {
    receivedArgs = JSON.parse(args)
    return { success: true, data: { content: 'ok' } }
  })
  const sent: any[] = []
  const child = { send: (msg: any) => sent.push(msg) }

  await (forkManager as any).handleToolCallRequest(child, {
    id: 'req-1',
    payload: { kind: 'builtin', toolName: 'create_file', args: { path: 'a.txt', content: 'x' }, toolCallId: 'wtc-1' },
  }, envId)

  // __origin 经网关注入：source=subagent，归属字段来自注册表（envId 反查）
  assert.deepEqual(receivedArgs.__origin, { source: 'subagent', subagentType: 'doc-writer', taskId: 'tc-1' })
  // 原有 args 字段保留
  assert.equal(receivedArgs.path, 'a.txt')
  assert.equal(receivedArgs.content, 'x')
  // 执行结果正常回包
  assert.equal(sent.length, 1)
  assert.equal(sent[0].payload.success, true)
})

test('网关归属注入: 覆盖 Worker 自带 __origin（防伪造）；无环境绑定时 taskId 缺省、前缀解析 subagentType', async (t) => {
  setup(t)
  const envId = 'code-reviewer-1785340000000-def456uvw'

  let receivedArgs: any
  const forkManager = new TemplateSubagentForkManager(undefined, async (_toolName, args) => {
    receivedArgs = JSON.parse(args)
    return { success: true }
  })
  const child = { send: () => {} }

  await (forkManager as any).handleToolCallRequest(child, {
    id: 'req-2',
    payload: { kind: 'builtin', toolName: 'read_file', args: { path: 'x', __origin: { source: 'main' } } },
  }, envId)

  // Worker 伪造的 {source:'main'} 被网关覆盖为真实归属
  assert.equal(receivedArgs.__origin.source, 'subagent')
  assert.equal(receivedArgs.__origin.subagentType, 'code-reviewer')
  // 未绑定环境（未走 StandardSubagentExecutor 上抛）时 taskId 缺省（JSON 序列化后键丢失）
  assert.equal(receivedArgs.__origin.taskId, undefined)
})

test('网关归属注入: 声明 memory/knowledge 的任务随 __origin 携带 memoryDir 与 knowledgeBases（注册表登记 → 网关注入）', async (t) => {
  setup(t)
  const envId = 'doc-writer-1785340000000-mem123xyz'
  const memoryDir = '/home/u/.chill/agent-memory/doc-writer'
  const knowledgeBases = ['frontend-notes']
  const registry = getTaskRegistry()
  registry.register({
    taskId: 'alias-mem',
    toolCallId: 'tc-mem',
    subagentType: 'doc-writer',
    description: '测试任务',
    batchId: registry.newBatchId(),
  })
  registry.bindEnvironment('tc-mem', { id: envId } as unknown as IsolatedEnvironment, { memoryDir, knowledgeBases })

  let receivedArgs: any
  const forkManager = new TemplateSubagentForkManager(undefined, async (_toolName, args) => {
    receivedArgs = JSON.parse(args)
    return { success: true }
  })
  const child = { send: () => {} }

  await (forkManager as any).handleToolCallRequest(child, {
    id: 'req-mem',
    payload: { kind: 'builtin', toolName: 'save_memory', args: { type: 'user', title: 't', content: 'c' } },
  }, envId)

  assert.equal(receivedArgs.__origin.memoryDir, memoryDir)
  assert.deepEqual(receivedArgs.__origin.knowledgeBases, knowledgeBases)

  // 解绑后资源登记一并清除（不留陈旧路由）
  registry.unbindEnvironment('tc-mem')
  assert.equal(registry.getEnvironmentMemoryDir('tc-mem'), undefined)
  assert.equal(registry.getEnvironmentKnowledgeBases('tc-mem'), undefined)
})

test('cancel_task: 一并 reject 该任务的全部挂起审批（不再等用户回答）', async (t) => {  setup(t)
  const registry = getTaskRegistry()
  registry.register({
    taskId: 'alias-c',
    toolCallId: 'tc-c',
    subagentType: 'doc-writer',
    description: '写文档',
    batchId: registry.newBatchId(),
  })

  // Worker 发起圈外写审批（归属=该任务），挂起等回答
  const approvalPromise = getApprovalChannel().request({
    toolCallId: 'ap-1',
    kind: 'write',
    path: '/outside/a.txt',
    origin: { source: 'subagent', subagentType: 'doc-writer', taskId: 'tc-c' },
  })

  const result = await executeCancelTask({ toolCallId: 'tc-c' })
  assert.equal(result.success, true)

  // 挂起审批被 reject：防"任务已取消、用户随后批准、executor 照常落盘"
  const resolution = await approvalPromise
  assert.equal(resolution.approved, false)
  assert.equal(resolution.reason, '任务已取消')
})

test('批准复查钩子: 任务已取消时批准强制转拒绝（批准后不落盘）；running 任务与主会话审批不受影响', async (t) => {
  setup(t)
  const registry = getTaskRegistry()
  const channel = getApprovalChannel()

  // 场景 A：任务 running 时批准 → 正常通过
  registry.register({
    taskId: 'a1', toolCallId: 'tc-ok', subagentType: 'doc-writer',
    description: '', batchId: registry.newBatchId(),
  })
  const p1 = channel.request({
    toolCallId: 'ap-ok', kind: 'write', path: '/x',
    origin: { source: 'subagent', subagentType: 'doc-writer', taskId: 'tc-ok' },
  })
  channel.resolve('ap-ok', { approved: true })
  assert.equal((await p1).approved, true)

  // 场景 B：任务已取消（cancel 与批准竞态，挂起尚未被 reject）→ 批准被强制转拒绝
  registry.register({
    taskId: 'a2', toolCallId: 'tc-x', subagentType: 'doc-writer',
    description: '', batchId: registry.newBatchId(),
  })
  const p2 = channel.request({
    toolCallId: 'ap-x', kind: 'write', path: '/x',
    origin: { source: 'subagent', subagentType: 'doc-writer', taskId: 'tc-x' },
  })
  registry.markCancelled('tc-x')
  channel.resolve('ap-x', { approved: true })
  const r2 = await p2
  assert.equal(r2.approved, false)
  assert.equal(r2.reason, '任务已取消')

  // 场景 C：主会话审批（origin.source=main）不受复查影响
  const p3 = channel.request({
    toolCallId: 'ap-m', kind: 'write', path: '/x', origin: { source: 'main' },
  })
  channel.resolve('ap-m', { approved: true })
  assert.equal((await p3).approved, true)
})
