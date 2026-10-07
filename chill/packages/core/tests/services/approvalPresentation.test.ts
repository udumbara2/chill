import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalQuestionText,
  approvalOptions,
  normalizeApprovalAnswer,
} from '../../src/services/approvalPresentation.ts'
import type { ApprovalRequestPayload } from '../../src/services/approvals.ts'

function payload(overrides: Partial<ApprovalRequestPayload>): ApprovalRequestPayload {
  return { toolCallId: 'tc-1', kind: 'write', origin: { source: 'main' }, ...overrides }
}

test('approvalQuestionText: write 含归属行/路径/目录选项；subagent 与 mobile 归属文案', () => {
  const t1 = approvalQuestionText(payload({ path: 'D:\\out\\a.txt' }))
  assert.ok(t1.startsWith('主对话请求写入边界外文件'))
  assert.ok(t1.includes('路径: D:\\out\\a.txt'))
  assert.ok(t1.includes('[d]批准并把目录 D:\\out 加入本次会话'))
  assert.ok(t1.includes('[Esc]拒绝'))

  const t2 = approvalQuestionText(payload({ origin: { source: 'subagent', subagentType: 'writer', taskId: 't' } }))
  assert.ok(t2.startsWith('后台任务 writer请求'))

  const t3 = approvalQuestionText(payload({ origin: { source: 'mobile' } }))
  assert.ok(t3.startsWith('手机（mobile origin，5 分钟无人应答自动拒绝）请求'))
})

test('approvalQuestionText: command 含命令与说明；sessionGrantable 换桌面操作标题并加 [s]', () => {
  const t1 = approvalQuestionText(payload({ kind: 'command', command: 'npm test', detail: '跑回归' }))
  assert.ok(t1.includes('主对话请求执行PowerShell 命令'))
  assert.ok(t1.includes('命令: npm test'))
  assert.ok(t1.includes('说明: 跑回归'))
  assert.ok(!t1.includes('[s]'))

  const t2 = approvalQuestionText(payload({ kind: 'command', command: 'click', sessionGrantable: true }))
  assert.ok(t2.includes('请求执行桌面操作'))
  assert.ok(t2.includes('动作: click'))
  assert.ok(t2.includes('[s]本次会话内放行桌面操作'))
})

test('approvalOptions: write 三选（d 附目录）；command 两选；sessionGrantable 加 s', () => {
  const w = approvalOptions(payload({ path: 'C:\\p\\f.txt' }))
  assert.deepEqual(
    w.map((o) => [o.label, o.description]),
    [
      ['y', '批准一次'],
      ['d', '批准并把目录加入本次会话: C:\\p'],
      ['n', '拒绝'],
    ],
  )
  const c = approvalOptions(payload({ kind: 'command' }))
  assert.deepEqual(c.map((o) => o.label), ['y', 'n'])
  const s = approvalOptions(payload({ kind: 'command', sessionGrantable: true }))
  assert.deepEqual(s.map((o) => o.label), ['y', 's', 'n'])
})

test('normalizeApprovalAnswer: write 的 y/yes/1 批准、d 加目录、其余拒绝（含 esc）', () => {
  const p = payload({ path: 'D:\\dir\\f.txt' })
  for (const a of ['y', 'Y', 'yes', '1', ' y ']) {
    assert.deepEqual(normalizeApprovalAnswer(p, a), { approved: true })
  }
  assert.deepEqual(normalizeApprovalAnswer(p, 'd'), { approved: true, addDir: 'D:\\dir' })
  // d 但路径无目录可解析 → 拒绝（安全默认）
  assert.deepEqual(normalizeApprovalAnswer(payload({ path: 'f.txt' }), 'd'), { approved: false, reason: '用户拒绝写入' })
  for (const a of ['n', 'esc', '随便']) {
    assert.deepEqual(normalizeApprovalAnswer(p, a), { approved: false, reason: '用户拒绝写入' })
  }
})

test('normalizeApprovalAnswer: command 的 y/s 批准（s 透传 allowSession）、其余拒绝', () => {
  const p = payload({ kind: 'command', command: 'ls' })
  assert.deepEqual(normalizeApprovalAnswer(p, 'y'), { approved: true })
  assert.deepEqual(normalizeApprovalAnswer(p, '1'), { approved: true })
  assert.deepEqual(normalizeApprovalAnswer(p, 's'), { approved: true, allowSession: true })
  assert.deepEqual(normalizeApprovalAnswer(p, 'n'), { approved: false, reason: '用户拒绝执行' })
  assert.deepEqual(normalizeApprovalAnswer(p, ''), { approved: false, reason: '用户拒绝执行' })
})
