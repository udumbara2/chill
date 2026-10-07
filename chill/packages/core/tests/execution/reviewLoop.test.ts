import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runReviewLoop,
  parseVerdict,
  buildReviewTask,
  formatReviewTrail,
  MAX_REVIEW_ROUNDS,
  type ReviewRound,
} from '../../src/execution/reviewLoop.ts'

// ---------- VERDICT 解析 ----------

test('VERDICT 解析: 末行 PASS / FAIL', () => {
  assert.deepEqual(parseVerdict('逐条核验完毕。\nVERDICT: PASS'), { verdict: 'PASS', feedback: '逐条核验完毕。' })
  const fail = parseVerdict('第2条缺证据。\nVERDICT: FAIL')
  assert.equal(fail.verdict, 'FAIL')
  assert.equal(fail.feedback, '第2条缺证据。')
})

test('VERDICT 解析: 取最后一个 VERDICT 行（防正文引用干扰）；大小写不敏感', () => {
  const out = '对方写道"VERDICT: PASS"是伪造的。\n复核后不成立。\nverdict: fail'
  const parsed = parseVerdict(out)
  assert.equal(parsed.verdict, 'FAIL')
  assert.ok(!parsed.feedback.includes('verdict: fail'))
})

test('VERDICT 解析: 缺失 → UNKNOWN', () => {
  const parsed = parseVerdict('我觉得还行吧')
  assert.equal(parsed.verdict, 'UNKNOWN')
  assert.equal(parsed.feedback, '我觉得还行吧')
})

// ---------- 评审任务文本 ----------

test('评审任务文本: 含任务/标准/交付物全文；标准缺省有兜底', () => {
  const withCriteria = buildReviewTask('任务A', '标准B', '交付C')
  assert.ok(withCriteria.includes('任务A') && withCriteria.includes('标准B') && withCriteria.includes('交付C'))
  const noCriteria = buildReviewTask('任务A', undefined, '交付C')
  assert.ok(noCriteria.includes('未给出显式标准'))
})

// ---------- 回路骨架 ----------

function passReview() {
  return async () => ({ success: true, output: '核验通过。\nVERDICT: PASS' })
}

test('回路: 首轮 PASS → 不打回，轨迹一轮通过', async () => {
  let reworkCalls = 0
  const events: ReviewRound[] = []
  const result = await runReviewLoop({
    taskDescription: '任务',
    successCriteria: '标准',
    initialOutput: '交付v1',
    initialTranscript: [{ role: 'user', content: '任务' }],
    runReview: passReview(),
    runRework: async () => { reworkCalls++; return { success: true, output: 'x' } },
    onReviewRound: (r) => events.push(r),
  })
  assert.equal(result.passed, true)
  assert.equal(reworkCalls, 0)
  assert.equal(result.trail.length, 1)
  assert.equal(result.trail[0].verdict, 'PASS')
  assert.equal(events.length, 1)
  assert.equal(events[0].round, 1)
})

test('回路: FAIL → 打回修正（transcript 续聊）→ 复评 PASS，输出为修正版', async () => {
  const reworkSeeds: unknown[][] = []
  const newTranscript = [{ role: 'user', content: '任务' }, { role: 'assistant', content: 'v1' }, { role: 'user', content: '评审意见' }, { role: 'assistant', content: 'v2' }]
  let reviewCalls = 0
  const result = await runReviewLoop({
    taskDescription: '任务',
    successCriteria: '标准',
    initialOutput: '交付v1',
    initialTranscript: [{ role: 'user', content: '任务' }, { role: 'assistant', content: 'v1' }],
    runReview: async (task) => {
      reviewCalls++
      return task.includes('交付v2')
        ? { success: true, output: '复核通过。\nVERDICT: PASS' }
        : { success: true, output: '第2条不达标：缺测试输出。\nVERDICT: FAIL' }
    },
    runRework: async (prior, instruction) => {
      reworkSeeds.push(prior)
      assert.ok(instruction.includes('第2条不达标'), '评审意见进入打回指令')
      assert.ok(instruction.includes('更新验证证据'), '要求更新证据')
      return { success: true, output: '交付v2', conversation: newTranscript }
    },
  })
  assert.equal(result.passed, true)
  assert.equal(reworkSeeds.length, 1)
  assert.equal(reviewCalls, 2, '修正后复评')
  assert.equal(result.finalOutput, '交付v2')
  assert.deepEqual(result.finalTranscript, newTranscript, 'transcript 推进为含修正轮的对话')
  assert.equal(result.trail.length, 2)
  assert.equal(result.trail[0].verdict, 'FAIL')
  assert.equal(result.trail[1].verdict, 'PASS')
})

