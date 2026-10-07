import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  executeRunWorkflow,
  setWorkflowRunProviders,
} from '../../../src/services/delegation/workflowRunTool.ts'
import { setDelegationContextProvider } from '../../../src/services/delegation/delegationTools.ts'
import { getTaskRegistry } from '../../../src/services/delegation/taskRegistry.ts'
import { WorkflowTemplateService } from '../../../src/services/workflow/WorkflowTemplateService.ts'
import type { IFileSystemProvider } from '../../../src/interfaces/IFileSystemProvider.ts'

const ECHO_WORKFLOW = `
name: echo-flow
version: 1
description: 测试工作流
inputs:
  - { name: topic, type: text, required: true }
nodes:
  - id: echo
    tool: { name: echo_tool, params: { text: hello } }
edges: []
`

function makeFakeFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files))
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '').replace(/\/$/, '')
  const fs: IFileSystemProvider = {
    readFile: async (p: string) => {
      const key = norm(p)
      return map.has(key) ? { success: true, data: { content: map.get(key)! } } : { success: false, error: 'not found' }
    },
    writeFile: async () => ({ success: true }),
    deleteFile: async () => ({ success: true }),
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
  return { fs }
}

async function makeService(): Promise<WorkflowTemplateService> {
  const { fs } = makeFakeFs({ '/home/.chill/workflows/echo-flow.yaml': ECHO_WORKFLOW })
  const svc = new WorkflowTemplateService(fs, '/home/.chill/workflows')
  await svc.initialize()
  return svc
}

function setupProviders(runner?: (name: string, params: any) => Promise<any>) {
  const svcPromise = makeService()
  let svc: WorkflowTemplateService | undefined
  setWorkflowRunProviders({
    getService: () => svc,
    toolRunner: runner as any,
  })
  setDelegationContextProvider(() => ({
    toolMetadata: [],
    toolDefinitions: [
      { type: 'function', function: { name: 'echo_tool', description: '', parameters: { type: 'object', properties: {}, required: [] } } } as any,
    ],
  }))
  return async () => {
    svc = await svcPromise
  }
}

test('预检:服务未装配 / 名字不存在 / 必填入参缺失 → 可读错误,不登记', async () => {
  setWorkflowRunProviders({ getService: () => undefined })
  const r1 = await executeRunWorkflow('tc1', { name: 'x' })
  assert.equal(r1.success, false)
  assert.match(r1.error!, /未初始化/)

  const ready = setupProviders()
  await ready()
  const r2 = await executeRunWorkflow('tc2', { name: 'ghost' })
  assert.equal(r2.success, false)
  assert.match(r2.error!, /不存在/)
  assert.match(r2.error!, /echo-flow/, '错误中列出可用工作流')

  const r3 = await executeRunWorkflow('tc3', { name: 'echo-flow' })
  assert.equal(r3.success, false)
  assert.match(r3.error!, /缺少必填入参: topic/)

  // 预检失败不登记任务
  assert.equal(getTaskRegistry().getByToolCallId('tc2'), undefined)
  assert.equal(getTaskRegistry().getByToolCallId('tc3'), undefined)
})

test('sync 执行:tool 节点经 runner 路由,结果回传', async () => {
  const calls: Array<{ name: string; params: any }> = []
  const ready = setupProviders(async (name, params) => {
    calls.push({ name, params })
    return { success: true, data: `echo:${params.text}` }
  })
  await ready()
  const result = await executeRunWorkflow('tc10', { name: 'echo-flow', input: { topic: '测试' } }, { sync: true })
  assert.equal(result.success, true, result.error)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'echo_tool')
  assert.match(result.content!, /echo:hello/)
})

test('runner 失败 → sync 报错可读', async () => {
  const ready = setupProviders(async () => ({ success: false, error: '审批被拒绝' }))
  await ready()
  const result = await executeRunWorkflow('tc11', { name: 'echo-flow', input: { topic: 'x' } }, { sync: true })
  // tool 节点失败不中断图(引擎语义:错误消息入 messages),最终回传含失败信息
  assert.equal(result.success, true)
  assert.match(result.content!, /审批被拒绝/)
})

