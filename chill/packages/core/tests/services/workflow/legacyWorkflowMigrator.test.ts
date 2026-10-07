import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  migrateLegacyWorkflowAssets,
  legacyGraphToDefinition,
  slugifyWorkflowKey,
} from '../../../src/services/workflow/legacyWorkflowMigrator.ts'
import { parseWorkflowDefinition } from '../../../src/workflow/dsl/workflowParser.ts'
import { definitionToYaml } from '../../../src/workflow/dsl/workflowSerializer.ts'
import type { IFileSystemProvider } from '../../../src/interfaces/IFileSystemProvider.ts'

function makeFakeFs(files: Record<string, string>) {
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
    getPathType: async (p: string) => ({
      success: true,
      data: { type: map.has(norm(p)) ? ('file' as const) : ('not_found' as const) },
    }),
  }
  return { fs, map }
}

const LEGACY_WORKFLOW = JSON.stringify({
  metadata: { id: '1700000000000', name: '技术文章生产线', createdAt: 1, updatedAt: 2, version: 3 },
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: '开始', textInput: 'x' } },
    {
      id: 'n1',
      type: 'model',
      position: { x: 100, y: 0 },
      data: {
        label: '调研',
        systemPrompt: '你是调研专员',
        selectedModel: { id: 'gpt-5', name: 'gpt-5', provider: 'openai' },
        parameters: { temperature: 0.3 },
        selectedTools: [{ type: 'function', function: { name: 'web_search', description: '', parameters: {} } }],
        executionResult: { contentBlocks: ['旧运行时状态'], resultType: 'text', nodeStatus: 'completed' },
      },
    },
    {
      id: 'n2',
      type: 'tool',
      position: { x: 200, y: 0 },
      data: {
        label: '保存',
        selectedTools: [{ type: 'function', function: { name: 'create_file', description: '', parameters: {} } }],
        toolParams: { create_file: { path: '/tmp/out.md' } },
      },
    },
  ],
  edges: [
    { id: 'e0', source: 'start', target: 'n1', type: 'default' },
    { id: 'e1', source: 'n1', target: 'n2', type: 'default' },
  ],
})

const LEGACY_MULTI_NODE_AGENT = JSON.stringify({
  metadata: { id: 'agent-1', name: 'review pipeline', createdAt: 1, updatedAt: 2, version: 1, sourceWorkflowId: 'x', autoSyncEnabled: true },
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: '开始' } },
    { id: 'a', type: 'model', position: { x: 0, y: 0 }, data: { label: 'A', systemPrompt: '甲' } },
    { id: 'b', type: 'model', position: { x: 0, y: 0 }, data: { label: 'B', systemPrompt: '乙' } },
  ],
  edges: [
    { id: 'e0', source: 'start', target: 'a', type: 'default' },
    { id: 'e1', source: 'a', target: 'b', type: 'default' },
    // 旧版条件边(data.condition 无 branches)
    { id: 'e2', source: 'b', target: 'a', type: 'conditional', data: { condition: { type: 'content', operator: 'contains', value: '重做' } } },
  ],
})

const LEGACY_SINGLE_NODE_AGENT = JSON.stringify({
  metadata: { id: 'agent-2', name: 'solo', createdAt: 1, updatedAt: 2, version: 1 },
  nodes: [{ id: 'only', type: 'model', position: { x: 0, y: 0 }, data: { label: 'solo', systemPrompt: '单' } }],
  edges: [],
})

test('slugify:中文名兜底确定性键;拉丁名正常派生', () => {
  assert.equal(slugifyWorkflowKey('review pipeline', '1'), 'review-pipeline')
  assert.equal(slugifyWorkflowKey('技术文章生产线', '1700000000000'), 'wf-1700000000000')
})

