import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkflowDefinition } from '../../../src/workflow/dsl/workflowParser.ts'
import {
  definitionToYaml,
  definitionToCanvas,
  canvasToDefinition,
  definitionToEngineConfig,
  definitionToEngineInput,
  START_NODE_ID,
} from '../../../src/workflow/dsl/workflowSerializer.ts'
import type { WorkflowDefinition } from '../../../src/workflow/dsl/types.ts'
import type { SubagentTemplate } from '../../../src/orchestrator/types.ts'

function sampleDef(): WorkflowDefinition {
  const yaml = `
name: tech-article
version: 1
description: 调研→撰写
when_to_use: 写技术文章时
inputs:
  - { name: topic, type: text, required: true }
nodes:
  - id: research
    label: 调研
    position: { x: 100, y: 50 }
    agent:
      system_prompt: 你是调研专员
      model: { name: gpt-5, provider: openai, parameters: { temperature: 0.3 } }
      tools: [web_search]
  - id: write
    agent: { template: document-writer }
  - id: lint
    tool: { name: run_code, params: { language: shell, interactive: true } }
edges:
  - { from: research, to: write }
  - from: write
    to: lint
    when: { type: content, operator: contains, value: 代码 }
    priority: 1
  - { from: write, to: research, fallback: true }
`
  const result = parseWorkflowDefinition(yaml)
  assert.equal(result.success, true, result.error)
  return result.definition!
}

/** 规范化比较:字段序无关、undefined 字段剔除 */
function normalize(def: WorkflowDefinition): string {
  return JSON.stringify(def, Object.keys(def).sort())
}

test('round-trip: Definition → YAML → parse 无损', () => {
  const def = sampleDef()
  const text = definitionToYaml(def)
  const back = parseWorkflowDefinition(text)
  assert.equal(back.success, true, back.error)
  assert.equal(normalize(back.definition!), normalize(def))
})

test('round-trip: Definition → 画布 → Definition 无损(剥 start/保留条件边与 position)', () => {
  const def = sampleDef()
  const { nodes, edges } = definitionToCanvas(def)

  // 画布投影:start 节点被合成,类型映射 model/tool/code
  assert.ok(nodes.find((n) => n.id === START_NODE_ID && n.type === 'start'))
  assert.equal(nodes.find((n) => n.id === 'research')?.type, 'model')
  assert.equal(nodes.find((n) => n.id === 'lint')?.type, 'code')
  // start → 零入度节点(research)
  assert.ok(edges.find((e) => e.source === START_NODE_ID && e.target === 'research'))

  const back = canvasToDefinition(nodes, edges, {
    name: def.name,
    version: def.version,
    description: def.description,
    when_to_use: def.when_to_use,
    inputs: def.inputs,
  })
  // 逐字段比对(忽略 label 默认值差异:未显式 label 的节点画布回填 id)
  assert.equal(back.name, def.name)
  assert.equal(back.nodes.length, def.nodes.length)
  const research = back.nodes.find((n) => n.id === 'research')!
  assert.equal(research.agent?.system_prompt, '你是调研专员')
  assert.deepEqual(research.agent?.tools, ['web_search'])
  // 旧对象形态 model 经兼容映射:model 字符串 + default_parameters
  assert.equal(research.agent?.model, 'gpt-5')
  assert.deepEqual(research.agent?.default_parameters, { temperature: 0.3 })
  assert.deepEqual(research.position, { x: 100, y: 50 })
  assert.equal(back.nodes.find((n) => n.id === 'write')?.agent?.template, 'document-writer')
  const lint = back.nodes.find((n) => n.id === 'lint')!
  assert.equal(lint.tool?.name, 'run_code')
  assert.deepEqual(lint.tool?.params, { language: 'shell', interactive: true })
  // 边:普通边 + 条件边 + fallback 边全回来
  assert.equal(back.edges.length, def.edges.length)
  const cond = back.edges.find((e) => e.when)
  assert.equal(cond?.to, 'lint')
  assert.equal(cond?.when?.type, 'content')
  assert.ok(back.edges.find((e) => e.fallback && e.to === 'research'))
})

