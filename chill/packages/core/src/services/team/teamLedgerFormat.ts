/**
 * 账本展示单一格式化点(计量中间件 · 迭代 2)
 *
 * 三态判定只存在 core 一份(架构原则 3/4:壳零判定逻辑,只拿格式化好的字符串):
 *   无计量数据(spentTokens null/缺省) → `未知`;
 *   含估值(任一笔为字符估值,estimated 单向置位) → `~N(估值)`——保守表述,绝不假装精确;
 *   全实测 → `N`。
 * 调用点:teamBoardTool(team_status) 与 CLI /team 总览;将来 UI 壳展示账本也调这里。
 */

import type { TeamLedger } from './teamRuntimeTypes'

export function formatTokenSpend(ledger: TeamLedger | undefined): string {
  if (ledger?.spentTokens === null || ledger?.spentTokens === undefined) return '未知'
  return ledger.estimated ? `~${ledger.spentTokens}(估值)` : String(ledger.spentTokens)
}
