/**
 * 审批呈现与答案归一化（M4i 攻坚后收编：原散落在 cli.ts 审批 handler 的壳侧逻辑）
 *
 * 三个纯函数服务所有文本壳（CLI 控制台 / TUI / 将来的文本壳）：
 * - approvalQuestionText：完整问题文本（含归属行；控制台路径自行加盒子边框装饰）
 * - approvalOptions：TUI 交互菜单/单键应答的选项表（write→y/d/n，command→y/n，sessionGrantable→加 s）
 * - normalizeApprovalAnswer：原始回答文本 → ApprovalResolution（y/yes/1 批准、d 批准并加目录、
 *   s 批准并会话内放行，esc/其他一律拒绝——安全默认）
 *
 * Node-free / renderer 安全（纯字符串与判定，无 Node API），导出纪律与 approvals.ts 同级。
 */

import type { ApprovalOrigin, ApprovalRequestPayload, ApprovalResolution } from './approvals'
import type { AskUserOption } from '../interfaces/IUserInputProvider'

/** 归属行（谁发起的写/命令；mobile 起源附超时说明） */
function originText(origin?: ApprovalOrigin): string {
  if (origin?.source === 'subagent') return `后台任务 ${origin.subagentType ?? ''}`.trim()
  if (origin?.source === 'mobile') return '手机（mobile origin，5 分钟无人应答自动拒绝）'
  return '主对话'
}

/** 字符串 dirname（Node-free；正反斜杠通吃，无分隔符返空串） */
function dirnameOf(p: string): string {
  const m = /^(.*)[\\/][^\\/]+$/.exec(p)
  return m?.[1] ?? ''
}

/** 审批请求的人类可读问题全文（控制台盒子内文与 TUI notice 共用） */
export function approvalQuestionText(payload: ApprovalRequestPayload): string {
  const origin = originText(payload.origin)
  if (payload.kind === 'write') {
    const targetPath = payload.path ?? ''
    const targetDir = dirnameOf(targetPath)
    return `${origin}请求写入边界外文件\n路径: ${targetPath}\n\n批准写入? [y]批准一次 [d]批准并把目录 ${targetDir} 加入本次会话 [n]拒绝 [Esc]拒绝`
  }
  const isDesktopAction = payload.sessionGrantable === true
  const actionTitle = isDesktopAction ? '桌面操作' : 'PowerShell 命令'
  const command = payload.command ?? ''
  const detail = payload.detail
  return `${origin}请求执行${actionTitle}\n${isDesktopAction ? '动作' : '命令'}: ${command}${detail ? `\n说明: ${detail}` : ''}\n\n确认执行? [y]确认执行${isDesktopAction ? ' [s]本次会话内放行桌面操作' : ''} [n]拒绝执行 [Esc]拒绝`
}

/** 审批选项表（TUI 菜单/单键应答用；标签全为单字符，配合禁自由文本即单键应答态） */
export function approvalOptions(payload: ApprovalRequestPayload): AskUserOption[] {
  if (payload.kind === 'write') {
    const targetDir = dirnameOf(payload.path ?? '')
    return [
      { label: 'y', description: '批准一次' },
      { label: 'd', description: `批准并把目录加入本次会话: ${targetDir}` },
      { label: 'n', description: '拒绝' },
    ]
  }
  return [
    { label: 'y', description: '确认执行' },
    ...(payload.sessionGrantable === true ? [{ label: 's', description: '本次会话内放行桌面操作' }] : []),
    { label: 'n', description: '拒绝执行' },
  ]
}

/**
 * 原始回答文本 → 落定结论。语义与 cli.ts 旧 resolveWriteAnswer/resolveCommandAnswer 逐字对齐：
 * y/yes/1=批准一次；d=批准并把写目标目录加入会话（仅 write 且目录可解析）；
 * s=批准并会话内放行（回答面只在 sessionGrantable 时提供该选项；此处忠实透传，core 侧自行校验）；
 * 其余（含 esc）一律拒绝。
 */
export function normalizeApprovalAnswer(payload: ApprovalRequestPayload, rawText: string): ApprovalResolution {
  const a = rawText.trim().toLowerCase()
  if (payload.kind === 'write') {
    if (a === 'y' || a === 'yes' || a === '1') return { approved: true }
    const targetDir = dirnameOf(payload.path ?? '')
    if (a === 'd' && targetDir) return { approved: true, addDir: targetDir }
    return { approved: false, reason: '用户拒绝写入' }
  }
  const approved = a === 'y' || a === 'yes' || a === '1' || a === 's'
  return approved
    ? { approved: true, ...(a === 's' ? { allowSession: true } : {}) }
    : { approved: false, reason: '用户拒绝执行' }
}
