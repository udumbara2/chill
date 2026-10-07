import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeTemplate } from '../../src/orchestrator/parsers/templateSerializer.ts'
import { parseTemplate } from '../../src/orchestrator/parsers/TemplateParser.ts'
import { getBuiltinTemplates } from '../../src/orchestrator/templates/builtin/index.ts'
import type { SubagentTemplate, TemplatePriority } from '../../src/orchestrator/types.ts'

const BUILTIN_PRIORITY = 3 as TemplatePriority

function makeTemplate(extra: Partial<SubagentTemplate>): SubagentTemplate {
  return {
    name: '测试 Agent',
    subagent_type: 'test-agent',
    description: '测试用',
    priority: BUILTIN_PRIORITY,
    system_prompt: '你是测试 Agent。',
    ...extra,
  }
}

test('round-trip: 仅必填字段，可选字段不落入 frontmatter', () => {
  const t = makeTemplate({})
  const md = serializeTemplate(t)
  const parsed = parseTemplate(md)
  assert.equal(parsed.success, true)
  assert.equal(parsed.template!.name, t.name)
  assert.equal(parsed.template!.subagent_type, t.subagent_type)
  assert.equal(parsed.template!.description, t.description)
  assert.equal(parsed.template!.system_prompt, t.system_prompt)
  // 空可选字段不落 frontmatter
  assert.ok(!md.includes('model:'), '无 model 字段')
  assert.ok(!md.includes('tools:'), '无 tools 字段')
  assert.ok(!md.includes('memory:'), '无 memory 字段')
  assert.ok(!md.includes('skills:'), '无 skills 字段')
})

test('round-trip: 全部可选字段（权限/资源/参数）字段级等价', () => {
  const t = makeTemplate({
    model: 'kimi-k3',
    tools: ['read_file', 'list_files'],
    disallowed_tools: ['execute_powershell'],
    skills: ['pdf', 'docx'],
    knowledge: ['前端笔记'],
    memory: 'project',
    default_parameters: { timeout: 300, max_iterations: 8, temperature: 0.3, max_tokens: 32000 },
    user_prompt_template: '请完成：{{task_description}}',
    tags: ['review', 'quality'],
  })
  const parsed = parseTemplate(serializeTemplate(t))
  assert.equal(parsed.success, true)
  const p = parsed.template!
  assert.equal(p.model, t.model)
  assert.deepEqual(p.tools, t.tools)
  assert.deepEqual(p.disallowed_tools, t.disallowed_tools)
  assert.deepEqual(p.skills, t.skills)
  assert.deepEqual(p.knowledge, t.knowledge)
  assert.equal(p.memory, t.memory)
  assert.deepEqual(p.default_parameters, t.default_parameters)
  assert.equal(p.user_prompt_template, t.user_prompt_template)
  assert.deepEqual(p.tags, t.tags)
})

test('round-trip: readonly 布尔与空数组语义', () => {
  const t = makeTemplate({ readonly: true })
  const parsed = parseTemplate(serializeTemplate(t))
  assert.equal(parsed.success, true)
  assert.equal(parsed.template!.readonly, true)
})

test('内置模板: 序列化→解析字段等价（4 个内置模板）', async () => {
  const builtins = await getBuiltinTemplates()
  assert.equal(builtins.length, 4)
  for (const t of builtins) {
    const parsed = parseTemplate(serializeTemplate(t))
    assert.equal(parsed.success, true, `${t.subagent_type} 序列化后应可解析`)
    const p = parsed.template!
    assert.equal(p.subagent_type, t.subagent_type)
    assert.equal(p.name, t.name)
    assert.equal(p.system_prompt, (t.system_prompt ?? '').trim())
    assert.deepEqual(p.tools ?? undefined, t.tools ?? undefined, `${t.subagent_type} tools 等价`)
    assert.equal(p.readonly, t.readonly, `${t.subagent_type} readonly 等价`)
  }
})

test('纯净: 正文前后空行与内置模板风格一致（frontmatter 闭合后空行起正文）', () => {
  const md = serializeTemplate(makeTemplate({}))
  assert.ok(md.startsWith('---\n'), 'frontmatter 起始')
  assert.ok(md.includes('---\n\n'), 'frontmatter 闭合后空行')
})
