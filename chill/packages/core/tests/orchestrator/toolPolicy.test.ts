import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveAgentToolPolicy,
  isToolAllowedByPolicy,
  TOOL_POLICY_ALL,
} from '../../src/orchestrator/toolPolicy.ts'
import type { SubagentTemplate, TemplateType } from '../../src/orchestrator/types.ts'
import { PLAN_MODE_BLOCKED_TOOLS } from '../../src/services/builtInTools.ts'

// TemplateType 是 enum（不可经 node 类型擦除运行时导入），测试里用字面量替代
const CUSTOM_TYPE = 'custom' as TemplateType
const REMOTE_MCP_TYPE = 'remote-mcp' as TemplateType
const REMOTE_API_TYPE = 'remote-api' as TemplateType

/** 最小模板工厂（权限声明测试只需 name/subagent_type + 被测字段） */
function tpl(extra: Partial<SubagentTemplate>): SubagentTemplate {
  return {
    name: 'T',
    subagent_type: 't',
    priority: 3 as SubagentTemplate['priority'],
    ...extra,
  } as SubagentTemplate
}

test('toolPolicy: 省略 tools → 零默认策略（空白名单全拒；统一收敛语义）', () => {
  const policy = resolveAgentToolPolicy(tpl({}))
  assert.ok(policy)
  assert.equal(isToolAllowedByPolicy(policy, 'create_file'), false)
  assert.equal(isToolAllowedByPolicy(policy, 'read_file'), false)
  // null 策略（不限制）一律放行
  assert.equal(isToolAllowedByPolicy(null, 'create_file'), true)
})

test('toolPolicy: 防御性 —— tools 空数组/[none] 视同省略（解析层已归一化，此处双保险）', () => {
  const empty = resolveAgentToolPolicy(tpl({ tools: [] }))!
  assert.equal(isToolAllowedByPolicy(empty, 'read_file'), false)
  const none = resolveAgentToolPolicy(tpl({ tools: ['none'] }))!
  assert.equal(isToolAllowedByPolicy(none, 'read_file'), false)
})

test('toolPolicy: tools 白名单 → 有且仅有声明的工具', () => {
  const policy = resolveAgentToolPolicy(tpl({ tools: ['read_file', 'grep'] }))
  assert.ok(policy)
  assert.equal(isToolAllowedByPolicy(policy, 'read_file'), true)
  assert.equal(isToolAllowedByPolicy(policy, 'grep'), true)
  assert.equal(isToolAllowedByPolicy(policy, 'create_file'), false)
  assert.equal(isToolAllowedByPolicy(policy, 'execute_powershell'), false)
})

test('toolPolicy: tools 含 "all" 关键字 → 白名单不生效（不限制）', () => {
  assert.equal(resolveAgentToolPolicy(tpl({ tools: [TOOL_POLICY_ALL] })), null)
  // "all" 与其他名字混用时同样视为不限制
  assert.equal(resolveAgentToolPolicy(tpl({ tools: [TOOL_POLICY_ALL, 'read_file'] })), null)
})

test('toolPolicy: readonly + [all] → 剔除 PLAN_MODE_BLOCKED_TOOLS，其余放行', () => {
  const policy = resolveAgentToolPolicy(tpl({ tools: ['all'], readonly: true }))
  assert.ok(policy)
  for (const blocked of PLAN_MODE_BLOCKED_TOOLS) {
    assert.equal(isToolAllowedByPolicy(policy, blocked), false, `${blocked} 应被 readonly 拦截`)
  }
  assert.equal(isToolAllowedByPolicy(policy, 'read_file'), true)
  assert.equal(isToolAllowedByPolicy(policy, 'search_content'), true)
  // agent 私域写入（记忆/知识库）不在修改性名单内，与 plan 门口径一致
  assert.equal(isToolAllowedByPolicy(policy, 'save_memory'), true)
  assert.equal(isToolAllowedByPolicy(policy, 'add_knowledge'), true)
})