test('引擎投影:合成 start 节点与入边;条件边合并为 branches', () => {
  const def = sampleDef()
  const { nodes, edges } = definitionToEngineConfig(def)
  assert.equal(nodes[0].id, START_NODE_ID)
  assert.equal(nodes[0].type, 'start')
  assert.deepEqual(
    nodes.slice(1).map((n) => n.type),
    ['model', 'agent', 'code'],
  )
  const startEdges = edges.filter((e: any) => e.source === START_NODE_ID)
  assert.equal(startEdges.length, 1)
  assert.equal((startEdges[0] as any).target, 'research')
  const cond = edges.find((e: any) => e.type === 'conditional') as any
  assert.ok(cond, '存在条件边')
  assert.equal(cond.source, 'write')
  assert.equal(cond.data.branches.length, 1)
  assert.equal(cond.data.branches[0].targetNodeId, 'lint')
  assert.equal(cond.data.branches[0].priority, 1)
  assert.equal(cond.data.fallbackNodeId, 'research')
})

test('引擎输入投影:内联与模板引用展开;未知模板/工具进 errors', () => {
  const def = sampleDef()
  const template: SubagentTemplate = {
    name: '文档撰写助手',
    subagent_type: 'document-writer',
    description: '',
    system_prompt: '你是撰稿人',
    priority: 3,
    parameters: {},
    tools: ['create_file'],
  } as unknown as SubagentTemplate

  const resolver = {
    resolveTemplate: (t: string) => (t === 'document-writer' ? template : undefined),
    resolveTools: (names: string[]) => names.map((name) => ({ name }) as any),
  }
  const maps = definitionToEngineInput(def, resolver)
  assert.equal(maps.errors.length, 0)
  assert.equal(maps.systemPrompts['research'], '你是调研专员')
  assert.equal(maps.systemPrompts['write'], '你是撰稿人')
  assert.equal(maps.modelConfigs['research'].model, 'gpt-5')
  assert.equal(maps.modelConfigs['research'].temperature, 0.3)
  assert.deepEqual(maps.selectedToolsMap['research'].map((t: any) => t.name), ['web_search'])
  assert.deepEqual(maps.selectedToolsMap['write'].map((t: any) => t.name), ['create_file'])
  assert.equal(maps.codeExecutorConfigs['lint'].interactiveMode, true)

  // 未知模板 → 可读错误
  const bad: WorkflowDefinition = {
    ...def,
    nodes: [{ id: 'x', agent: { template: 'ghost-template' } }],
  }
  const maps2 = definitionToEngineInput(bad, resolver)
  assert.equal(maps2.errors.length, 1)
  assert.match(maps2.errors[0], /ghost-template/)
})

test('运行时状态剥离:画布节点带 executionResult 时不进 Definition', () => {
  const def = sampleDef()
  const { nodes, edges } = definitionToCanvas(def)
  const research = nodes.find((n) => n.id === 'research')! as any
  research.data.executionResult = { contentBlocks: ['x'], resultType: 'text', nodeStatus: 'completed' }
  research.data.onExecute = () => {}
  research.selected = true
  const back = canvasToDefinition(nodes, edges, {
    name: def.name,
    version: def.version,
    inputs: def.inputs,
  })
  const yaml = definitionToYaml(back)
  assert.ok(!yaml.includes('executionResult'))
  assert.ok(!yaml.includes('onExecute'))
  assert.ok(!yaml.includes('selected'))
})

