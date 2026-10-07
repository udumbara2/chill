import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateMessage, partitionMessages, findCollapsibleDuplicateIndices } from '../../src/services/history/historyValidator.ts'

const ok = (m: any): void => assert.deepEqual(validateMessage(m), { ok: true })
const bad = (m: any, reasonIncludes: string): void => {
  const r = validateMessage(m)
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.reason.includes(reasonIncludes), `reason 应含「${reasonIncludes}」，实得 ${!r.ok ? r.reason : ''}`)
}

// ---------- 合法矩阵（严禁误伤既有正常消息） ----------

test('合法：普通 user/assistant/system 文本消息', () => {
  ok({ role: 'user', content: '你好', timestamp: '2026-09-26T05:03:22.762Z' })
  ok({ role: 'assistant', content: '答', reasoningContent: '想', timestamp: '2026-09-26T05:03:55.347Z' })
  ok({ role: 'system', content: '系统提示', timestamp: '2026-09-26T00:00:00.000Z' })
})

test('合法：多模态数组 content（不碰内容形状）', () => {
  ok({
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } }],
    timestamp: '2026-09-26T00:00:00.000Z',
  })
})

test('合法：assistant 带完好 toolCalls（含空数组/缺键）', () => {
  ok({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_00_vKfpiwiURcsoevb7W4te5181', type: 'function', function: { name: 'team_board', arguments: '{"action":"post"}' } }],
    timestamp: '2026-09-26T00:00:00.000Z',
  })
  ok({ role: 'assistant', content: 'x', toolCalls: [], timestamp: '2026-09-26T00:00:00.000Z' })
  ok({ role: 'assistant', content: 'x', timestamp: '2026-09-26T00:00:00.000Z' })
})

test('合法：tool 消息带非空 toolCallId（status/result 等内容层字段不碰）', () => {
  ok({
    role: 'tool',
    content: '工具结果',
    toolCallId: 'call_00_vKfpiwiURcsoevb7W4te5181',
    toolCallStatus: 'success',
    mcpServerName: 'local',
    toolResult: '...',
    timestamp: '2026-09-26T00:00:00.000Z',
  })
})

test('合法：synthetic 合成消息（user 角色 + 标记，含未来的 roundFailure）', () => {
  ok({ role: 'user', content: '（后台任务已回流）', synthetic: 'settledNotice', timestamp: '2026-09-26T00:00:00.000Z' })
  ok({ role: 'user', content: '（本轮处理失败：…）', synthetic: 'roundFailure', timestamp: '2026-09-26T00:00:00.000Z' })
})

// ---------- 非法矩阵（事故实证形态必须全拦） ----------

test('非法：事故 idx66 形态——toolCalls id/name 显式 null', () => {
  bad(
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { index: 0, id: null, type: 'function', function: { arguments: '{"action":"post"}', name: null } },
      ],
      timestamp: '2026-09-26T05:03:55.347Z',
    },
    '.id 缺失或为空',
  )
})

test('非法：toolCalls id/name 缺键、空串、空白串同罪', () => {
  bad({ role: 'assistant', toolCalls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }] }, '.id')
  bad({ role: 'assistant', toolCalls: [{ id: '', function: { name: 'f', arguments: '{}' } }] }, '.id')
  bad({ role: 'assistant', toolCalls: [{ id: 'c1', function: { name: ' ', arguments: '{}' } }] }, 'function.name')
  bad({ role: 'assistant', toolCalls: [{ id: 'c1', function: { arguments: '{}' } }] }, 'function.name')
})

test('非法：tool 消息 toolCallId null/缺失（事故 idx67/68 形态）', () => {
  bad({ role: 'tool', content: '工具调用失败: 未找到工具: null', toolCallId: null, timestamp: '2026-09-26T05:03:55.379Z' }, 'toolCallId')
  bad({ role: 'tool', content: 'x', timestamp: '2026-09-26T00:00:00.000Z' }, 'toolCallId')
})