test('toolPolicy: readonly 单独声明（省略 tools）→ 零默认下全拒（readonly 是约束不是工具来源）', () => {
  const policy = resolveAgentToolPolicy(tpl({ readonly: true }))
  assert.ok(policy)
  assert.equal(isToolAllowedByPolicy(policy, 'read_file'), false)
})

test('toolPolicy: disallowed_tools 黑名单 → 在工具集上扣除点名工具', () => {
  const policy = resolveAgentToolPolicy(tpl({ tools: ['all'], disallowed_tools: ['execute_powershell'] }))
  assert.ok(policy)
  assert.equal(isToolAllowedByPolicy(policy, 'execute_powershell'), false)
  assert.equal(isToolAllowedByPolicy(policy, 'create_file'), true)
})

test('toolPolicy: 组合优先级 whitelist → readonly → disallowed', () => {
  const policy = resolveAgentToolPolicy(
    tpl({
      tools: ['read_file', 'create_file', 'execute_powershell'],
      readonly: true,
      disallowed_tools: ['read_file'],
    })
  )
  assert.ok(policy)
  // 白名单内但被 readonly 扣除
  assert.equal(isToolAllowedByPolicy(policy, 'create_file'), false)
  assert.equal(isToolAllowedByPolicy(policy, 'execute_powershell'), false)
  // 白名单内但被黑名单扣除
  assert.equal(isToolAllowedByPolicy(policy, 'read_file'), false)
  // 不在白名单
  assert.equal(isToolAllowedByPolicy(policy, 'grep'), false)
})

test('toolPolicy: 远程模板 → null（权限管不到外部系统）', () => {
  assert.equal(
    resolveAgentToolPolicy(tpl({ type: REMOTE_MCP_TYPE, tools: ['read_file'], readonly: true })),
    null
  )
  assert.equal(
    resolveAgentToolPolicy(tpl({ type: REMOTE_API_TYPE, disallowed_tools: ['x'] })),
    null
  )
})

test('toolPolicy: 本地模板（custom）正常生效', () => {
  const policy = resolveAgentToolPolicy(tpl({ type: CUSTOM_TYPE, readonly: true }))
  assert.ok(policy)
  assert.equal(isToolAllowedByPolicy(policy, 'create_file'), false)
})

// ==================== 模板解析（TemplateParser 三字段校验与透传） ====================

test('parser: tools/disallowed_tools/readonly 合法值落入模板对象', async () => {
  const { parseTemplate } = await import('../../src/orchestrator/parsers/TemplateParser.ts')
  const r = parseTemplate(
    '---\nname: t\nsubagent_type: doc-writer\ntools: [read_file, grep]\ndisallowed_tools:\n  - execute_powershell\nreadonly: true\n---\n正文',
    'm.md',
  )
  assert.equal(r.success, true)
  assert.deepEqual(r.template?.tools, ['read_file', 'grep'])
  assert.deepEqual(r.template?.disallowed_tools, ['execute_powershell'])
  assert.equal(r.template?.readonly, true)
})

test('parser: 三字段非法值 → 明确报错', async () => {
  const { parseTemplate } = await import('../../src/orchestrator/parsers/TemplateParser.ts')
  const r1 = parseTemplate('---\nname: t\nsubagent_type: doc-writer\ntools: read_file\n---\n正文', 'm.md')
  assert.equal(r1.success, false)
  assert.match(r1.error!, /模板字段 "tools" 必须是非空字符串数组/)
  const r2 = parseTemplate('---\nname: t\nsubagent_type: doc-writer\ndisallowed_tools: [1, 2]\n---\n正文', 'm.md')
  assert.equal(r2.success, false)
  assert.match(r2.error!, /模板字段 "disallowed_tools" 必须是非空字符串数组/)
  const r3 = parseTemplate('---\nname: t\nsubagent_type: doc-writer\nreadonly: yes\n---\n正文', 'm.md')
  assert.equal(r3.success, false)
  assert.match(r3.error!, /无效的 readonly 值/)
})

