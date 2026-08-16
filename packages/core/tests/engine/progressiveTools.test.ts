import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import type { ToolCatalogEntry } from '../../src/engine/toolDiscovery.ts'
import { buildCatalogIndex } from '../../src/engine/toolDiscovery.ts'
import { buildDelegationGuide } from '../../src/engine/delegationGuide.ts'
import {
  BUILTIN_TOOLS,
  CORE_TOOLS,
  MODE_TOOLS,
  TOOL_CATEGORY,
  PLAN_MODE_CONTRACT,
  GOAL_MODE_CONTRACT,
  builtInToolDefinitions,
} from '../../src/services/builtInTools.ts'
import { MessageRole, type Message, type ToolDefinition } from '../../src/types/models.ts'

/**
 * 工具渐进发现·引擎接线与契约一致性测试（波次 2a）。
 * 覆盖：契约引用工具 ∈ 可见集（plan 低频例外白名单对齐方案 §4.3）/ 引导文本工具名存在性 /
 *       委派清单分类索引化 + 编排工具剔除 / 引擎默认分层下发 / search_tools 激活后下一轮可见（追加末尾）/
 *       opt-out 全量回退 + search_tools 明确提示 / plan 模式集可见 / loadSession 从 history 重建激活集 /
 *       getToolsStatus 形状。
 *
 * 假 deps 模式同 goalMode.test.ts：modelCaller 捕获每次 callOnce 的 tools/messages；
 * builtInToolExecutor 假execute 把 search_tools 转调引擎注册的 provider（真实检索闭环）。
 */

// ==================== 契约一致性（纯常量断言） ====================

/** 从契约文本中提取按名引用的内置工具（名字原文出现即视为引用） */
const referencedTools = (text: string): string[] =>
  BUILTIN_TOOLS.filter((name) => text.includes(name))

/** 方案 §4.3 裁定：契约引用但不进模式集的低频查询类（可经 search_tools 取回） */
const PLAN_LOW_FREQ_RETRIEVABLE = ['get_current_directory', 'list_models', 'list_skills', 'capture_screen']

test('PLAN_MODE_CONTRACT 引用工具 ⊆ CORE ∪ MODE_TOOLS.plan ∪ 低频可取回名单', () => {
  const referenced = referencedTools(PLAN_MODE_CONTRACT)
  const visible = new Set([...CORE_TOOLS, ...MODE_TOOLS.plan, ...PLAN_LOW_FREQ_RETRIEVABLE])
  for (const name of referenced) {
    assert.ok(visible.has(name), `PLAN_MODE_CONTRACT 引用的 ${name} 不在可见集且不在低频可取回名单`)
  }
  // 防名单漂移：低频例外须确为契约引用、且已归类（search_tools 语料可达）
  for (const name of PLAN_LOW_FREQ_RETRIEVABLE) {
    assert.ok(referenced.includes(name), `低频例外 ${name} 不再是契约引用，应从例外名单移除`)
    assert.ok(TOOL_CATEGORY[name], `低频例外 ${name} 须已归类（search_tools 可取回）`)
  }
})

test('GOAL_MODE_CONTRACT 引用工具 ⊆ CORE ∪ MODE_TOOLS.goal（无例外）', () => {
  const visible = new Set([...CORE_TOOLS, ...MODE_TOOLS.goal])
  for (const name of referencedTools(GOAL_MODE_CONTRACT)) {
    assert.ok(visible.has(name), `GOAL_MODE_CONTRACT 引用的 ${name} 不在可见集（CORE ∪ MODE_TOOLS.goal）`)
  }
})

test('引导文本工具名存在性：search_tools 已登记、索引指针与其描述按名引用它', () => {
  assert.ok((BUILTIN_TOOLS as readonly string[]).includes('search_tools'), 'search_tools 应登记进 BUILTIN_TOOLS')
  const def = builtInToolDefinitions.find((d) => d.function.name === 'search_tools')
  assert.ok(def, 'search_tools 应有工具定义')
  assert.ok(def.function.description.includes('select:'), 'search_tools 描述应含 select: 直取引导')
  const index = buildCatalogIndex([{ name: 'read_file', description: '', category: '文件与命令' }], 4000)
  assert.ok(index.includes('search_tools'), '目录索引指针应引导到 search_tools')
})

