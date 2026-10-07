import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkflowDefinition } from '../../../src/workflow/dsl/workflowParser.ts'
import { definitionToYaml } from '../../../src/workflow/dsl/workflowSerializer.ts'

const VALID = `
name: tech-article
version: 1
description: 调研→撰写→评审
when_to_use: 用户要求写技术文章时
inputs:
  - { name: topic, type: text, description: 文章主题, required: true }
nodes:
  - id: research
    agent:
      system_prompt: 你是调研专员
      tools: [web_search]
  - id: write
    agent: { template: document-writer }
  - id: lint
    tool: { name: run_code, params: { language: shell } }
edges:
  - { from: research, to: write }
  - from: write
    to: lint
    when: { type: content, operator: contains, value: 代码 }
  - { from: write, to: research, fallback: true }
`

test('parse: 合法定义完整解析(含条件边/fallback/inputs)', () => {
  const result = parseWorkflowDefinition(VALID)
  assert.equal(result.success, true, result.error)
  const def = result.definition!
  assert.equal(def.name, 'tech-article')
  assert.equal(def.version, 1)
  assert.equal(def.when_to_use, '用户要求写技术文章时')
  assert.equal(def.inputs.length, 1)
  assert.equal(def.inputs[0].type, 'text')
  assert.equal(def.nodes.length, 3)
  assert.equal(def.nodes[1].agent?.template, 'document-writer')
  assert.equal(def.edges.length, 3)
  const cond = def.edges.find((e) => e.when)
  assert.equal(cond?.when?.type, 'content')
  const fb = def.edges.find((e) => e.fallback)
  assert.equal(fb?.to, 'research')
})

test('parse: 缺 name 报错', () => {
  const r = parseWorkflowDefinition('version: 1\nnodes: [{id: a, agent: {system_prompt: x}}]')
  assert.equal(r.success, false)
  assert.match(r.error!, /缺少必填字段 "name"/)
})

test('parse: name 非 kebab-case 报错', () => {
  const r = parseWorkflowDefinition('name: Tech_Article\nversion: 1\nnodes: [{id: a, agent: {system_prompt: x}}]')
  assert.equal(r.success, false)
  assert.match(r.error!, /命名规范/)
})

test('parse: 缺 version / 更高 version 报错', () => {
  const r1 = parseWorkflowDefinition('name: a\nnodes: [{id: a, agent: {system_prompt: x}}]')
  assert.equal(r1.success, false)
  assert.match(r1.error!, /version/)
  const r2 = parseWorkflowDefinition('name: a\nversion: 99\nnodes: [{id: a, agent: {system_prompt: x}}]')
  assert.equal(r2.success, false)
  assert.match(r2.error!, /不支持的 DSL 版本/)
})

test('parse: nodes 为空报错', () => {
  const r = parseWorkflowDefinition('name: a\nversion: 1\nnodes: []')
  assert.equal(r.success, false)
  assert.match(r.error!, /至少包含 1 个节点/)
})

test('parse: 节点 id 重复/非法报错', () => {
  const dup = 'name: a\nversion: 1\nnodes:\n  - {id: a, agent: {system_prompt: x}}\n  - {id: a, agent: {system_prompt: y}}'
  assert.match(parseWorkflowDefinition(dup).error!, /重复/)
  const bad = 'name: a\nversion: 1\nnodes: [{id: "1bad", agent: {system_prompt: x}}]'
  assert.match(parseWorkflowDefinition(bad).error!, /不符合规范/)
  const reserved = 'name: a\nversion: 1\nnodes: [{id: start, agent: {system_prompt: x}}]'
  assert.match(parseWorkflowDefinition(reserved).error!, /保留字/)
})

test('parse: agent/template 互斥与必填', () => {
  const both = 'name: a\nversion: 1\nnodes: [{id: a, agent: {template: t-x, system_prompt: x}}]'
  assert.match(parseWorkflowDefinition(both).error!, /互斥/)
  const none = 'name: a\nversion: 1\nnodes: [{id: a, agent: {}}]'
  assert.match(parseWorkflowDefinition(none).error!, /template 或内联/)
  const bothKinds = 'name: a\nversion: 1\nnodes: [{id: a, agent: {system_prompt: x}, tool: {name: t}}]'
  assert.match(parseWorkflowDefinition(bothKinds).error!, /恰好包含 agent 或 tool 其一/)
})

