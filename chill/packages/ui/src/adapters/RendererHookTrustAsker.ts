import type { HookTrustApprovalRequest } from '@assistant-ai/core'
import { approvalPendingEnter, approvalPendingLeave } from '@assistant-ai/core'
import { usePlanModeStore } from '../stores/planModeStore'
import { useHookMessageStore } from '../stores/hookMessageStore'

/**
 * 项目级 hook 信任询问（渲染进程侧 HookRunnerDeps.trustApprover）：
 * 复用 PlanAskDialog 提问通道（与 goal 熔断请示同一交互模式——
 * planModeStore.openAsk 两选项弹窗），文案与 CLI 的 askHookTrust 对齐：
 * 展示首见/已变更 + sourcePath + handlerId + 命令全文 + 风险提示，
 * [信任并执行]/[不信任（跳过）] 两选；非"信任"一律按不信任（安全默认）。
 * 信任记录由 core 落盘（loader.markTrusted → kv hooks.trusted，经 IPC 与 CLI 同一 state.json）。
 */
export async function askHookTrust(req: HookTrustApprovalRequest): Promise<boolean> {
  // 审批挂起聚合（自审批防护：信任询问期间对 chill 窗口的点击/键入被原生层拦截）
  approvalPendingEnter()
  try {
  const reasonText = req.reason === 'changed' ? '已变更 hook（命令内容与信任记录不符）' : '新 hook（首次出现）'
  const question =
    `⚠ 项目 hooks.json 中出现${reasonText}\n` +
    `来源: ${req.sourcePath}\n` +
    `hook: ${req.handlerId}\n` +
    `事件: ${req.event}\n` +
    `命令: ${req.command}\n\n` +
    `风险: hook 会以你的凭据执行任意命令，仅在你信任该项目（仓库/作者）时批准。`
  const answer = await usePlanModeStore().openAsk(question, [
    { label: 'y', description: '信任并执行（记录哈希，之后不再询问；命令变更时会重新询问）' },
    { label: 'n', description: '不信任（跳过此 hook）' },
  ], false)
  const trusted = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  // 裁决结果经 hook 消息卡片告知（对照 CLI 的 notify 输出行）
  useHookMessageStore().push(req.event, [
    trusted
      ? `已信任项目 hook "${req.handlerId}"（信任记录已保存，之后不再询问；命令变更时会重新询问）`
      : `未信任项目 hook "${req.handlerId}"，已跳过不予执行`,
  ])
  return trusted
  } finally {
    approvalPendingLeave()
  }
}