// ==================== 委派指南清单（纯函数） ====================

const fakeSubagent = {
  type: 'general-purpose',
  name: '通用基础',
  description: '万能的问题解决者',
  capabilities: [],
  applicableScenarios: [],
}

test('委派指南可分配工具清单：分类名字索引（去描述化）且剔除编排工具', () => {
  const catalog: ToolCatalogEntry[] = [
    { name: 'read_file', description: '读取指定文件的内容。', category: '文件与命令' },
    { name: 'list_files', description: '列出目录。', category: '文件与命令' },
    { name: 'save_memory', description: '保存长期记忆。', category: '记忆与知识' },
    { name: 'task', description: '委派', category: '任务编排' },
    { name: 'query_task_status', description: '查询', category: '任务编排' },
    { name: 'cancel_task', description: '取消', category: '任务编排' },
    { name: 'batch_task', description: '批量', category: '任务编排' },
    { name: 'search_tools', description: '检索', category: '交互与自省' },
    { name: 'fs_read', description: 'MCP 读', category: 'mcp:fs' },
  ]
  const guide = buildDelegationGuide([fakeSubagent], [], catalog)!
  assert.ok(guide.includes('可分配工具清单'), '应含可分配工具清单 section')
  assert.ok(guide.includes('- 文件与命令: read_file, list_files'), '应按类别分组列名字')
  assert.ok(guide.includes('- 记忆与知识: save_memory'), '类别分组应完整')
  assert.ok(guide.includes('- mcp:fs: fs_read'), 'MCP 工具按 serverName 归类')
  // 编排工具剔除（Subagent 不可用，防照抄进 available_tools；只断清单 section——政策文本提及 query_task_status 属正常引导）
  const listSection = guide.slice(guide.indexOf('可分配工具清单'))
  for (const name of ['query_task_status', 'cancel_task', 'batch_task', 'search_tools']) {
    assert.ok(!listSection.includes(name), `清单不应含编排工具 ${name}`)
  }
  // 去描述化：名字后不再跟「— 描述」
  assert.ok(!listSection.includes('read_file —'), '清单应去描述化')
})

// ==================== 引擎接线（假 deps 集成） ====================

interface CapturedCall { tools: string[]; messages: Message[] }

interface MakeDepsOptions {
  progressiveToolsEnabled?: () => boolean
  /** 逐次会话调用的响应脚本（返回 ModelResponse；缺省 { content:'ok' }） */
  onConversationCall?: (callIndex: number) => any
  mcpTools?: ToolDefinition[]
  sessionRecord?: any
  captured: CapturedCall[]
}