test('parse: 边引用不存在节点 / when+fallback 互斥 / 多 fallback 报错', () => {
  const base = (edges: string) => `name: a\nversion: 1\nnodes:\n  - {id: a, agent: {system_prompt: x}}\n  - {id: b, agent: {system_prompt: y}}\n  - {id: c, agent: {system_prompt: z}}\nedges:\n${edges}`
  assert.match(parseWorkflowDefinition(base('  - {from: a, to: ghost}')).error!, /不存在的节点/)
  assert.match(
    parseWorkflowDefinition(base('  - {from: a, to: b, when: {type: tool_call}, fallback: true}')).error!,
    /互斥/,
  )
  assert.match(
    parseWorkflowDefinition(base('  - {from: a, to: b, fallback: true}\n  - {from: a, to: c, fallback: true}')).error!,
    /多条 fallback/,
  )
})

test('parse: 条件表达式校验(无效 operator / 缺 value)', () => {
  const mk = (cond: string) =>
    `name: a\nversion: 1\nnodes:\n  - {id: a, agent: {system_prompt: x}}\n  - {id: b, agent: {system_prompt: y}}\nedges:\n  - {from: a, to: b, when: ${cond}}`
  assert.match(parseWorkflowDefinition(mk('{type: content, operator: bogus, value: x}')).error!, /operator 无效/)
  assert.match(parseWorkflowDefinition(mk('{type: state_field, field: f, operator: eq}')).error!, /缺少 value/)
  assert.match(parseWorkflowDefinition(mk('{type: unknown_type}')).error!, /when\.type/)
})

test('parse: inputs 校验(重名/非法 type)', () => {
  const dup = 'name: a\nversion: 1\ninputs: [{name: x}, {name: x}]\nnodes: [{id: a, agent: {system_prompt: x}}]'
  assert.match(parseWorkflowDefinition(dup).error!, /重名入参/)
  const badType = 'name: a\nversion: 1\ninputs: [{name: x, type: number}]\nnodes: [{id: a, agent: {system_prompt: x}}]'
  assert.match(parseWorkflowDefinition(badType).error!, /text 或 file/)
})

test('parse: YAML 语法错误可读报错', () => {
  const r = parseWorkflowDefinition('name: [unclosed')
  assert.equal(r.success, false)
  assert.match(r.error!, /YAML 解析失败/)
})

test('parse: agent 节点模板全字段(权限/驮具/执行参数)完整解析', () => {
  const yaml = `
name: full-fields
version: 1
nodes:
  - id: a
    agent:
      system_prompt: 专家
      model: gpt-5
      default_parameters: { temperature: 0.2 }
      tools: [read_file, web_search]
      disallowed_tools: [execute_powershell]
      readonly: true
      memory: project
      skills: [pdf]
      knowledge: [前端笔记]
      max_iterations: 8
      max_turns: 5
      prompt: "主题:{{input.topic}},上一轮:{{prev}},调研结果:{{nodes.research}}"
`
  const r = parseWorkflowDefinition(yaml)
  assert.equal(r.success, true, r.error)
  const a = r.definition!.nodes[0].agent!
  assert.equal(a.model, 'gpt-5')
  assert.deepEqual(a.default_parameters, { temperature: 0.2 })
  assert.deepEqual(a.disallowed_tools, ['execute_powershell'])
  assert.equal(a.readonly, true)
  assert.equal(a.memory, 'project')
  assert.deepEqual(a.skills, ['pdf'])
  assert.deepEqual(a.knowledge, ['前端笔记'])
  assert.equal(a.max_iterations, 8)
  assert.equal(a.max_turns, 5)
  assert.ok(a.prompt?.includes('{{nodes.research}}'))
})

test('parse: template 与任意内联字段互斥(全集)', () => {
  const fields = ['system_prompt: x', 'model: gpt-5', 'default_parameters: {}', 'tools: [a]', 'disallowed_tools: [b]', 'readonly: true', 'memory: user', 'skills: [pdf]', 'knowledge: [kb]', 'max_iterations: 3']
  for (const f of fields) {
    const yaml = `name: a\nversion: 1\nnodes:\n  - id: n\n    agent:\n      template: t-x\n      ${f}`
    const r = parseWorkflowDefinition(yaml)
    assert.equal(r.success, false, `应拒绝 template+${f}`)
    assert.match(r.error!, /互斥/)
  }
})

