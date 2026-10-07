import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentNodeExecutor,
  ephemeralTemplate,
  renderNodePrompt,
  type AgentNodeDeps,
} from '../../src/workflow/agentNodeExecutor.ts'
import { isDeepAgentNode } from '../../src/workflow/dsl/types.ts'
import { definitionToEngineConfig } from '../../src/workflow/dsl/workflowSerializer.ts'
import { parseWorkflowDefinition } from '../../src/workflow/dsl/workflowParser.ts'
import { TaskExecutionStatus } from '../../src/orchestrator/types.ts'
import { MessageRole } from '../../src/services/models/types.ts'
import type { WorkflowState } from '../../src/workflow/shared.ts'
import type { SubagentTemplate } from '../../src/orchestrator/types.ts'

function makeState(messages: string[], nodeOutputs: Record<string, string> = {}): WorkflowState {
  return {
    messages: messages.map((c) => ({ role: MessageRole.USER, content: c, timestamp: new Date() })),
    modelConfigs: {},
    selectedToolsMap: {},
    toolParamsMap: {},
    toolResultsMap: {},
    executionResults: [],
    currentNode: '',
    systemPrompts: {},
    iterationCount: 0,
    branchLoopCounts: {},
    codeExecutorConfigs: {},
    nodeOutputs,
  }
}

const NAMED: SubagentTemplate = {
  name: '调研专家',
  subagent_type: 'researcher',
  description: '',
  priority: 3,
  parameters: {},
  system_prompt: '你是调研专家',
  user_prompt_template: '请调研:{{prev}}',
  tools: ['web_search'],
  memory: 'user',
} as unknown as SubagentTemplate

function makeDeps(overrides: Partial<AgentNodeDeps> = {}): AgentNodeDeps & { calls: any[] } {
  const calls: any[] = []
  return {
    calls,
    workflowName: 'demo',
    resolveTemplate: (t) => (t === 'researcher' ? NAMED : undefined),
    allToolDefinitions: () => [{ function: { name: 'web_search' } }, { function: { name: 'read_file' } }] as any,
    executeTemplate: async (template, taskDescription, tools, availableTools, environmentKey) => {
      calls.push({ template, taskDescription, tools, availableTools, environmentKey })
      return { status: TaskExecutionStatus.COMPLETED, final_output: `交付:${taskDescription}` }
    },
    inputValues: { topic: 'RAG' },
    environmentKeyFor: (nodeId) => `run__node_${nodeId}`,
    ...overrides,
  } as AgentNodeDeps & { calls: any[] }
}

test('深节点:具名模板经委派通道执行,最终交付入状态流与 nodeOutputs', async () => {
  const deps = makeDeps()
  const node = { id: 'research', agent: { template: 'researcher' } }
  const state = makeState(['上游材料'])
  const next = await agentNodeExecutor(state, 'research', node as any, deps)
  assert.equal(deps.calls.length, 1)
  assert.equal(deps.calls[0].template.subagent_type, 'researcher')
  // 任务说明:模板 user_prompt_template 渲染 {{prev}}
  assert.equal(deps.calls[0].taskDescription, '请调研:上游材料')
  // 统一收敛:传全量工具定义池 + availableTools 未指定(模板默认在 executor 优先级链解析)
  assert.equal(deps.calls[0].availableTools, undefined)
  assert.equal(deps.calls[0].tools.length, 2, '应传全量工具定义池')
  const last = next.messages[next.messages.length - 1]
  assert.equal(last.content, '交付:请调研:上游材料')
  assert.equal(next.nodeOutputs!['research'], '交付:请调研:上游材料')
})

test('深节点:匿名内联构造临时模板(wf_<workflow>_<nodeId>),max_turns 进 default_parameters', async () => {
  const deps = makeDeps()
  const t = ephemeralTemplate('demo', 'refactor', {
    system_prompt: '你是重构专家',
    tools: ['read_file'],
    memory: 'project',
    max_turns: 5,
  })
  assert.equal(t.subagent_type, 'wf_demo_refactor')
  assert.equal(t.memory, 'project')
  assert.equal(t.default_parameters!.max_iterations, 5)
})

test('任务说明优先级链:节点 prompt > 模板 user_prompt_template > {{prev}}', () => {
  const state = makeState(['材料A'], { research: '调研结论B' })
  // 节点 prompt 优先
  const n1 = { id: 'x', agent: { template: 'researcher', prompt: '主题:{{input.topic}}' } }
  assert.equal(renderNodePrompt(n1 as any, NAMED, state, { topic: 'RAG' }), '主题:RAG')
  // 模板 user_prompt_template 次之
  const n2 = { id: 'x', agent: { template: 'researcher' } }
  assert.equal(renderNodePrompt(n2 as any, NAMED, state, {}), '请调研:材料A')
  // 缺省 {{prev}}
  const n3 = { id: 'x', agent: { system_prompt: 'y' } }
  assert.equal(renderNodePrompt(n3 as any, undefined, state, {}), '材料A')
  // {{nodes.<id>}} 引用指定节点产出
  const n4 = { id: 'x', agent: { system_prompt: 'y', prompt: '基于{{nodes.research}}总结' } }
  assert.equal(renderNodePrompt(n4 as any, undefined, state, {}), '基于调研结论B总结')
  // {{nodes.<id>}} 无产出 → 响亮报错
  assert.throws(() => renderNodePrompt(n4 as any, undefined, makeState(['m']), {}), /尚无产出/)
})

test('业务失败入状态流(模板不存在/Worker 失败),不中断', async () => {
  const deps = makeDeps()
  const missing = await agentNodeExecutor(makeState(['m']), 'x', { id: 'x', agent: { template: 'ghost' } } as any, deps)
  assert.match(String(missing.messages[missing.messages.length - 1].content), /不存在/)

  const failDeps = makeDeps({
    executeTemplate: async () => ({
      status: TaskExecutionStatus.FAILED,
      final_output: '',
      error_info: { code: 'X', message: '模型超时' },
    }),
  })
  const failed = await agentNodeExecutor(makeState(['m']), 'x', { id: 'x', agent: { template: 'researcher' } } as any, failDeps)
  assert.match(String(failed.messages[failed.messages.length - 1].content), /模型超时/)
})

test('深绑定判定:定义映射产生 agent 节点类型(引用/驮具字段),内联裸定义保持 model', () => {
  const yaml = `
name: d
version: 1
nodes:
  - id: a
    agent: { template: researcher }
  - id: b
    agent: { system_prompt: x, memory: user }
  - id: c
    agent: { system_prompt: y, tools: [read_file] }
edges:
  - { from: a, to: b }
  - { from: b, to: c }
`
  const def = parseWorkflowDefinition(yaml).definition!
  assert.equal(isDeepAgentNode(def.nodes[0]), true)
  assert.equal(isDeepAgentNode(def.nodes[1]), true)
  assert.equal(isDeepAgentNode(def.nodes[2]), false)
  const { nodes } = definitionToEngineConfig(def)
  assert.deepEqual(
    nodes.map((n) => n.type),
    ['start', 'agent', 'agent', 'model'],
  )
  // agent 节点 data 携带 DSL 配置
  assert.ok((nodes[1] as any).data.template === 'researcher')
})