function makeDeps(options: MakeDepsOptions): { deps: ChatEngineDeps; getSearchProvider: () => any } {
  let conversationCalls = 0
  let searchProvider: any = null
  const deps: ChatEngineDeps = {
    modelCaller: {
      callOnce: async (params: any) => {
        const msgs: Message[] = params.messages
        // 自动标题等辅助调用（不带 tools）直接放行
        if (!params.tools) return { content: 'ok' }
        options.captured.push({
          tools: (params.tools as ToolDefinition[]).map((t) => t.function.name),
          messages: msgs,
        })
        conversationCalls++
        return options.onConversationCall ? options.onConversationCall(conversationCalls) : { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: () => undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => 'fake-model' } as any,
    sessionStore: {
      save: async () => ({ success: true }),
      load: async () =>
        options.sessionRecord ? { success: true, record: options.sessionRecord } : { success: false },
    } as any,
    builtInToolExecutor: {
      execute: (name: string, args: string) => {
        if (name === 'search_tools' && searchProvider) {
          return { success: true, data: { content: searchProvider(JSON.parse(args)) } }
        }
        return { success: true, data: {} }
      },
      executeAsync: async () => ({ success: true }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
      setSearchToolsProvider: (p: any) => { searchProvider = p },
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => options.mcpTools ?? [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    progressiveToolsEnabled: options.progressiveToolsEnabled,
    getSubagents: () => [fakeSubagent],
  }
  return { deps, getSearchProvider: () => searchProvider }
}

test('默认开启：每次 callOnce 只下发核心集，索引系统消息每轮注入（含 MCP 类别）', async () => {
  const captured: CapturedCall[] = []
  const mcpTools: ToolDefinition[] = [
    { type: 'function', function: { name: 'fs_read', description: 'MCP 读文件', parameters: { type: 'object', properties: {} } }, serverName: 'fs' } as any,
  ]
  const { deps } = makeDeps({ captured, mcpTools })
  const engine = new ChatEngine(deps)
  await engine.sendMessage({ text: '你好' })

  assert.equal(captured.length, 1)
  const tools = captured[0].tools
  assert.deepEqual([...tools].sort(), [...CORE_TOOLS].sort(), '渐进生效时下发集应恰为核心集')
  assert.ok(!tools.includes('save_memory'), '非核心工具不应下发')
  assert.ok(!tools.includes('fs_read'), 'MCP 工具未激活前不应下发')

  // 索引注入：按类别分组 + search_tools 指针 + MCP 类别存在性提示
  const indexMsg = captured[0].messages.find(
    (m) => m.role === MessageRole.SYSTEM && typeof m.content === 'string' && m.content.includes('【工具目录索引】')
  )
  assert.ok(indexMsg, '应注入工具目录索引系统消息')
  const indexText = indexMsg!.content as string
  assert.ok(indexText.includes('- 记忆与知识:'), '索引应含内置类别分组')
  assert.ok(indexText.includes('- mcp:fs: fs_read'), '索引应含 mcp:<server> 类别')
  assert.ok(indexText.includes('search_tools'), '索引应含 search_tools 指针')

  // 委派清单换用分类索引：含类别行、不含编排工具
  const guideMsg = captured[0].messages.find(
    (m) => m.role === MessageRole.SYSTEM && typeof m.content === 'string' && m.content.includes('可分配工具清单')
  )
  assert.ok(guideMsg, '应注入委派指南（含可分配工具清单）')
  assert.ok((guideMsg!.content as string).includes('- 文件与命令:'), '委派清单应分类索引化')
  assert.ok(!(guideMsg!.content as string).includes('search_tools'), '委派清单不应含 search_tools')

  const status = engine.getToolsStatus()
  assert.equal(status.mode, 'progressive')
  assert.equal(status.coreCount, CORE_TOOLS.length)
  assert.equal(status.activatedCount, 0)
  assert.ok(status.deferredCount > 0, '分层下应有未下发工具')
  assert.deepEqual(status.activatedNames, [])
})

test('search_tools 命中即激活：下一轮 callOnce 可见且追加在 tools 末尾；getToolsStatus 反映激活', async () => {
  const captured: CapturedCall[] = []
  const { deps } = makeDeps({
    captured,
    onConversationCall: (i) =>
      i === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'tc-search-1', type: 'function', function: { name: 'search_tools', arguments: '{"query":"select:save_memory"}' } },
            ],
          }
        : { content: 'done' },
  })
  const engine = new ChatEngine(deps)
  const result = await engine.sendMessage({ text: '帮我记住个事' })

  assert.equal(result.content, 'done')
  assert.equal(captured.length, 2)
  assert.ok(!captured[0].tools.includes('save_memory'), '激活前 save_memory 不可见')
  const secondTools = captured[1].tools
  assert.ok(secondTools.includes('save_memory'), '激活后 save_memory 应可见')
  assert.equal(secondTools[secondTools.length - 1], 'save_memory', '激活工具应追加在 tools 末尾（保缓存前缀）')

  const status = engine.getToolsStatus()
  assert.equal(status.mode, 'progressive')
  assert.equal(status.activatedCount, 1)
  assert.deepEqual(status.activatedNames, ['save_memory'])
})

test('opt-out：progressiveToolsEnabled=false 时全量下发、不注入索引、search_tools 返回全量模式提示', async () => {
  const captured: CapturedCall[] = []
  const { deps } = makeDeps({
    captured,
    progressiveToolsEnabled: () => false,
    onConversationCall: (i) =>
      i === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'tc-search-1', type: 'function', function: { name: 'search_tools', arguments: '{"query":"记忆"}' } },
            ],
          }
        : { content: 'done' },
  })
  const engine = new ChatEngine(deps)
  await engine.sendMessage({ text: '你好' })

  assert.equal(captured.length, 2)
  assert.ok(captured[0].tools.length > 50, 'opt-out 应全量下发')
  assert.ok(captured[0].tools.includes('save_memory'), '全量模式含非核心工具')
  assert.ok(
    !captured[0].messages.some(
      (m) => m.role === MessageRole.SYSTEM && typeof m.content === 'string' && m.content.includes('【工具目录索引】')
    ),
    '全量模式不应注入目录索引'
  )
  // search_tools 在全量模式下返回明确提示（不抛异常、不激活）
  const toolMsg = captured[1].messages.find((m) => m.role === MessageRole.TOOL)
  assert.ok(toolMsg, 'search_tools 应产生 TOOL 结果消息')
  assert.ok(
    typeof toolMsg!.content === 'string' && toolMsg!.content.includes('全量工具模式'),
    '全量模式下 search_tools 应返回明确提示'
  )
  assert.equal(engine.getToolsStatus().mode, 'full')
})