test('迁移:SavedWorkflow → YAML,剥运行时状态,删源文件,可解析', async () => {
  const { fs, map } = makeFakeFs({
    '/ud/workflows/1700000000000.json': LEGACY_WORKFLOW,
  })
  const report = await migrateLegacyWorkflowAssets(fs, {
    legacyWorkflowsDir: '/ud/workflows',
    targetDir: '/home/.chill/workflows',
  })
  assert.equal(report.errors.length, 0)
  assert.equal(report.migrated.length, 1)
  // 中文名兜底键
  assert.ok(report.migrated[0].includes('wf-1700000000000.yaml'))
  const yaml = map.get('/home/.chill/workflows/wf-1700000000000.yaml')!
  assert.ok(yaml)
  // 运行时状态不进文件
  assert.ok(!yaml.includes('executionResult'))
  assert.ok(!yaml.includes('旧运行时状态'))
  // 源文件已删
  assert.ok(!map.has('/ud/workflows/1700000000000.json'))
  // 可解析且结构正确
  const parsed = parseWorkflowDefinition(yaml)
  assert.equal(parsed.success, true, parsed.error)
  const def = parsed.definition!
  assert.equal(def.title, '技术文章生产线')
  assert.equal(def.nodes.length, 2) // start 消亡
  const n1 = def.nodes.find((n) => n.id === 'n1')!
  assert.equal(n1.agent?.system_prompt, '你是调研专员')
  assert.deepEqual(n1.agent?.tools, ['web_search'])
  // 旧画布 selectedModel → 模板形态 model(字符串)+ default_parameters
  assert.equal(n1.agent?.model, 'gpt-5')
  assert.deepEqual(n1.agent?.default_parameters, { temperature: 0.3 })
  const n2 = def.nodes.find((n) => n.id === 'n2')!
  assert.equal(n2.tool?.name, 'create_file')
  assert.deepEqual(n2.tool?.params, { path: '/tmp/out.md' })
  assert.equal(def.edges.length, 1)
  assert.equal(def.edges[0].from, 'n1')
  assert.equal(def.edges[0].to, 'n2')
  assert.equal(def.edges[0].when, undefined)
})

test('迁移:多节点 SavedAgent → YAML(含旧版条件边归一化);单节点跳过', async () => {
  const { fs, map } = makeFakeFs({
    '/ud/agents/local/agent-1.json': LEGACY_MULTI_NODE_AGENT,
    '/ud/agents/local/agent-2.json': LEGACY_SINGLE_NODE_AGENT,
  })
  const report = await migrateLegacyWorkflowAssets(fs, {
    legacyWorkflowsDir: '/ud/workflows',
    legacyAgentsDir: '/ud/agents/local',
    targetDir: '/home/.chill/workflows',
  })
  assert.equal(report.errors.length, 0, report.errors.join(';'))
  assert.equal(report.migrated.length, 1)
  assert.equal(report.skipped.length, 1)
  assert.ok(report.skipped[0].includes('单节点'))

  const yaml = map.get('/home/.chill/workflows/review-pipeline.yaml')!
  const parsed = parseWorkflowDefinition(yaml)
  assert.equal(parsed.success, true, parsed.error)
  const def = parsed.definition!
  // 旧版条件边 → when + priority
  const cond = def.edges.find((e) => e.when)
  assert.ok(cond, '条件边被迁移')
  assert.equal(cond!.from, 'b')
  assert.equal(cond!.to, 'a')
  assert.equal(cond!.when!.type, 'content')
  assert.ok(!map.has('/ud/agents/local/agent-1.json'), '源已删')
  assert.ok(map.has('/ud/agents/local/agent-2.json'), '单节点源保留(归模板通道)')
})

test('迁移:提供 templatesDir 时单节点 SavedAgent → 模板 .md,删源', async () => {
  const { fs, map } = makeFakeFs({
    '/ud/agents/local/agent-2.json': LEGACY_SINGLE_NODE_AGENT,
  })
  const report = await migrateLegacyWorkflowAssets(fs, {
    legacyWorkflowsDir: '/ud/workflows',
    legacyAgentsDir: '/ud/agents/local',
    targetDir: '/home/.chill/workflows',
    templatesDir: '/home/.chill/agents/templates',
  })
  assert.equal(report.errors.length, 0)
  assert.equal(report.migrated.length, 1)
  assert.ok(report.migrated[0].includes('模板'))
  // 'solo' → solo.md;内容为 frontmatter 模板
  const md = map.get('/home/.chill/agents/templates/solo.md')!
  assert.ok(md.includes('subagent_type: solo'))
  assert.ok(md.includes('单'))
  assert.ok(!map.has('/ud/agents/local/agent-2.json'), '源已删')
})