test('非法：role 垃圾值 / 非对象 / toolCalls 非数组', () => {
  bad({ role: 'toolx', content: 'x' }, 'role 非法')
  bad(null, '消息不是对象')
  bad(42, '消息不是对象')
  bad({ role: 'assistant', toolCalls: { id: 'c1' } }, '不是数组')
})

// ---------- partitionMessages ----------

test('partition：保序分组、非法项携带原始索引与原因', () => {
  const msgs: any[] = [
    { role: 'user', content: 'a' },
    { role: 'assistant', toolCalls: [{ id: null, function: { name: null } }] },
    { role: 'tool', content: 'r', toolCallId: 'c1' },
    { role: 'tool', content: 'bad', toolCallId: null },
  ]
  const { valid, invalid } = partitionMessages(msgs)
  assert.equal(valid.length, 2)
  assert.deepEqual((valid[0] as any).content, 'a')
  assert.deepEqual((valid[1] as any).toolCallId, 'c1')
  assert.equal(invalid.length, 2)
  assert.equal(invalid[0].index, 1)
  assert.ok(invalid[0].reason.includes('.id'))
  assert.equal(invalid[1].index, 3)
  assert.ok(invalid[1].reason.includes('toolCallId'))
})

// ---------- findCollapsibleDuplicateIndices（doctor repair 的折叠判据） ----------

test('折叠：ABABAB 交替重复（事故真实形态）在无 assistant 间隔段内全部折叠保首份', () => {
  const msgs: any[] = [
    { role: 'user', content: '问题A' },
    { role: 'user', content: '追问B' },
    { role: 'user', content: '问题A' },
    { role: 'user', content: '追问B' },
    { role: 'user', content: '问题A' },
    { role: 'user', content: '追问B' },
  ]
  assert.deepEqual(findCollapsibleDuplicateIndices(msgs), [2, 3, 4, 5])
})

test('折叠：assistant 回复隔开的重复发言不折叠（人的显式决定）', () => {
  const msgs: any[] = [
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '继续' },
  ]
  assert.deepEqual(findCollapsibleDuplicateIndices(msgs), [])
})

test('折叠：tool/system 消息不参与也不打断段；连续同文同样折叠', () => {
  const msgs: any[] = [
    { role: 'user', content: '查时间' },
    { role: 'user', content: '查时间' },
    { role: 'user', content: '查时间' },
  ]
  assert.deepEqual(findCollapsibleDuplicateIndices(msgs), [1, 2])
})

test('折叠：畸形 assistant（待隔离）不算回复隔断——doctor 先剔除非法再折叠后仍能收敛', () => {
  // 事故序列：A、畸形assistant、tool、tool、A、A、B、A、B…
  const msgs: any[] = [
    { role: 'user', content: 'A' },
    { role: 'assistant', toolCalls: [{ id: null, function: { name: null } }] }, // 将被读闸剔除
    { role: 'tool', content: 'x', toolCallId: null },
    { role: 'user', content: 'A' },
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
  ]
  // 直接折叠：畸形 assistant 隔断 → 65/69 两段各保首份（2 个 A 保留）
  assert.deepEqual(findCollapsibleDuplicateIndices(msgs), [4, 6, 7])
  // doctor 流程：先剔除非法（idx 1、2）再折叠 → 剩余全在同一无 assistant 段 → 只保首份
  const invalidIdx = new Set([1, 2])
  const cleaned = msgs.filter((_, i) => !invalidIdx.has(i))
  const cleanedIdx = msgs.map((_, i) => i).filter((i) => !invalidIdx.has(i))
  const dupOrig = findCollapsibleDuplicateIndices(cleaned).map((j) => cleanedIdx[j])
  assert.deepEqual(dupOrig, [3, 4, 6, 7], '剔除畸形后：A 只保首份、B 只保首份')
})