test('plan 模式：模式条件集（write_plan/read_plan/submit_plan）随模式可见', async () => {
  const captured: CapturedCall[] = []
  const { deps } = makeDeps({ captured })
  const engine = new ChatEngine(deps)
  engine.setPlanMode(true)
  await engine.sendMessage({ text: '帮我规划一下' })

  assert.equal(captured.length, 1)
  const tools = captured[0].tools
  for (const name of MODE_TOOLS.plan) {
    assert.ok(tools.includes(name), `plan 模式下 ${name} 应可见`)
  }
  assert.ok(!tools.includes('write_goal'), 'goal 模式集不应混入')
  assert.ok(!tools.includes('save_memory'), '非核心非模式工具仍不下发')
})

test('loadSession 从 history 扫描 [activated] 行重建激活集', async () => {
  const captured: CapturedCall[] = []
  const sessionRecord = {
    id: 'sess-1',
    title: '旧会话',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { role: 'user', content: '之前的需求', timestamp: new Date() },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc-old-1', type: 'function', function: { name: 'search_tools', arguments: '{"query":"记忆"}' } },
        ],
        timestamp: new Date(),
      },
      {
        role: 'tool',
        content: '检索命中 2 个工具……\n[activated] save_memory, list_knowledge_bases',
        toolCallId: 'tc-old-1',
        toolCallStatus: 'success',
        timestamp: new Date(),
      },
      { role: 'assistant', content: '好的', timestamp: new Date() },
    ],
  }
  const { deps } = makeDeps({ captured, sessionRecord })
  const engine = new ChatEngine(deps)
  assert.equal(await engine.loadSession('sess-1'), true)
  assert.deepEqual(engine.getToolsStatus().activatedNames.sort(), ['list_knowledge_bases', 'save_memory'])

  await engine.sendMessage({ text: '继续' })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].tools.includes('save_memory'), '重建的激活工具应直接可见')
  assert.ok(captured[0].tools.includes('list_knowledge_bases'), '重建的激活工具应直接可见')
})

test('startNewSession 重置激活集', async () => {
  const captured: CapturedCall[] = []
  const { deps } = makeDeps({
    captured,
    onConversationCall: (i) =>
      i === 1
        ? {
            content: '',
            toolCalls: [
              { id: 'tc-search-1', type: 'function', function: { name: 'search_tools', arguments: '{"query":"select:save_memory"}' } },
            ],
          }
        : { content: 'done' },
  })
  const engine = new ChatEngine(deps)
  await engine.sendMessage({ text: '第一轮' })
  assert.equal(engine.getToolsStatus().activatedCount, 1)

  engine.startNewSession()
  assert.deepEqual(engine.getToolsStatus().activatedNames, [])

  await engine.sendMessage({ text: '新会话' })
  assert.ok(!captured[captured.length - 1].tools.includes('save_memory'), '新会话激活集应已重置')
})