test('parser: 空数组 → 归一化为省略 + 卫生通知（infos，不上 UI）', async () => {
  const { parseTemplate } = await import('../../src/orchestrator/parsers/TemplateParser.ts')
  for (const field of ['tools', 'disallowed_tools', 'skills', 'knowledge']) {
    const r = parseTemplate(`---\nname: t\nsubagent_type: doc-writer\n${field}: []\n---\n正文`, 'm.md')
    assert.equal(r.success, true, `${field} 空数组应正常加载`)
    assert.equal((r.template as any)?.[field], undefined, `${field} 应归一化为省略`)
    assert.ok(r.infos?.some((i) => i.includes('空数组已按未声明处理')), `${field} 应有卫生通知`)
    assert.ok(!r.warnings?.some((w) => w.includes('空数组')), `${field} 无损归一化不应占用警告通道`)
  }
})

test('parser: tools [none] 归一化为省略 + 卫生通知；[none, x] 混写报错；[all, x] 忽略余项 + 警告', async () => {
  const { parseTemplate } = await import('../../src/orchestrator/parsers/TemplateParser.ts')
  const none = parseTemplate('---\nname: t\nsubagent_type: doc-writer\ntools: [none]\n---\n正文', 'm.md')
  assert.equal(none.success, true)
  assert.equal(none.template?.tools, undefined)
  assert.ok(none.infos?.some((i) => i.includes('none 仅在委派层')))
  const mixed = parseTemplate('---\nname: t\nsubagent_type: doc-writer\ntools: [none, read_file]\n---\n正文', 'm.md')
  assert.equal(mixed.success, false)
  assert.match(mixed.error!, /语义矛盾/)
  const allMixed = parseTemplate('---\nname: t\nsubagent_type: doc-writer\ntools: [all, read_file]\n---\n正文', 'm.md')
  assert.equal(allMixed.success, true)
  assert.deepEqual(allMixed.template?.tools, ['all'])
  assert.ok(allMixed.warnings?.some((w) => w.includes('其余条目已忽略')), '有损归一化必须走警告通道')
})

test('parser: none/all 出现在其他数组字段 → 明确报错', async () => {
  const { parseTemplate } = await import('../../src/orchestrator/parsers/TemplateParser.ts')
  const r = parseTemplate('---\nname: t\nsubagent_type: doc-writer\nskills: [none]\n---\n正文', 'm.md')
  assert.equal(r.success, false)
  assert.match(r.error!, /不支持关键字/)
})

test('parser: 声明 memory/knowledge 但零工具 → hedged 警告（不报错）', async () => {
  const { parseTemplate } = await import('../../src/orchestrator/parsers/TemplateParser.ts')
  const r = parseTemplate('---\nname: t\nsubagent_type: doc-writer\nmemory: user\n---\n正文', 'm.md')
  assert.equal(r.success, true)
  assert.ok(r.warnings?.some((w) => w.includes('零工具下可能部分不生效')))
  // 有 tools 则无此警告
  const r2 = parseTemplate('---\nname: t\nsubagent_type: doc-writer\nmemory: user\ntools: [save_memory]\n---\n正文', 'm.md')
  assert.equal(r2.success, true)
  assert.ok(!r2.warnings?.some((w) => w.includes('零工具下可能部分不生效')))
})

test('parser: 不写三字段 → undefined（向后兼容）', async () => {
  const { parseTemplate } = await import('../../src/orchestrator/parsers/TemplateParser.ts')
  const r = parseTemplate('---\nname: t\nsubagent_type: doc-writer\n---\n正文', 'm.md')
  assert.equal(r.success, true)
  assert.equal(r.template?.tools, undefined)
  assert.equal(r.template?.disallowed_tools, undefined)
  assert.equal(r.template?.readonly, undefined)
})
