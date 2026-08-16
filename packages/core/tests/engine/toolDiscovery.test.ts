import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCatalogEntries,
  buildCatalogIndex,
  buildSearchResultText,
  computeVisibleNames,
  filterVisibleTools,
  parseActivatedNames,
  searchToolCorpus,
  shouldEnableProgressiveTools,
  PROGRESSIVE_TOOLS_MIN_DEFERRABLE_CHARS,
  type ToolCatalogEntry,
} from '../../src/engine/toolDiscovery.ts'
import {
  BUILTIN_TOOLS,
  TOOL_CATEGORY,
  CORE_TOOLS,
  MODE_TOOLS,
  builtInToolDefinitions,
} from '../../src/services/builtInTools.ts'
import type { ToolDefinition } from '../../src/types/models.ts'

/**
 * 工具渐进发现层（engine/toolDiscovery.ts）纯函数单测。
 * 覆盖：BM25 中文检索、exact-name 置顶、select:/category 直取、零命中降级文本、
 *       目录索引预算降级、[activated] 行生成与解析互逆、可见集三集合并、
 *       保序过滤（activated 末尾 + 空抛错）、启用阈值、名单常量与 BUILTIN_TOOLS 一致性。
 */

const makeTool = (name: string, description: string, properties: Record<string, any> = {}): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required: [] },
  },
})

const FIXTURE_CATEGORIES: Record<string, string> = {
  save_memory: '记忆与知识',
  delete_memory: '记忆与知识',
  read_file: '文件与命令',
  list_files: '文件与命令',
  add_model: '配置管理',
  list_models: '配置管理',
  capture_screen: '生成与桌面',
}

const fixtureTools: ToolDefinition[] = [
  makeTool('save_memory', '保存一条长期记忆（跨会话持久生效）。当用户说"记住/以后都"时主动使用。', {
    type: { type: 'string', description: '记忆类型' },
    title: { type: 'string', description: '记忆标题' },
    content: { type: 'string', description: '记忆正文' },
  }),
  makeTool('delete_memory', '按标题删除一条长期记忆。', {
    title: { type: 'string', description: '要删除的记忆标题' },
  }),
  makeTool('read_file', '读取指定文件的内容。', {
    path: { type: 'string', description: '要读取的文件路径' },
  }),
  makeTool('list_files', '列出指定目录下的文件和文件夹。'),
  makeTool('add_model', '添加新的模型。支持添加自定义供应商模型。'),
  makeTool('list_models', '列出当前已注册的所有模型信息。'),
  makeTool('capture_screen', '截取当前桌面屏幕图像并返回给你查看（只读）。'),
]

const fixtureEntries = buildCatalogEntries(fixtureTools, FIXTURE_CATEGORIES)

test('名单常量一致性：TOOL_CATEGORY 覆盖全部 BUILTIN_TOOLS，CORE/MODE_TOOLS 均为已登记工具', () => {
  for (const name of BUILTIN_TOOLS) {
    assert.ok(TOOL_CATEGORY[name], `BUILTIN_TOOLS 成员 ${name} 缺少类别`)
  }
  assert.ok(BUILTIN_TOOLS.includes('search_tools' as any), 'search_tools 应登记进 BUILTIN_TOOLS')
  assert.ok(builtInToolDefinitions.some(d => d.function.name === 'search_tools'), 'search_tools 应有工具定义')
  for (const name of CORE_TOOLS) {
    assert.ok((BUILTIN_TOOLS as readonly string[]).includes(name), `CORE_TOOLS 成员 ${name} 不在 BUILTIN_TOOLS`)
  }
  for (const names of Object.values(MODE_TOOLS)) {
    for (const name of names) {
      assert.ok((BUILTIN_TOOLS as readonly string[]).includes(name), `MODE_TOOLS 成员 ${name} 不在 BUILTIN_TOOLS`)
    }
  }
})

test('BM25-lite：中文意图词检索命中相关工具', () => {
  const hits = searchToolCorpus(fixtureTools, { query: '保存 记忆', categories: FIXTURE_CATEGORIES })
  assert.ok(hits.length > 0)
  assert.equal(hits[0].entry.name, 'save_memory')
})

test('exact-name 命中强制置顶，且不受 top-N 截断', () => {
  // 构造 exact 命中但 BM25 排名必然落后的场景：read_file 描述与查询词无关，另一工具描述堆满查询词
  const tools = [
    makeTool('read_file', 'zzz'),
    makeTool('file_helper', 'read file read file read file 读取文件'),
  ]
  const hits = searchToolCorpus(tools, { query: 'read_file', limit: 1 })
  assert.equal(hits[0].entry.name, 'read_file')
  assert.equal(hits.length, 2) // exact 置顶 1 个 + top-N 1 个，exact 不被 limit=1 截掉
})

test('select:<工具名> 直取：绕过检索按名返回，未知名返回空数组', () => {
  const hits = searchToolCorpus(fixtureTools, { query: 'select:save_memory', categories: FIXTURE_CATEGORIES })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entry.name, 'save_memory')
  const missing = searchToolCorpus(fixtureTools, { query: 'select:no_such_tool', categories: FIXTURE_CATEGORIES })
  assert.deepEqual(missing, [])
})

