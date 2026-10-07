import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerToolDefinitions as filterSubagentTools } from '../../src/services/collab/admission.ts'
import type { ToolDefinition } from '../../src/types/models.ts'

function def(name: string): ToolDefinition {
  return { type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } } as ToolDefinition
}

test('filterSubagentTools:默认剥掉全部编排工具定义(防套娃红线)', () => {
  const out = filterSubagentTools([def('task'), def('read_file'), def('team_board'), def('batch_task')])
  assert.deepEqual(out!.map((t) => t.function.name), ['read_file', 'team_board'])
})

test('filterSubagentTools:豁免名单内的编排工具定义保留(实测 bug 回归:授权不能被定义层剥空)', () => {
  const out = filterSubagentTools([def('task'), def('read_file'), def('batch_task')], ['task'])
  assert.deepEqual(out!.map((t) => t.function.name), ['task', 'read_file'])
})

test('filterSubagentTools:豁免为空数组时等同默认;undefined 定义列表原样返回 undefined', () => {
  const out = filterSubagentTools([def('task'), def('read_file')], [])
  assert.deepEqual(out!.map((t) => t.function.name), ['read_file'])
  assert.equal(filterSubagentTools(undefined), undefined)
})
