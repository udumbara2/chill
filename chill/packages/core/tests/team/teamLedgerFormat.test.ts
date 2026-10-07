import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTokenSpend } from '../../src/services/team/teamLedgerFormat.ts'

test('formatTokenSpend 三态:无计量数据 → 未知(ledger 缺省同)', () => {
  assert.equal(formatTokenSpend(undefined), '未知')
  assert.equal(formatTokenSpend({ spentTokens: null, memberCount: 1 }), '未知')
})

test('formatTokenSpend 三态:含估值 → ~N(估值)(绝不假装精确)', () => {
  assert.equal(formatTokenSpend({ spentTokens: 200, memberCount: 1, estimated: true }), '~200(估值)')
})

test('formatTokenSpend 三态:全实测 → N', () => {
  assert.equal(formatTokenSpend({ spentTokens: 200, memberCount: 1 }), '200')
  assert.equal(formatTokenSpend({ spentTokens: 0, memberCount: 1 }), '0')
})
