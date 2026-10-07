/**
 * `/tasks cancel <目标>` 的寻址解析（纯函数，可单测）：
 * 目标为序号（/tasks 清单里 running 行的 1 起编号）或 taskId/toolCallId 唯一前缀。
 * 序号以**调用时刻**的 running 列表为准（清单后任务可能已落地，序号会漂移——越界即报错）。
 */

export interface CancelTargetCandidate {
  toolCallId: string
  taskId: string
  subagentType: string
  description: string
}

export type ResolveCancelTargetResult =
  | { ok: true; toolCallId: string }
  | { ok: false; error: string }

/**
 * 解析取消目标。
 * @param running - 当前 running 任务列表（顺序即 /tasks 清单的编号顺序）
 * @param query - 用户输入的目标（序号或 id 前缀）
 */
export function resolveTaskCancelTarget(
  running: CancelTargetCandidate[],
  query: string
): ResolveCancelTargetResult {
  const q = query.trim()
  if (!q) {
    return { ok: false, error: '请指定要取消的任务：/tasks cancel <序号|taskId>（可用 /tasks 查看清单）' }
  }

  // 序号寻址（1 起的 running 行号；纯数字才按序号理解）
  if (/^\d+$/.test(q)) {
    const index = Number(q) - 1
    const hit = running[index]
    if (!hit) {
      return {
        ok: false,
        error: `序号 ${q} 无效：当前运行中的后台任务共 ${running.length} 个（可用 /tasks 查看实时清单——序号以最新清单为准）`,
      }
    }
    return { ok: true, toolCallId: hit.toolCallId }
  }

  // id 前缀寻址（taskId 或 toolCallId，唯一前缀）
  const matches = running.filter(
    (t) => t.taskId.startsWith(q) || t.toolCallId.startsWith(q)
  )
  if (matches.length === 0) {
    return {
      ok: false,
      error: `未找到运行中的任务（目标: ${q}）；可用 /tasks 查看实时清单（已落地的任务不可取消）`,
    }
  }
  if (matches.length > 1) {
    const candidates = matches
      .map((t, i) => `  ${i + 1}. ${t.subagentType}: ${t.description}（${t.taskId}）`)
      .join('\n')
    return {
      ok: false,
      error: `目标 "${q}" 匹配到 ${matches.length} 个运行中的任务，请用序号或更长的前缀：\n${candidates}`,
    }
  }
  return { ok: true, toolCallId: matches[0].toolCallId }
}
