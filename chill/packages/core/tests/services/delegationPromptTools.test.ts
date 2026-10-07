import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatSubagentsForPrompt } from '../../src/services/delegation/delegationPrompt.ts'
import type { AvailableSubagent } from '../../src/orchestrator/types.ts'

function sub(extra: Partial<AvailableSubagent>): AvailableSubagent {
  return {
    type: 'a',
    name: 'A',
    description: 'd',
    capabilities: [],
    applicableScenarios: [],
    ...extra,
  }
}

test('委派指南展示: readonly 模板 → 只读标注，不展示名单行', () => {
  const text = formatSubagentsForPrompt([
    sub({ name: '评审', templateType: 'builtin', readonly: true }),
  ])
  assert.ok(text.includes('只读 agent'))
  assert.ok(!text.includes('默认工具'), 'readonly 不展示名单行')
})

test('委派指南展示: 默认名单模板 → 名单原文 + 可覆盖提示（非天花板）', () => {
  const text = formatSubagentsForPrompt([
    sub({ name: '检索', templateType: 'custom', tools: ['read_file', 'grep'] }),
  ])
  assert.ok(text.includes('默认工具: read_file, grep'))
  assert.ok(text.includes('显式指派则覆盖'), '名单是默认而非天花板')
})

test('委派指南展示: 黑名单模板 → 禁用名单展示（零默认 + 约束）', () => {
  const text = formatSubagentsForPrompt([
    sub({ name: '无 shell', templateType: 'custom', disallowedTools: ['execute_powershell'] }),
  ])
  assert.ok(text.includes('禁用工具: execute_powershell'))
  // 省略 tools = 零默认：显式告知 Lead
  assert.ok(text.includes('默认工具: 无'))
})

test('委派指南展示: 未声明 tools → 零默认行；tools:[all] → 全部行；远程模板 → 不展示', () => {
  const text = formatSubagentsForPrompt([
    sub({ name: '甲', templateType: 'builtin' }),
    sub({ name: '乙', templateType: 'builtin', tools: ['all'] }),
    sub({ name: '丙', templateType: 'remote-api', tools: ['read_file'], readonly: true }),
  ])
  assert.ok(text.includes('甲'), '甲在列表中')
  assert.ok(/甲[\s\S]*?默认工具: 无/.test(text), '甲（未声明）应显示零默认行')
  assert.ok(/乙[\s\S]*?默认工具: 全部/.test(text), '乙（[all]）应显示全部行')
  assert.ok(!/丙[\s\S]*?默认工具/.test(text), '丙（远程模板）不展示工具行')
})