test('category 直取：query 为空返回该类全部工具（保序）；类别内检索零命中返回空数组', () => {
  const hits = searchToolCorpus(fixtureTools, { query: '', category: '配置管理', categories: FIXTURE_CATEGORIES })
  assert.deepEqual(hits.map(h => h.entry.name), ['add_model', 'list_models'])
  const none = searchToolCorpus(fixtureTools, { query: '模型', category: '文件与命令', categories: FIXTURE_CATEGORIES })
  assert.deepEqual(none, [])
})

test('零命中：检索返回空数组，结果文本走按类别名单 + 用法提示降级', () => {
  const hits = searchToolCorpus(fixtureTools, { query: 'zzzqqq', categories: FIXTURE_CATEGORIES })
  assert.deepEqual(hits, [])
  const text = buildSearchResultText([], fixtureEntries)
  assert.ok(text.includes('未检索到匹配工具'))
  assert.ok(text.includes('配置管理'))
  assert.ok(text.includes('search_tools'))
  assert.ok(text.includes('select:'))
})

test('buildCatalogIndex：预算充足全量列出，超预算按类别聚合降级（工具数多的类别先聚合）', () => {
  const entries: ToolCatalogEntry[] = [
    { name: 'a1', description: '', category: '类A' },
    { name: 'a2', description: '', category: '类A' },
    { name: 'a3', description: '', category: '类A' },
    { name: 'b1', description: '', category: '类B' },
  ]
  const full = buildCatalogIndex(entries, Number.MAX_SAFE_INTEGER)
  assert.ok(full.includes('a1') && full.includes('b1'))
  assert.ok(!full.includes('(+'))
  assert.ok(full.includes('search_tools')) // 末尾指针

  const degraded = buildCatalogIndex(entries, full.length - 1)
  assert.ok(degraded.includes('类A(+3)'), '工具数最多的类A 应先被聚合')
  assert.ok(degraded.includes('b1'), '类B 仍展开')
  assert.ok(degraded.length <= full.length)
})

test('[activated] 行生成与解析互逆；无该行时解析返回空数组', () => {
  const hits = searchToolCorpus(fixtureTools, { query: 'select:save_memory', categories: FIXTURE_CATEGORIES })
    .concat(searchToolCorpus(fixtureTools, { query: 'select:capture_screen', categories: FIXTURE_CATEGORIES }))
  const text = buildSearchResultText(hits, fixtureEntries)
  assert.ok(text.includes('"name": "save_memory"'), '命中工具应内联完整 schema 文本')
  assert.deepEqual(parseActivatedNames(text), ['save_memory', 'capture_screen'])
  assert.deepEqual(parseActivatedNames('普通工具结果文本，没有名单行'), [])
})

test('computeVisibleNames：核心集 ∪ 模式集 ∪ 已激活集', () => {
  const plain = computeVisibleNames({})
  for (const name of CORE_TOOLS) assert.ok(plain.has(name))
  assert.ok(!plain.has('write_plan'))
  assert.ok(!plain.has('write_goal'))

  const plan = computeVisibleNames({ mode: 'plan' })
  assert.ok(plan.has('write_plan') && plan.has('read_plan') && plan.has('submit_plan'))
  assert.ok(!plan.has('write_goal'))

  const goal = computeVisibleNames({ mode: 'goal' })
  for (const name of MODE_TOOLS.goal) assert.ok(goal.has(name))
  assert.ok(!goal.has('write_plan'))

  const activated = computeVisibleNames({ mode: 'plan', activated: ['save_memory'] })
  assert.ok(activated.has('save_memory'))
  assert.ok(activated.has('write_plan'))
  assert.ok(activated.has('read_file'))
})

test('filterVisibleTools：保序过滤、activated 排末尾、空结果抛带标记的 Error', () => {
  const visible = new Set(['read_file', 'list_files', 'save_memory'])
  const activated = new Set(['save_memory'])
  const result = filterVisibleTools(fixtureTools, visible, activated)
  assert.deepEqual(result.map(t => t.function.name), ['read_file', 'list_files', 'save_memory'])

  // save_memory 在 allTools 中原本排最前，作为 activated 必须排到末尾
  assert.equal(result[result.length - 1].function.name, 'save_memory')

  assert.throws(
    () => filterVisibleTools(fixtureTools, new Set(['no_such_tool'])),
    /\[toolDiscovery\]/,
  )
})

test('shouldEnableProgressiveTools：绝对阈值（字符数）超过才启用', () => {
  assert.equal(shouldEnableProgressiveTools(0), false)
  assert.equal(shouldEnableProgressiveTools(PROGRESSIVE_TOOLS_MIN_DEFERRABLE_CHARS), false)
  assert.equal(shouldEnableProgressiveTools(PROGRESSIVE_TOOLS_MIN_DEFERRABLE_CHARS + 1), true)
})
