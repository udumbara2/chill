import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  executeRunWorkflow,
  setWorkflowRunProviders,
} from '../../../src/services/delegation/workflowRunTool.ts'
import { setDelegationContextProvider } from '../../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry } from '../../../src/services/delegation/taskRegistry.ts'
import { WorkflowTemplateService } from '../../../src/services/workflow/WorkflowTemplateService.ts'
import { WorkflowRunStore } from '../../../src/services/workflow/workflowRunStore.ts'
import type { IFileSystemProvider } from '../../../src/interfaces/IFileSystemProvider.ts'

const TWO_STEP = `
name: two-step
version: 1
nodes:
  - id: step_a
    tool: { name: tool_a, params: {} }
  - id: step_b
    tool: { name: tool_b, params: {} }
edges:
  - { from: step_a, to: step_b }
`

function makeFakeFs(files: Record<string, string> = {}) {
  const map = new Map(Object.entries(files))
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/$/, '')
  const fs: IFileSystemProvider = {
    readFile: async (p: string) => {
      const key = norm(p)
      return map.has(key) ? { success: true, data: { content: map.get(key)! } } : { success: false, error: 'not found' }
    },
    writeFile: async (p: string, content: string) => {
      map.set(norm(p), content)
      return { success: true }
    },
    deleteFile: async (p: string) => {
      map.delete(norm(p))
      return { success: true }
    },
    renameFile: async (from: string, to: string) => {
      const content = map.get(norm(from))
      if (content === undefined) return { success: false, error: 'not found' }
      map.set(norm(to), content)
      map.delete(norm(from))
      return { success: true }
    },
    listDirectory: async (dir: string) => {
      const prefix = `${norm(dir)}/`
      const names = [...map.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => ({ name: k.slice(prefix.length), type: 'file' }))
      return { success: true, data: { files: names } }
    },
    getCurrentDirectory: () => null,
    fileExists: async (p: string) => {
      const key = norm(p)
      return { success: true, data: map.has(key) || [...map.keys()].some((k) => k.startsWith(`${key}/`)) }
    },
    getPathType: async () => ({ success: true, data: { type: 'not_found' as const } }),
  }
  return { fs, map }
}

const TOOL_DEFS = ['tool_a', 'tool_b'].map(
  (name) => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {}, required: [] } } }) as any,
)

test('断点续跑:中断后 resume_from,已完成节点不重跑', async () => {
  const { fs } = makeFakeFs({ '/home/.chill/workflows/two-step.yaml': TWO_STEP })
  const svc = new WorkflowTemplateService(fs, '/home/.chill/workflows')
  await svc.initialize()
  const runStore = new WorkflowRunStore(fs, '/home/.chill/workflow-runs')

  const calls: string[] = []
  let toolBStarted: () => void = () => {}
  let releaseToolB: () => void = () => {}
  const toolBStartedPromise = new Promise<void>((r) => (toolBStarted = r))
  let toolBGate = new Promise<void>((r) => (releaseToolB = r))

  setWorkflowRunProviders({
    getService: () => svc,
    getRunStore: () => runStore,
    toolRunner: async (name) => {
      calls.push(name)
      if (name === 'tool_b') {
        toolBStarted()
        await toolBGate // 第一次运行:卡住,等待取消
      }
      return { success: true, data: `${name}:ok` }
    },
  })
  setDelegationContextProvider(() => ({ toolMetadata: [], toolDefinitions: TOOL_DEFS }))

  // 第一次运行(异步受理):step_b 卡住时被取消
  const r1 = await executeRunWorkflow('call-1', { name: 'two-step' })
  assert.equal(r1.success, true)
  const runId = getTaskRegistry().getByToolCallId('call-1')!.taskId
  await toolBStartedPromise
  const { executeCancelTask } = await import('../../../src/services/delegation/delegationTools.ts')
  await executeCancelTask({ toolCallId: 'call-1' })
  releaseToolB()
  await new Promise((r) => setTimeout(r, 200))

  // 记录应为 cancelled,已完成节点 = start + step_a(step_b 不得入记录)
  const record = await runStore.load(runId)
  assert.ok(record, '运行记录已落盘')
  assert.equal(record!.status, 'cancelled')
  const completedIds = record!.completedNodes.map((n) => n.nodeId)
  assert.ok(completedIds.includes('step_a'))
  assert.ok(!completedIds.includes('step_b'), '被取消时未完成的节点不入记录')

  // 续跑:只有 step_b 的 runner 被调用
  calls.length = 0
  toolBGate = Promise.resolve()
  const r2 = await executeRunWorkflow('call-2', { name: 'two-step', resume_from: runId }, { sync: true })
  assert.equal(r2.success, true, r2.error)
  assert.deepEqual(calls, ['tool_b'], '已完成节点(start/step_a)命中记录不重跑')

  const record2 = await runStore.load(runId)
  assert.equal(record2!.status, 'completed')
})

test('续跑护栏:定义变更后哈希不一致,拒绝续跑', async () => {
  const { fs, map } = makeFakeFs({ '/home/.chill/workflows/two-step.yaml': TWO_STEP })
  const svc = new WorkflowTemplateService(fs, '/home/.chill/workflows')
  await svc.initialize()
  const runStore = new WorkflowRunStore(fs, '/home/.chill/workflow-runs')

  // 直接落一条失败运行记录(预检场景已由专测覆盖,此处聚焦哈希护栏)
  const { workflowContentHash } = await import('../../../src/services/workflow/workflowRunStore.ts')
  const def = svc.getWorkflowByName('two-step')!
  const runId = 'wf_two-step_1700000000000'
  await runStore.save({
    runId,
    workflowName: 'two-step',
    contentHash: workflowContentHash(def),
    status: 'failed',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedNodes: [],
  })

  setWorkflowRunProviders({
    getService: () => svc,
    getRunStore: () => runStore,
    toolRunner: async (name) => ({ success: true, data: `${name}:ok` }),
  })
  setDelegationContextProvider(() => ({ toolMetadata: [], toolDefinitions: TOOL_DEFS }))

  // 定义变更(改动节点参数)后哈希变 → 拒绝续跑
  // (哈希只含语义字段:name/version/inputs/nodes/edges;title/description 等展示字段不影响)
  map.set('/home/.chill/workflows/two-step.yaml', TWO_STEP.replace('tool_b, params: {}', 'tool_b, params: { v: 1 }'))
  await svc.reload()
  const r2 = await executeRunWorkflow('call-y', { name: 'two-step', resume_from: runId }, { sync: true })
  assert.equal(r2.success, false)
  assert.match(r2.error!, /已变更/)
})
