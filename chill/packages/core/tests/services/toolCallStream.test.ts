import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MalformedToolCallError,
  accumulateToolCallDelta,
  finalizeToolCalls,
} from '../../src/services/models/toolCallStream.ts'

// ---------- 事故回归：显式 null 分片不得抹掉好值（2026-09-26 会话 1790344238830-ro7xyr） ----------

test('事故形态·后续分片带显式 null：好 id/name 保留（null 不是信息，不覆盖）', () => {
  let acc: any[] = []
  // 首片：id/name/arguments 正常到达
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 0, id: 'call_00_ab', type: 'function', function: { name: 'team_board', arguments: '{"a' } }] },
    acc,
  )
  // 后续分片：arguments 续片 + 显式 "id": null / "name": null（事故实锤形态）
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '":1}' } }] },
    acc,
  )
  assert.equal(acc.length, 1)
  assert.equal(acc[0].id, 'call_00_ab')
  assert.equal(acc[0].function.name, 'team_board')
  assert.equal(acc[0].function.arguments, '{"a":1}')
  // 终局校验通过
  assert.doesNotThrow(() => finalizeToolCalls(acc))
})

test('事故形态·首片即 null：不产生"显式 null 键"，终局校验判畸形', () => {
  let acc: any[] = []
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 0, id: null, type: 'function', function: { name: null, arguments: '{"action":"post"}' } }] },
    acc,
  )
  acc = accumulateToolCallDelta({ tool_calls: [{ index: 0, function: { arguments: '' } }] }, acc)
  // 首片 null 无信息可保 → 键缺失（非显式 null），finalize 拦截
  assert.ok(!('id' in acc[0]) || acc[0].id !== null)
  assert.throws(() => finalizeToolCalls(acc), MalformedToolCallError)
})

// ---------- 单调性矩阵 ----------

test('缺键分片（只带 arguments）不覆盖 id/name', () => {
  let acc: any[] = []
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{' } }] },
    acc,
  )
  acc = accumulateToolCallDelta({ tool_calls: [{ index: 0, function: { arguments: '}' } }] }, acc)
  assert.equal(acc[0].id, 'c1')
  assert.equal(acc[0].function.name, 'f')
  assert.equal(acc[0].function.arguments, '{}')
})

test('空串分片不覆盖好值', () => {
  let acc: any[] = []
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    acc,
  )
  acc = accumulateToolCallDelta({ tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '' } }] }, acc)
  assert.equal(acc[0].id, 'c1')
  assert.equal(acc[0].function.name, 'f')
  assert.equal(acc[0].function.arguments, '{}')
})

test('换新 id（后到的合法 id）覆盖旧 id——最新信息仍被采纳', () => {
  let acc: any[] = []
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 0, id: 'c-old', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    acc,
  )
  acc = accumulateToolCallDelta({ tool_calls: [{ index: 0, id: 'c-new' }] }, acc)
  assert.equal(acc[0].id, 'c-new')
})

// ---------- 槽位语义（对齐旧实现） ----------

test('缺 index 的分片开新槽，不合并进已有槽', () => {
  let acc: any[] = []
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f1', arguments: '{}' } }] },
    acc,
  )
  acc = accumulateToolCallDelta({ tool_calls: [{ function: { name: 'f2', arguments: '{}' } }] }, acc)
  assert.equal(acc.length, 2)
  assert.equal(acc[1].function.name, 'f2')
})

test('索引空洞（index 超出当前长度）按旧语义 push', () => {
  let acc: any[] = []
  acc = accumulateToolCallDelta(
    { tool_calls: [{ index: 3, id: 'c3', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    acc,
  )
  assert.equal(acc.length, 1)
  assert.equal(acc[0].id, 'c3')
})

test('非数组 tool_calls / 空对象 delta：原样返回不炸', () => {
  const acc: any[] = [{ index: 0, id: 'c1', function: { name: 'f', arguments: '' } }]
  assert.equal(accumulateToolCallDelta({}, acc), acc)
  assert.equal(accumulateToolCallDelta({ tool_calls: 'x' }, acc), acc)
  assert.equal(accumulateToolCallDelta({ tool_calls: [null, 42] }, acc).length, 1)
})

test('多工具并行：两槽各自单调累积（事故是 2 个 toolCall）', () => {
  let acc: any[] = []
  acc = accumulateToolCallDelta(
    {
      tool_calls: [
        { index: 0, id: 'call_A', type: 'function', function: { name: 'team_board', arguments: '{"t' } },
        { index: 1, id: 'call_B', type: 'function', function: { name: 'tavily_search', arguments: '{"q' } },
      ],
    },
    acc,
  )
  acc = accumulateToolCallDelta(
    {
      tool_calls: [
        { index: 0, id: null, function: { name: null, arguments: '":1}' } },
        { index: 1, function: { arguments: '":2}' } },
      ],
    },
    acc,
  )
  assert.equal(acc.length, 2)
  assert.equal(acc[0].id, 'call_A')
  assert.equal(acc[0].function.name, 'team_board')
  assert.equal(acc[0].function.arguments, '{"t":1}')
  assert.equal(acc[1].id, 'call_B')
  assert.equal(acc[1].function.name, 'tavily_search')
  assert.equal(acc[1].function.arguments, '{"q":2}')
  assert.doesNotThrow(() => finalizeToolCalls(acc))
})

// ---------- finalizeToolCalls ----------

test('finalize 合法矩阵：无参（空串/空白）、合法 JSON、多参对象全通过', () => {
  assert.deepEqual(finalizeToolCalls([]), [])
  assert.deepEqual(finalizeToolCalls(undefined), [])
  assert.doesNotThrow(() =>
    finalizeToolCalls([
      { id: 'c1', type: 'function', function: { name: 'f', arguments: '' } },
      { id: 'c2', type: 'function', function: { name: 'g', arguments: '   ' } },
      { id: 'c3', type: 'function', function: { name: 'h', arguments: '{"a":[1,2],"b":"中"}' } },
    ]),
  )
})

test('finalize 安全关键：非空但不可解析的 arguments 判畸形（流截断场景，绝不静默置空）', () => {
  assert.throws(
    () => finalizeToolCalls([{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"path":"a' } }]),
    MalformedToolCallError,
  )
})

test('finalize 报错明细含每一项问题（畸形双 toolCall 全点名）', () => {
  try {
    finalizeToolCalls([
      { id: null, type: 'function', function: { name: null, arguments: '{}' } },
      { type: 'function', function: { arguments: '{"a"' } },
    ])
    assert.fail('应抛 MalformedToolCallError')
  } catch (err) {
    assert.ok(err instanceof MalformedToolCallError)
    const m = (err as Error).message
    assert.ok(m.includes('第1项 id'))
    assert.ok(m.includes('第1项 function.name'))
    assert.ok(m.includes('第2项 arguments'))
  }
})