test('权限过滤:内联 readonly/disallowed_tools 在引擎输入构建时生效', () => {
  const yaml = `
name: perm
version: 1
nodes:
  - id: a
    agent:
      system_prompt: x
      tools: [read_file, create_file, web_search, execute_powershell]
      disallowed_tools: [web_search]
      readonly: true
  - id: b
    agent:
      system_prompt: y
      tools: [read_file, create_file]
`
  const def = parseWorkflowDefinition(yaml).definition!
  const resolver = {
    resolveTemplate: () => undefined,
    resolveTools: (names: string[]) => names.map((name) => ({ name }) as any),
  }
  const maps = definitionToEngineInput(def, resolver)
  // a: disallowed 扣 web_search,readonly 扣 create_file/execute_powershell(PLAN_MODE_BLOCKED_TOOLS)→ 只剩 read_file
  assert.deepEqual(
    maps.selectedToolsMap['a'].map((t: any) => t.name),
    ['read_file'],
  )
  // b: 无权限字段 → create_file 保留
  assert.deepEqual(
    maps.selectedToolsMap['b'].map((t: any) => t.name).sort(),
    ['create_file', 'read_file'],
  )
})

test('权限过滤:模板引用的 readonly/disallowed 经 toolPolicy 同规则过滤', () => {
  const yaml = `
name: perm-tpl
version: 1
nodes:
  - id: a
    agent: { template: restricted }
`
  const def = parseWorkflowDefinition(yaml).definition!
  const template = {
    name: '受限专家',
    subagent_type: 'restricted',
    description: '',
    system_prompt: '受限',
    priority: 3,
    parameters: {},
    tools: ['read_file', 'create_file', 'web_search'],
    readonly: true,
    disallowed_tools: ['web_search'],
  } as any
  const maps = definitionToEngineInput(def, {
    resolveTemplate: (t: string) => (t === 'restricted' ? template : undefined),
    resolveTools: (names: string[]) => names.map((name) => ({ name }) as any),
  })
  assert.deepEqual(
    maps.selectedToolsMap['a'].map((t: any) => t.name),
    ['read_file'],
  )
})

test('引擎输入投影:新形态 model(字符串)+ default_parameters 透传', () => {
  const yaml = `
name: model-form
version: 1
nodes:
  - id: a
    agent:
      system_prompt: x
      model: gpt-5
      default_parameters: { temperature: 0.2 }
`
  const def = parseWorkflowDefinition(yaml).definition!
  const maps = definitionToEngineInput(def, { resolveTemplate: () => undefined, resolveTools: () => [] })
  assert.equal(maps.modelConfigs['a'].model, 'gpt-5')
  assert.equal(maps.modelConfigs['a'].temperature, 0.2)
})

test('循环上限单一出口:画布只写 max_turns;旧 max_iterations 画布数据与 YAML 兼容读', async () => {
  const { canvasToDefinition, definitionToCanvas, definitionToYaml } = await import('../../../src/workflow/dsl/workflowSerializer.ts')
  // 画布数据双字段入(旧草稿带 maxIterations)→ 只写 max_turns
  const def = canvasToDefinition(
    [{ id: 'a', type: 'model', position: { x: 0, y: 0 }, data: { systemPrompt: 'x', maxTurns: 5 } } as any],
    [],
    { name: 'loop-cap', version: 1 },
  )
  const a = def.nodes[0].agent!
  assert.equal(a.max_turns, 5)
  assert.equal(a.max_iterations, undefined, '不再写 max_iterations')
  // 旧画布草稿只有 maxIterations → 兼容读为 max_turns
  const legacy = canvasToDefinition(
    [{ id: 'a', type: 'model', position: { x: 0, y: 0 }, data: { systemPrompt: 'x', maxIterations: 3 } } as any],
    [],
    { name: 'loop-cap', version: 1 },
  )
  assert.equal(legacy.nodes[0].agent!.max_turns, 3)
  assert.equal(legacy.nodes[0].agent!.max_iterations, undefined)
  // 旧 YAML(max_iterations)经 definitionToCanvas 兼容读入 maxTurns
  const yamlDef = parseWorkflowDefinition(`name: loop-cap\nversion: 1\nnodes: [{id: a, agent: {system_prompt: x, max_iterations: 7}}]`).definition!
  const { nodes } = definitionToCanvas(yamlDef)
  assert.equal(((nodes.find((n: any) => n.id === 'a'))!.data as any).maxTurns, 7)
  // 序列化文本不再出现 max_iterations
  const text = definitionToYaml(def)
  assert.ok(!text.includes('max_iterations'))
})