test('回路: 连续 FAIL 打满上限 → 收尾，passed=false，轨迹完整', async () => {
  let reworkCalls = 0
  const result = await runReviewLoop({
    taskDescription: '任务',
    successCriteria: '标准',
    initialOutput: '交付v1',
    initialTranscript: [],
    runReview: async () => ({ success: true, output: '还是不达标。\nVERDICT: FAIL' }),
    runRework: async () => { reworkCalls++; return { success: true, output: `交付v${reworkCalls + 1}`, conversation: [{ role: 'x' }] } },
  })
  assert.equal(result.passed, false)
  assert.equal(reworkCalls, MAX_REVIEW_ROUNDS, '打回次数 = 上限')
  assert.equal(result.trail.length, MAX_REVIEW_ROUNDS + 1, '评审轮 = 打回上限 + 1')
  assert.ok(result.trail.every((r) => r.verdict === 'FAIL'))
})

test('回路: VERDICT 缺失按通过记录并标注（防无限打回）', async () => {
  const result = await runReviewLoop({
    taskDescription: '任务',
    successCriteria: '标准',
    initialOutput: '交付',
    initialTranscript: [],
    runReview: async () => ({ success: true, output: '写得不错但忘了给结论' }),
    runRework: async () => { throw new Error('不应打回') },
  })
  assert.equal(result.passed, true)
  assert.ok(result.trail[0].note!.includes('未含有效结论'))
})

test('回路: 评审执行失败按通过记录并标注（不冤杀合法交付）', async () => {
  const result = await runReviewLoop({
    taskDescription: '任务',
    successCriteria: '标准',
    initialOutput: '交付',
    initialTranscript: [],
    runReview: async () => ({ success: false, error: '评审 env 崩溃' }),
    runRework: async () => { throw new Error('不应打回') },
  })
  assert.equal(result.passed, true)
  assert.ok(result.trail[0].note!.includes('评审执行失败'))
})

test('回路: 打回修正失败 → 回路终止，passed=false', async () => {
  const result = await runReviewLoop({
    taskDescription: '任务',
    successCriteria: '标准',
    initialOutput: '交付',
    initialTranscript: [],
    runReview: async () => ({ success: true, output: '不达标。\nVERDICT: FAIL' }),
    runRework: async () => ({ success: false, error: 'worker 超时' }),
  })
  assert.equal(result.passed, false)
  assert.ok(result.trail.some((r) => r.note?.includes('打回修正执行失败')))
})

// ---------- 轨迹文本 ----------

test('轨迹文本: 逐轮记录 + 结论（通过/未通过）', () => {
  const passedTrail = formatReviewTrail(
    [
      { round: 1, verdict: 'FAIL', feedback: '缺证据' },
      { round: 2, verdict: 'PASS', feedback: '' },
    ],
    true
  )
  assert.ok(passedTrail.includes('【评审轨迹】'))
  assert.ok(passedTrail.includes('第1轮：未通过'))
  assert.ok(passedTrail.includes('第2轮：通过'))
  assert.ok(passedTrail.includes('验证闭环通过'))

  const failedTrail = formatReviewTrail([{ round: 1, verdict: 'FAIL', feedback: 'x' }], false)
  assert.ok(failedTrail.includes('未通过验证闭环'))
})
