import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatEngine } from '../../src/engine/ChatEngine.ts'
import type { ChatEngineDeps } from '../../src/engine/types.ts'
import { parseBareAgentMention } from '../../src/engine/agentMention.ts'

/**
 * 前台直聊（@ 裸提及语义）：解析、模板三件约束（模型/工具）生效、显示数据源一致性。
 * 真实 ChatEngine + 最小 fake deps（enum 一律字符串字面量，参考 taskReflow.test.ts 约定）。
 */

const TYPES = new Set(['code-reviewer', 'document-writer'])

test('parseBareAgentMention: 裸提及命中（容忍前后空白）', () => {
  assert.equal(parseBareAgentMention('@code-reviewer', TYPES), 'code-reviewer')
  assert.equal(parseBareAgentMention('  @code-reviewer \n', TYPES), 'code-reviewer')
})

test('parseBareAgentMention: 带内容/多提及/未知 type 均不命中', () => {
  assert.equal(parseBareAgentMention('@code-reviewer 审查一下', TYPES), undefined)
  assert.equal(parseBareAgentMention('@code-reviewer @document-writer', TYPES), undefined)
  assert.equal(parseBareAgentMention('@unknown-agent', TYPES), undefined)
  assert.equal(parseBareAgentMention('普通消息', TYPES), undefined)
})

interface FakeDepsOptions {
  template?: { name: string; subagent_type: string; model?: string; tools?: string[] }
  /** 多模板映射（type → 模板），优先于 template 单模板（边界标记测试用） */
  templates?: Record<string, { name: string }>
  currentModel?: string
}

function makeDeps(opts: FakeDepsOptions = {}) {
  const calls: Array<{ modelName: string; tools: string[] }> = []
  const state = { saves: 0 }
  const getTemplate = opts.templates
    ? (type: string) => opts.templates![type]
    : opts.template
      ? () => opts.template
      : undefined
  const deps = {
    modelCaller: {
      callOnce: async (params: any) => {
        calls.push({
          modelName: params.modelName,
          tools: (params.tools ?? []).map((t: any) => t.function.name),
        })
        return { content: 'ok' }
      },
    },
    modelInfo: {
      getModelsWithApiKeys: async () => [],
      getModelInfoByName: (n: string) =>
        n === 'tpl-model' || n === 'user-model' ? { name: n } : undefined,
    } as any,
    selectedModels: { getCurrentModelName: () => opts.currentModel ?? 'user-model' } as any,
    sessionStore: {
      save: async () => {
        state.saves++
        return { success: true }
      },
      load: async () => ({ success: false }),
    } as any,
    builtInToolExecutor: {
      execute: () => ({ success: true }),
      executeAsync: async () => ({ success: true }),
      setPlanMode: () => {},
      getAutoApply: () => false,
      getNonInteractiveMode: () => null,
      applyAutoApplyBatch: async () => new Map(),
    } as any,
    mcpService: { getAggregatedOpenAITools: async () => [] } as any,
    eventBus: { on: () => {}, off: () => {}, emit: () => {} },
    getSubagentTemplate: getTemplate,
  } as unknown as ChatEngineDeps
  return { deps, calls, state }
}

test('前台模型: 模板 model 已注册 → 用模板模型;显示数据源同判定（modelSource=template）', async (t) => {
  const { deps, calls } = makeDeps({
    template: { name: '安全审查员', subagent_type: 'sec', model: 'tpl-model' },
  })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())
  engine.setFrontAgent('sec')

  await engine.sendMessage({ text: '你好' })
  assert.equal(calls[0].modelName, 'tpl-model')

  const display = engine.getFrontAgentDisplay()
  assert.deepEqual(display, { name: '安全审查员', model: 'tpl-model', modelSource: 'template' })
})

test('前台模型: 模板 model 未注册 → 跟随用户当前模型（modelSource=current）', async (t) => {
  const { deps, calls } = makeDeps({
    template: { name: '安全审查员', subagent_type: 'sec', model: 'ghost-model' },
  })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())
  engine.setFrontAgent('sec')

  await engine.sendMessage({ text: '你好' })
  assert.equal(calls[0].modelName, 'user-model')
  assert.equal(engine.getFrontAgentDisplay()?.modelSource, 'current')
})

