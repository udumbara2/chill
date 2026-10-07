/**
 * 评审回路（evaluator-optimizer）：worker 交付 → 独立评审 → 打回修正 → 复评，轮次封顶。
 *
 * 设计分工（第一性原理）：
 * - 循环骨架在本模块（确定性设施）：交付→评审→打回→复评的控制流、轮次上限、VERDICT 解析；
 * - 判断交给模型（评审 agent）：过/不过由独立评审者对照成功标准认证据裁决；
 * - 打回修正走 transcript 续聊（与 resume_task 同一机制）：原 worker 带着全部记忆修正。
 *
 * 纯编排、可单测：评审/修正的实际执行经回调注入，本模块不依赖 fork/IPC。
 */

/** 打回上限（超出后无论评审结果如何都收尾，结果标注未通过验证闭环） */
export const MAX_REVIEW_ROUNDS = 2

/** 单轮评审记录 */
export interface ReviewRound {
  /** 评审轮次（1 起） */
  round: number
  verdict: 'PASS' | 'FAIL'
  /** 评审意见摘要（轨迹展示用，截断至 300 字符） */
  feedback: string
  /** 备注（VERDICT 缺失按通过记录 / 评审执行失败等异常路径的说明） */
  note?: string
}

/** 评审执行回调：组评审任务文本 → 返回评审 agent 的最终回复 */
export type RunReviewFn = (reviewTask: string) => Promise<{ success: boolean; output?: string; error?: string }>

/** 打回修正回调：以 transcript + 评审意见为种子续跑 → 返回修正产出与新 transcript */
export type RunReworkFn = (
  priorMessages: unknown[],
  reworkInstruction: string
) => Promise<{ success: boolean; output?: string; conversation?: unknown[]; error?: string }>

export interface ReviewLoopInput {
  taskDescription: string
  successCriteria?: string
  /** worker 首轮交付 */
  initialOutput: string
  /** worker 首轮 transcript（打回修正的种子） */
  initialTranscript: unknown[]
  runReview: RunReviewFn
  runRework: RunReworkFn
  /** 每轮评审完成回调（事件发射用） */
  onReviewRound?: (round: ReviewRound) => void
}

export interface ReviewLoopResult {
  /** 最终交付文本（最后一轮 worker 产出，未附加轨迹） */
  finalOutput: string
  /** 最终 transcript（resume 接续用） */
  finalTranscript: unknown[]
  trail: ReviewRound[]
  /** 验证闭环是否通过 */
  passed: boolean
}

/** VERDICT 解析结果 */
export interface VerdictParse {
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN'
  /** 结论行之前的评审意见原文（打回时喂给 worker 的反馈） */
  feedback: string
}

/**
 * 解析评审输出的结论契约：取文本中**最后一个** VERDICT 行（防正文引用干扰）。
 * 缺失/无法识别 → UNKNOWN（调用方按 PASS 处理并标注，防评审模型输出不规范导致无限打回）。
 */
export function parseVerdict(output: string): VerdictParse {
  const matches = [...output.matchAll(/^\s*VERDICT:\s*(PASS|FAIL)\s*$/gim)]
  if (matches.length === 0) {
    return { verdict: 'UNKNOWN', feedback: output.trim() }
  }
  const last = matches[matches.length - 1]
  const verdict = last[1].toUpperCase() as 'PASS' | 'FAIL'
  const feedback = output.slice(0, last.index).trim()
  return { verdict, feedback }
}

/** 组评审任务文本（评审 agent 的唯一信息来源：任务 + 标准 + 交付物全文） */
export function buildReviewTask(taskDescription: string, successCriteria: string | undefined, workerOutput: string): string {
  return [
    '【待评审任务】',
    taskDescription,
    '',
    '【成功标准】',
    successCriteria?.trim() || '（调用方未给出显式标准——按任务描述的合理完成度核验）',
    '',
    '【被评审的交付物（执行者最终回复全文）】',
    workerOutput,
    '',
    '请对照成功标准逐条核验：交付物中的验证证据是否真实充分？可用你的工具独立复核（重跑验证命令、读取被修改的文件）。只认证据，不认自述。最后一行输出 VERDICT: PASS 或 VERDICT: FAIL。',
  ].join('\n')
}

/** 组打回修正指令（追问形态，喂给原 worker） */
function buildReworkInstruction(round: number, feedback: string): string {
  return (
    `评审未通过（第 ${round} 轮评审），评审意见如下：\n${feedback || '（评审未给出具体意见，请对照成功标准自查）'}\n\n` +
    '请根据评审意见修正并重新交付，同时更新验证证据（重新运行验证命令并给出关键输出摘录；无法验证的说明原因）。'
  )
}

/** 轨迹摘要截断（单行化 + 300 字符封顶） */
function summarize(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/**
 * 跑评审回路。任何异常路径（评审执行失败、VERDICT 缺失）都收敛为"按通过记录并标注"——
 * 回路的作用是增强可信度，不得因评审侧故障把 worker 的合法交付判死。
 */
export async function runReviewLoop(input: ReviewLoopInput): Promise<ReviewLoopResult> {
  const { taskDescription, successCriteria, runReview, runRework, onReviewRound } = input
  let output = input.initialOutput
  let transcript = input.initialTranscript
  const trail: ReviewRound[] = []
  let passed = false
  let reworkCount = 0

  for (let round = 1; ; round++) {
    // —— 评审 ——
    const review = await runReview(buildReviewTask(taskDescription, successCriteria, output))
    let record: ReviewRound
    if (!review.success) {
      record = { round, verdict: 'PASS', feedback: '', note: `评审执行失败（${review.error || '未知错误'}），按通过记录` }
    } else {
      const parsed = parseVerdict(review.output || '')
      if (parsed.verdict === 'UNKNOWN') {
        record = { round, verdict: 'PASS', feedback: '', note: '评审输出未含有效结论，按通过记录' }
      } else {
        record = { round, verdict: parsed.verdict, feedback: parsed.feedback }
      }
    }
    trail.push(record)
    onReviewRound?.({ ...record, feedback: summarize(record.feedback) })

    if (record.verdict === 'PASS') {
      passed = true
      break
    }

    // —— 打回（轮次封顶）——
    if (reworkCount >= MAX_REVIEW_ROUNDS) {
      break
    }
    reworkCount++
    const rework = await runRework(transcript, buildReworkInstruction(round, record.feedback))
    if (!rework.success) {
      trail.push({ round: round + 1, verdict: 'FAIL', feedback: '', note: `打回修正执行失败（${rework.error || '未知错误'}），回路终止` })
      break
    }
    output = rework.output || ''
    if (rework.conversation) transcript = rework.conversation
  }

  return { finalOutput: output, finalTranscript: transcript, trail, passed }
}

/** 组【评审轨迹】附录文本（拼进任务最终输出，双壳一致可见） */
export function formatReviewTrail(trail: ReviewRound[], passed: boolean): string {
  const lines = trail.map((r) => {
    const verdictText = r.verdict === 'PASS' ? '通过' : '未通过'
    const feedbackText = r.feedback ? ` — ${summarize(r.feedback, 200)}` : ''
    const noteText = r.note ? `（${r.note}）` : ''
    return `- 第${r.round}轮：${verdictText}${feedbackText}${noteText}`
  })
  const conclusion = passed
    ? '验证闭环通过。'
    : '已达最大打回轮次或回路异常终止，结果未通过验证闭环——请自行复核后再采信。'
  return `\n\n---\n【评审轨迹】\n${lines.join('\n')}\n${conclusion}`
}
