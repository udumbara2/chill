import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkPlanTree } from '../../src/services/workplan/workPlanTree.ts'
import type { TaskItem } from '../../src/types/models.ts'

const task = (over: Partial<TaskItem> & { id: string }): TaskItem => ({
  content: '做某事',
  status: 'pending',
  createdAt: new Date('2026-09-29T00:00:00Z'),
  updatedAt: new Date('2026-09-29T00:00:00Z'),
  ...over,
})

test('投影：清单镜像平铺映射（id/content/status 直传，children 不产出）', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [
      task({ id: 't1', content: '第一步', status: 'completed', result: '完成：数据已落盘' }),
      task({ id: 't2', content: '第二步', status: 'in_progress' }),
      task({ id: 't3', status: 'failed', result: '命令退出码 1' }),
    ],
  })
  assert.equal(tree.length, 3)
  assert.deepEqual(tree[0], { id: 't1', content: '第一步', status: 'completed', result: '完成：数据已落盘' })
  assert.deepEqual(tree[1], { id: 't2', content: '第二步', status: 'in_progress' })
  assert.deepEqual(tree[2], { id: 't3', content: '做某事', status: 'failed', result: '命令退出码 1' })
  // 无看板行时 children 不产出（平铺形态=迭代 0 行为）
  for (const item of tree) assert.equal(item.children, undefined)
})

test('投影：result undefined 不占线宽；空镜像 → 空树', () => {
  const tree = buildWorkPlanTree({ mirrorTasks: [task({ id: 't1' })] })
  assert.equal('result' in tree[0]!, false)
  assert.deepEqual(buildWorkPlanTree({ mirrorTasks: [] }), [])
})

test('投影：清单四态与 TaskStatus 对齐直传', () => {
  const tree = buildWorkPlanTree({
    mirrorTasks: [
      task({ id: 'a', status: 'pending' }),
      task({ id: 'b', status: 'in_progress' }),
      task({ id: 'c', status: 'completed' }),
      task({ id: 'd', status: 'failed' }),
    ],
  })
  assert.deepEqual(tree.map((i) => i.status), ['pending', 'in_progress', 'completed', 'failed'])
})