test('前台模型: 模板无 model 字段 → 跟随用户当前模型', async (t) => {
  const { deps, calls } = makeDeps({
    template: { name: '安全审查员', subagent_type: 'sec' },
  })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())
  engine.setFrontAgent('sec')

  await engine.sendMessage({ text: '你好' })
  assert.equal(calls[0].modelName, 'user-model')
})

test('前台工具白名单: 模板 tools 非空 → 仅名单内工具下发;未设 → 全量（回归）', async (t) => {
  const restricted = makeDeps({
    template: { name: '只读审查员', subagent_type: 'ro', tools: ['read_file'] },
  })
  const engineA = new ChatEngine(restricted.deps)
  t.after(() => engineA.dispose())
  engineA.setFrontAgent('ro')
  await engineA.sendMessage({ text: '看看这个文件' })
  assert.deepEqual(restricted.calls[0].tools, ['read_file'], '白名单外工具（含 task/写工具）不得下发')

  const full = makeDeps({ template: { name: '万能', subagent_type: 'gp' } })
  const engineB = new ChatEngine(full.deps)
  t.after(() => engineB.dispose())
  engineB.setFrontAgent('gp')
  await engineB.sendMessage({ text: '干点活' })
  assert.ok(full.calls[0].tools.includes('task'), '未设 tools 时全量下发（含委派工具）')
  assert.ok(full.calls[0].tools.includes('read_file'))
})

test('前台显示: 裸模型（未设前台）→ getFrontAgentDisplay 为 undefined', () => {
  const { deps } = makeDeps()
  const engine = new ChatEngine(deps)
  assert.equal(engine.getFrontAgentDisplay(), undefined)
  engine.dispose()
})


test('人格边界标记: 裸模型→A→B→裸模型，逐次落 frontSwitch 合成消息并持久化', async (t) => {
  const { deps, state } = makeDeps({
    templates: {
      'agent-a': { name: '助手甲' },
      'agent-b': { name: '助手乙' },
    },
  })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  engine.setFrontAgent('agent-a')
  engine.setFrontAgent('agent-b')
  engine.setFrontAgent(undefined)

  const markers = engine
    .getHistory()
    .filter((m) => (m as any).synthetic === 'frontSwitch')
  assert.equal(markers.length, 3)
  assert.ok(markers.every((m) => m.role === 'user'), '合成消息为 USER 角色（权威历史不含 system）')
  assert.equal(markers[0].content, '（前台已切换为「助手甲」，此前回复由裸模型产出）')
  assert.equal(markers[1].content, '（前台已切换为「助手乙」，此前回复由「助手甲」产出）')
  assert.equal(markers[2].content, '（前台已切换为裸模型，此前回复由「助手乙」产出）')
  assert.ok(state.saves >= 3, '每次切换经 appendSyntheticMessage 落盘（切换轨迹兼作记录）')
})

test('人格边界标记: 同型切换防抖——不落标记、不重复落盘', async (t) => {
  const { deps, state } = makeDeps({
    templates: { 'agent-a': { name: '助手甲' } },
  })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  engine.setFrontAgent('agent-a')
  const savesAfterFirst = state.saves
  engine.setFrontAgent('agent-a')
  engine.setFrontAgent('agent-a')

  const markers = engine.getHistory().filter((m) => (m as any).synthetic === 'frontSwitch')
  assert.equal(markers.length, 1, '仅首次切换落一条标记')
  assert.equal(state.saves, savesAfterFirst, '同型切换不重复落盘')
})

test('人格边界标记: 模板查不到时来源名回退 type 本身', async (t) => {
  const { deps } = makeDeps({ templates: { 'agent-a': { name: '助手甲' } } })
  const engine = new ChatEngine(deps)
  t.after(() => engine.dispose())

  engine.setFrontAgent('ghost-agent') // 无模板
  engine.setFrontAgent('agent-a')

  const markers = engine.getHistory().filter((m) => (m as any).synthetic === 'frontSwitch')
  assert.equal(markers[0].content, '（前台已切换为「ghost-agent」，此前回复由裸模型产出）')
  assert.equal(markers[1].content, '（前台已切换为「助手甲」，此前回复由「ghost-agent」产出）')
})
