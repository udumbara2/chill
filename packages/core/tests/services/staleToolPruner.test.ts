import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pruneStaleToolResults,
  PRUNE_THRESHOLD_CHARS,
  PRUNE_HEAD_CHARS,
  PRUNE_TAIL_CHARS,
  PRUNE_MARKER,
} from '../../src/services/staleToolPruner.ts'
import type { Message } from '../../src/types/models.ts'

/**
 * R1 确定性剪枝纯函数单测：轮边界 / 阈值 / 头尾保留 / 配对完整 / 可逆性（不改入参） /
 * 代理对安全 / 全函数异常回退。
 */

const D = (h: number, m: number) => new Date(2025, 0, 1, h, m)

/** 五轮对话：每轮 user + assistant(带 toolCall) + TOOL；TOOL 内容长度可指定 */
function makeHistory(toolLens: number[]): Message[] {
  const out: Message[] = []
  toolLens.forEach((len, i) => {
    const h = 10 + i * 2
    out.push({ role: 'user', content: `第${i + 1}轮问题`, timestamp: D(h, 0) })
    out.push({
      role: 'assistant',
      content: '调工具',
      toolCalls: [{ id: `tc-${i}`, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }],
      timestamp: D(h, 1),
    } as Message)
    out.push({ role: 'tool', content: 'x'.repeat(len), toolCallId: `tc-${i}`, timestamp: D(h, 2) })
    out.push({ role: 'assistant', content: `第${i + 1}轮回答`, timestamp: D(h, 3) })
  })
  return out
}

test('旧轮超大 TOOL 被剪为头+标记+尾；最近 2 轮不动；小结果不动', () => {
  const big = PRUNE_THRESHOLD_CHARS + 100
  const history = makeHistory([big, big, big, 50, 60]) // 5 轮：前 3 轮旧、后 2 轮保留窗口
  const pruned = pruneStaleToolResults(history)

  const tool = (i: number) => pruned[i * 4 + 2]
  // 旧轮（第 1-3 轮）大结果被剪：头 + 标记 + 尾
  for (const i of [0, 1, 2]) {
    const c = tool(i).content as string
    assert.ok(c.includes(PRUNE_MARKER), `轮${i + 1} 应含剪枝标记`)
    assert.ok(c.startsWith('x'.repeat(PRUNE_HEAD_CHARS)), `轮${i + 1} 头部保留`)
    assert.ok(c.endsWith('x'.repeat(PRUNE_TAIL_CHARS)), `轮${i + 1} 尾部保留`)
    assert.ok(c.length < big, `轮${i + 1} 显著缩短`)
  }
  // 保留窗口（最近 2 轮）与小结果原样
  assert.equal(tool(3).content, 'x'.repeat(50))
  assert.equal(tool(4).content, 'x'.repeat(60))
})

test('纯函数可逆性：入参（权威历史代理）完全不被修改', () => {
  const big = PRUNE_THRESHOLD_CHARS + 100
  const history = makeHistory([big, big, big, 50, 60])
  const snapshot = JSON.stringify(history)
  const pruned = pruneStaleToolResults(history)
  assert.equal(JSON.stringify(history), snapshot, '入参数组与消息对象零改动')
  assert.notEqual(pruned, history, '返回新数组（有剪枝发生）')
})

test('配对完整：剪枝只改 content，toolCallId/结构原样', () => {
  const big = PRUNE_THRESHOLD_CHARS + 100
  const history = makeHistory([big, 30, big])
  const pruned = pruneStaleToolResults(history)
  // 每条 TOOL 的 toolCallId 保留
  assert.equal((pruned[2] as any).toolCallId, 'tc-0')
  assert.equal((pruned[10] as any).toolCallId, 'tc-2')
  // assistant 的 toolCalls 未动
  assert.deepEqual((pruned[1] as any).toolCalls, (history[1] as any).toolCalls)
})

test('轮不足（user ≤ keepRounds）：原样返回同一引用', () => {
  const history = makeHistory([PRUNE_THRESHOLD_CHARS + 10, PRUNE_THRESHOLD_CHARS + 10])
  const pruned = pruneStaleToolResults(history)
  assert.equal(pruned, history, '2 轮全在保留窗口，零分配返回原引用')
})

test('恰好阈值不剪（严格大于才剪）', () => {
  const history = makeHistory([PRUNE_THRESHOLD_CHARS, 30, 40])
  const pruned = pruneStaleToolResults(history)
  assert.equal(pruned[2].content, 'x'.repeat(PRUNE_THRESHOLD_CHARS))
})

test('代理对安全：emoji 边界不产生孤立代理', () => {
  const emoji = '😀'.repeat(Math.ceil((PRUNE_THRESHOLD_CHARS + 100) / 2)) // 每个 emoji 2 码元
  const history = makeHistory([emoji.length, 10, 20])
  history[2] = { role: 'tool', content: emoji, toolCallId: 'tc-0', timestamp: D(10, 2) }
  const pruned = pruneStaleToolResults(history)
  const c = pruned[2].content as string
  // 无孤立代理（每个代理对完整）：能被 UTF-8 round-trip 不炸
  assert.doesNotThrow(() => new TextEncoder().encode(c))
  assert.ok(c.startsWith('😀'))
})

test('全函数：ContentPart[] 形态的 TOOL content（非字符串）跳过不炸', () => {
  const history: Message[] = [
    { role: 'user', content: 'u1', timestamp: D(10, 0) },
    { role: 'user', content: 'u2', timestamp: D(10, 1) },
    { role: 'user', content: 'u3', timestamp: D(10, 2) },
    { role: 'user', content: 'u4', timestamp: D(10, 3) },
    // 非字符串 content 的异常消息（防御性形态）
    { role: 'tool', content: [{ type: 'text', text: 'x'.repeat(PRUNE_THRESHOLD_CHARS + 10) }], toolCallId: 'tc-x', timestamp: D(9, 0) } as any,
  ]
  const pruned = pruneStaleToolResults(history)
  assert.equal(pruned, history, '非字符串 content 一律跳过，原样返回')
})