test('迁移:目标已存在且可解析 → 源收敛删除(防"删了 YAML 被复活");目标损坏 → 源保留', async () => {
  const existing = 'name: wf-1700000000000\nversion: 1\nnodes: [{id: a, agent: {system_prompt: x}}]'
  const { fs, map } = makeFakeFs({
    '/ud/workflows/1700000000000.json': LEGACY_WORKFLOW,
    '/home/.chill/workflows/wf-1700000000000.yaml': existing,
  })
  const report = await migrateLegacyWorkflowAssets(fs, {
    legacyWorkflowsDir: '/ud/workflows',
    targetDir: '/home/.chill/workflows',
  })
  assert.equal(report.migrated.length, 0)
  assert.equal(report.skipped.length, 1)
  assert.ok(report.skipped[0].includes('已存在'))
  assert.equal(map.get('/home/.chill/workflows/wf-1700000000000.yaml'), existing, '目标未被覆盖')
  assert.ok(!map.has('/ud/workflows/1700000000000.json'), '源已收敛删除(用户删除 YAML 后不会被复活)')

  // 目标损坏(用户改坏 YAML)→ 源保留 + 错误可见
  const { fs: fs2, map: map2 } = makeFakeFs({
    '/ud/workflows/1700000000000.json': LEGACY_WORKFLOW,
    '/home/.chill/workflows/wf-1700000000000.yaml': 'name: [broken',
  })
  const report2 = await migrateLegacyWorkflowAssets(fs2, {
    legacyWorkflowsDir: '/ud/workflows',
    targetDir: '/home/.chill/workflows',
  })
  assert.equal(report2.migrated.length, 0)
  assert.equal(report2.errors.length, 1)
  assert.match(report2.errors[0], /解析失败/)
  assert.ok(map2.has('/ud/workflows/1700000000000.json'), '目标损坏时源保留')
})

test('legacyGraphToDefinition:start 消亡 + 默认 inputs 契约', () => {
  const def = legacyGraphToDefinition(
    [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: '开始' } } as any,
      { id: 'a', type: 'model', position: { x: 0, y: 0 }, data: { label: 'A', systemPrompt: 'x' } } as any,
    ],
    [{ id: 'e', source: 'start', target: 'a', type: 'default' } as any],
    { name: 'demo' },
  )
  assert.equal(def.nodes.length, 1)
  assert.deepEqual(def.inputs, [{ name: 'input', type: 'text', required: false }])
  assert.equal(def.edges.length, 0) // start 出边不进 DSL
})

test('迁移:数字/非法节点 id 合法化并同步改写边引用(真实存量回归)', () => {
  // 真实案例:画布自动生成的节点 id 为 "2"/"3"
  const def = legacyGraphToDefinition(
    [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: '开始' } } as any,
      { id: '2', type: 'model', position: { x: 0, y: 0 }, data: { label: 'A', systemPrompt: 'x' } } as any,
      { id: '3', type: 'tool', position: { x: 0, y: 0 }, data: { label: 'B', selectedTools: [{ function: { name: 'create_file' } }], toolParams: {} } } as any,
    ],
    [
      { id: 'e0', source: 'start', target: '2', type: 'default' } as any,
      { id: 'e1', source: '2', target: '3', type: 'default' } as any,
    ],
    { name: 'demo' },
  )
  const ids = def.nodes.map((n) => n.id)
  assert.ok(ids.includes('n2') && ids.includes('n3'), `合法化后的 id: ${ids}`)
  assert.equal(def.edges.length, 1)
  assert.equal(def.edges[0].from, 'n2')
  assert.equal(def.edges[0].to, 'n3')
  // 序列化后可解析(合法性闭环)
  const yaml = definitionToYaml(def)
  const check = parseWorkflowDefinition(yaml)
  assert.equal(check.success, true, check.error)
})
