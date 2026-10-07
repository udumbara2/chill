import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCommonInjectors, ContextAssembler } from '../../src/engine/ContextAssembler.ts'
import { parseTemplate } from '../../src/orchestrator/parsers/TemplateParser.ts'
import type { AssembleContext } from '../../src/engine/types.ts'
import type { SkillMeta } from '../../src/types/skill.ts'

/**
 * per-agent skills/knowledge：模板解析、前台技能过滤、知识目录注入。
 * 注入器经 createCommonInjectors + 最小 stub 门面直测（参考 writeBoundaryInjector.test.ts 模式）。
 */

// ==================== 模板解析 ====================

test('parser: skills/knowledge 合法字符串数组落入模板对象', () => {
  const r = parseTemplate(
    '---\nname: t\nsubagent_type: doc-writer\nskills: [pdf, docx]\nknowledge:\n  - 前端笔记\n---\n正文',
    'm.md',
  )
  assert.equal(r.success, true)
  assert.deepEqual(r.template?.skills, ['pdf', 'docx'])
  assert.deepEqual(r.template?.knowledge, ['前端笔记'])
})

test('parser: skills/knowledge 非字符串数组 → 明确报错', () => {
  const r1 = parseTemplate('---\nname: t\nsubagent_type: doc-writer\nskills: pdf\n---\n正文', 'm.md')
  assert.equal(r1.success, false)
  assert.match(r1.error!, /模板字段 "skills" 必须是非空字符串数组/)
  const r2 = parseTemplate('---\nname: t\nsubagent_type: doc-writer\nknowledge: [1, 2]\n---\n正文', 'm.md')
  assert.equal(r2.success, false)
  assert.match(r2.error!, /模板字段 "knowledge" 必须是非空字符串数组/)
})

test('parser: 不写 skills/knowledge → undefined（向后兼容）', () => {
  const r = parseTemplate('---\nname: t\nsubagent_type: doc-writer\n---\n正文', 'm.md')
  assert.equal(r.success, true)
  assert.equal(r.template?.skills, undefined)
  assert.equal(r.template?.knowledge, undefined)
})

// ==================== 注入器 ====================

function skillMeta(name: string): SkillMeta {
  return { name, description: `${name} 技能`, body: '正文', sourcePath: `/skills/${name}/SKILL.md`, basePath: `/skills/${name}` } as SkillMeta
}

function assemble(deps: Parameters<typeof createCommonInjectors>[0], frontAgent?: string) {
  const assembler = new ContextAssembler({ injectors: createCommonInjectors(deps) })
  const ctx: AssembleContext = { planMode: false, taskToolAvailable: false, frontAgent }
  return assembler.assemblePrefix(ctx)
}

const skillRegistryStub = () => ({ getEnabled: () => [skillMeta('pdf'), skillMeta('docx'), skillMeta('web')] })

test('前台技能过滤: 声明 skills → 清单过滤到声明集；未声明名字附明示行', async () => {
  const messages = await assemble(
    {
      skillRegistry: skillRegistryStub(),
      getSubagentTemplate: () => ({ name: 'w', subagent_type: 'doc-writer', skills: ['pdf', 'pfd'] }) as any,
    },
    'doc-writer',
  )
  const skillMsg = messages.find((m) => typeof m.content === 'string' && m.content.includes('可用技能'))
  assert.ok(skillMsg, '应注入技能清单')
  const content = skillMsg!.content as string
  assert.ok(content.includes('**pdf**'), '声明的 pdf 应在清单内')
  assert.ok(!content.includes('**docx**') && !content.includes('**web**'), '未声明技能应被过滤')
  assert.ok(content.includes('未安装或未启用：pfd'), '缺失名应有明示行')
})

test('前台技能过滤: 未声明 skills → 全量目录（现状兼容）；裸模型不过滤', async () => {
  const m1 = await assemble(
    { skillRegistry: skillRegistryStub(), getSubagentTemplate: () => ({ name: 'w', subagent_type: 'doc-writer' }) as any },
    'doc-writer',
  )
  const c1 = m1.find((m) => typeof m.content === 'string' && m.content.includes('可用技能'))!.content as string
  assert.ok(c1.includes('**pdf**') && c1.includes('**docx**') && c1.includes('**web**'))

  const m2 = await assemble({ skillRegistry: skillRegistryStub() }, undefined)
  const c2 = m2.find((m) => typeof m.content === 'string' && m.content.includes('可用技能'))!.content as string
  assert.ok(c2.includes('**pdf**') && c2.includes('**docx**'))
})

test('agent-knowledge 注入器: 声明 knowledge → 绑定库目录 + 指引；缺失库附明示行', async () => {
  const messages = await assemble(
    {
      knowledgeStore: {
        listKnowledgeBases: async () => [
          { name: '前端笔记', description: 'React 相关', createdAt: '', embeddingModel: '', embeddingDimensions: 0 },
        ],
      },
      getSubagentTemplate: () => ({ name: 'w', subagent_type: 'doc-writer', knowledge: ['前端笔记', '不存在的库'] }) as any,
    },
    'doc-writer',
  )
  const kbMsg = messages.find((m) => typeof m.content === 'string' && m.content.includes('你绑定的知识库'))
  assert.ok(kbMsg, '应注入知识库目录')
  const content = kbMsg!.content as string
  assert.ok(content.includes('前端笔记：React 相关'))
  assert.ok(content.includes('知识库不存在：不存在的库'))
  assert.ok(content.includes('search_knowledge'))
})

test('agent-knowledge 注入器: facade 缺省/未声明/裸模型 → 跳过不崩', async () => {
  // facade 缺省
  const m1 = await assemble({ getSubagentTemplate: () => ({ name: 'w', subagent_type: 'doc-writer', knowledge: ['a'] }) as any }, 'doc-writer')
  assert.ok(!m1.some((m) => typeof m.content === 'string' && m.content.includes('你绑定的知识库')))
  // 未声明
  const m2 = await assemble(
    { knowledgeStore: { listKnowledgeBases: async () => [] }, getSubagentTemplate: () => ({ name: 'w', subagent_type: 'doc-writer' }) as any },
    'doc-writer',
  )
  assert.ok(!m2.some((m) => typeof m.content === 'string' && m.content.includes('你绑定的知识库')))
})