test('parse: 驮具/执行字段校验(readonly/memory/max_iterations/max_turns)', () => {
  const mk = (f: string) => `name: a\nversion: 1\nnodes: [{id: n, agent: {system_prompt: x, ${f}}}]`
  assert.match(parseWorkflowDefinition(mk('readonly: "yes"')).error!, /readonly 必须是布尔值/)
  assert.match(parseWorkflowDefinition(mk('memory: global')).error!, /user\/project\/local/)
  assert.match(parseWorkflowDefinition(mk('max_iterations: 0')).error!, /max_iterations 必须是 ≥1/)
  assert.match(parseWorkflowDefinition(mk('max_turns: 1.5')).error!, /max_turns 必须是 ≥1/)
})

test('parse: 字符串数组字段统一规则(空数组归一化+警告;关键字规则;浅节点 [all] 报错)', () => {
  const mk = (f: string) => `name: a\nversion: 1\nnodes: [{id: n, agent: {system_prompt: x, ${f}}}]`
  // 四字段空数组 → 加载成功 + 卫生通知(infos,不上 UI)
  for (const field of ['tools', 'disallowed_tools', 'skills', 'knowledge']) {
    const r = parseWorkflowDefinition(mk(`${field}: []`))
    assert.equal(r.success, true, `${field} 空数组应正常加载`)
    assert.equal((r.definition!.nodes[0].agent as any)![field], undefined, `${field} 应归一化为省略`)
    assert.ok(r.infos?.some((i) => i.includes('空数组已按未声明处理')), `${field} 应有卫生通知`)
    assert.ok(!r.warnings?.some((w) => w.includes('空数组')), `${field} 无损归一化不应占用警告通道`)
  }
  // [none] 归一化 + 卫生通知;[none, x] 混写报错
  const none = parseWorkflowDefinition(mk('tools: [none]'))
  assert.equal(none.success, true)
  assert.equal(none.definition!.nodes[0].agent!.tools, undefined)
  assert.ok(none.infos?.some((i) => i.includes('none 仅在委派层')))
  assert.match(parseWorkflowDefinition(mk('tools: [none, read_file]')).error!, /语义矛盾/)
  // none/all 出现在其他字段 → 报错
  assert.match(parseWorkflowDefinition(mk('skills: [all]')).error!, /不支持关键字/)
  // 浅节点(无驮具字段)写 [all] → 报错;深绑定节点(驮 memory)写 [all] → 合法
  assert.match(parseWorkflowDefinition(mk('tools: [all]')).error!, /浅节点不支持 \[all\]/)
  const deep = parseWorkflowDefinition(mk('tools: [all], memory: user'))
  assert.equal(deep.success, true, deep.error)
  assert.deepEqual(deep.definition!.nodes[0].agent!.tools, ['all'])
  // 深绑定节点 [all] + memory → 无 hedged 警告;深绑定零工具 + memory → hedged 警告
  assert.ok(!deep.warnings?.some((w) => w.includes('零工具下可能部分不生效')))
  const deepZero = parseWorkflowDefinition(mk('memory: user'))
  assert.ok(deepZero.warnings?.some((w) => w.includes('零工具下可能部分不生效')))
})

test('parse: prompt 变量白名单(非法变量响亮报错)', () => {
  const mk = (p: string) => `name: a\nversion: 1\nnodes: [{id: n, agent: {system_prompt: x, prompt: "${p}"}}]`
  assert.equal(parseWorkflowDefinition(mk('{{prev}}')).success, true)
  assert.equal(parseWorkflowDefinition(mk('{{input.topic}}')).success, true)
  assert.equal(parseWorkflowDefinition(mk('{{nodes.research}}')).success, true)
  assert.match(parseWorkflowDefinition(mk('{{unknown}}')).error!, /非法变量/)
  assert.match(parseWorkflowDefinition(mk('{{nodes.9bad}}')).error!, /非法变量/)
  assert.match(parseWorkflowDefinition(mk('{{input.}}')).error!, /非法变量/)
})

test('parse: 旧对象形态 model 兼容映射(读取映射,保存写新结构)', () => {
  const yaml = `name: a\nversion: 1\nnodes:\n  - id: n\n    agent:\n      system_prompt: x\n      model: { name: gpt-5, provider: openai, parameters: { temperature: 0.3 } }`
  const r = parseWorkflowDefinition(yaml)
  assert.equal(r.success, true, r.error)
  assert.equal(r.definition!.nodes[0].agent!.model, 'gpt-5')
  assert.deepEqual(r.definition!.nodes[0].agent!.default_parameters, { temperature: 0.3 })
  // 保存(序列化)写新结构:不再有对象形态 model
  const out = definitionToYaml(r.definition!)
  assert.ok(!out.includes('provider'))
  assert.ok(out.includes('model: gpt-5'))
})