test('异步受理:占位 + 登记 + settle 回流', async () => {
  const ready = setupProviders(async () => ({ success: true, data: 'done' }))
  await ready()
  let settled: any = null
  setDelegationContextProvider(() => ({
    toolMetadata: [],
    toolDefinitions: [
      { type: 'function', function: { name: 'echo_tool', description: '', parameters: { type: 'object', properties: {}, required: [] } } } as any,
    ],
    notifyTaskSettled: (_id, output) => {
      settled = output
    },
  }))
  const result = await executeRunWorkflow('tc20', { name: 'echo-flow', input: { topic: 'x' } })
  assert.equal(result.success, true)
  assert.match(result.content!, /后台执行中/)
  // 登记为 running
  assert.equal(getTaskRegistry().getByToolCallId('tc20')?.status, 'running')
  // 等后台完成
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(getTaskRegistry().getByToolCallId('tc20')?.status, 'completed')
  assert.ok(settled, 'notifyTaskSettled 被调用')
  assert.match(settled.final_output, /done/)
})

test('取消:environment.destroy 中断运行', async () => {
  const ready = setupProviders(async () => {
    // 模拟长任务:轮询 abort 由 guard 抛出(model/tool 处理器入口检查)
    await new Promise((r) => setTimeout(r, 50))
    return { success: true, data: 'late' }
  })
  await ready()
  const { executeCancelTask } = await import('../../../src/services/delegation/delegationTools.ts')
  const result = await executeRunWorkflow('tc30', { name: 'echo-flow', input: { topic: 'x' } })
  assert.equal(result.success, true)
  const cancel = await executeCancelTask({ toolCallId: 'tc30' })
  assert.equal(cancel.success, true)
  assert.equal(getTaskRegistry().getByToolCallId('tc30')?.status, 'cancelled')
})

test('集中预检:引用不存在模板 → 登记前响亮拒绝(不登记/无占位)', async () => {
  const { fs } = makeFakeFs({
    '/home/.chill/workflows/deep-ghost.yaml': `
name: deep-ghost
version: 1
nodes:
  - id: a
    agent: { template: ghost-template }
edges: []
`,
  })
  const { WorkflowTemplateService } = await import('../../../src/services/workflow/WorkflowTemplateService.ts')
  const svc = new WorkflowTemplateService(fs, '/home/.chill/workflows')
  await svc.initialize()
  setWorkflowRunProviders({ getService: () => svc })
  setDelegationContextProvider(() => ({ toolMetadata: [], toolDefinitions: [] }))

  const result = await executeRunWorkflow('tc-pre', { name: 'deep-ghost' })
  assert.equal(result.success, false)
  assert.match(result.error!, /预检失败/)
  assert.match(result.error!, /ghost-template/)
  // 登记前拒绝:注册表无条目
  assert.equal(getTaskRegistry().getByToolCallId('tc-pre'), undefined)
})

test('集中预检:工具不可用 → 登记前响亮拒绝', async () => {
  const { fs } = makeFakeFs({
    '/home/.chill/workflows/needs-tool.yaml': `
name: needs-tool
version: 1
nodes:
  - id: a
    agent:
      system_prompt: x
      tools: [nonexistent_tool]
edges: []
`,
  })
  const { WorkflowTemplateService } = await import('../../../src/services/workflow/WorkflowTemplateService.ts')
  const svc = new WorkflowTemplateService(fs, '/home/.chill/workflows')
  await svc.initialize()
  setWorkflowRunProviders({ getService: () => svc })
  setDelegationContextProvider(() => ({ toolMetadata: [], toolDefinitions: [] }))

  const result = await executeRunWorkflow('tc-pre2', { name: 'needs-tool' })
  assert.equal(result.success, false)
  assert.match(result.error!, /预检失败/)
  assert.match(result.error!, /nonexistent_tool/)
  assert.equal(getTaskRegistry().getByToolCallId('tc-pre2'), undefined)
})
