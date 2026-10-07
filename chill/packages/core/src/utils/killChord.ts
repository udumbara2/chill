/**
 * 「Ctrl+K 双击停止全部后台任务」的确认窗状态判定（纯函数，可单测）。
 *
 * 语义（对齐 Claude Code Ctrl+X Ctrl+K 双击确认全停；键位本土化——chill 的 Ctrl+X 已占用）：
 * - 首次触发 → arm（给出 3s 确认窗，壳侧提示"再按一次确认停止 N 个"）；
 * - 确认窗内第二次触发 → confirm（壳侧执行 cancelAllRunningTasks）；
 * - 确认窗过期后触发 → 视为新的首次（重新 arm）。
 *
 * 调用方纪律：N=0（无运行中任务）时不要调用本函数——只提示，不 arm
 * （防"确认取消 0 个"的语义怪态）。状态持有方是壳（confirmUntil 一个数字），
 * 过期用惰性判定（下次触发时按过期处理），无需定时器。
 */

/** 确认窗时长（ms）：上膛后 3 秒内第二次触发才执行 */
export const KILL_CHORD_CONFIRM_MS = 3000

export type KillChordAction = 'arm' | 'confirm'

export interface KillChordResult {
  action: KillChordAction
  /** 新的确认窗截止时刻（confirm 时为 null——已执行/已消费，窗作废） */
  confirmUntil: number | null
}

/**
 * 推进双击确认状态机。
 * @param confirmUntil - 当前确认窗截止时刻（null = 未上膛）
 * @param nowMs - 当前时刻（ms）
 */
export function nextKillChordState(confirmUntil: number | null, nowMs: number): KillChordResult {
  if (confirmUntil !== null && nowMs <= confirmUntil) {
    return { action: 'confirm', confirmUntil: null }
  }
  return { action: 'arm', confirmUntil: nowMs + KILL_CHORD_CONFIRM_MS }
}
