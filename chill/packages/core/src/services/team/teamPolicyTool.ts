/**
 * team_policy 工具(原子化灵活协作机制 · 一期迭代 1):授权快照的读/热更新
 *
 * 权限纪律(结构性,不经快照):
 * - read 全员可用(Lead 与成员;观测权);
 * - update 仅 Lead——按调用来源(__origin)判定,任何 agent 不可经快照授予自己 update(提权后门已堵);
 *   成员调 update → 响亮失败,指引经 send_message 请示 Lead。
 * - 本工具在元工具豁免清单内(任何快照不可收走);update 生效时清除未收回的 unfreeze(显式布线覆盖探测态)。
 * - 免审批:快照是团队协作内部状态,不触用户系统(预算越界追加的审批在迭代 3 编决策管线)。
 */

import type { ToolDefinition } from '../../types/models'
import { getTeamRuntimeService } from './TeamRuntimeService'
import { summarizeSnapshot, budgetExceedsDefaults } from './teamPolicy'
import type { AtomGrant, TeamBudget } from './teamRuntimeTypes'

export const TEAM_POLICY_TOOL_NAME = 'team_policy'

export const teamPolicyToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: TEAM_POLICY_TOOL_NAME,
    description:
      '团队授权快照(谁持有什么协作权限 + 预算)。' +
      'read(默认):读当前快照的人话摘要(授权表/新成员缺省授权/预算/最近变更),全员可用。' +
      'update:热更新授权或预算,立即生效,全程留痕——仅 Lead 可调;用户表达管理偏好("你们自己组织""每一步报我""加人先问我")时,Lead 应调本工具改写快照。' +
      '元工具豁免:本工具与 send_message 请示通道在任何快照下不可被收走。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update'], description: 'read(默认)=读快照;update=热更新(仅 Lead)' },
        grants: {
          type: 'object',
          description: 'update 可选:授权表(键=成员名或 "lead",值=授权数组;工具名如 "task",action 级如 "team_board:claim";"*" 仅限 lead)。省略=不动',
        },
        default_member_grants: {
          type: 'array',
          items: { type: 'string' },
          description: 'update 可选:新成员(拉新入队者)的缺省授权。省略=不动',
        },
        budget: {
          type: 'object',
          description: 'update 可选:预算 { max_members?, max_tokens?, max_depth? }(人数/token/嵌套深度上限;缺省=不限)。省略=不动',
        },
        note: { type: 'string', description: 'update 必填:变更原因/用户原文指令(留痕用)' },
      },
      required: [],
    },
  },
}

interface TeamToolOrigin {
  source?: string
  taskId?: string
}

export async function executeTeamPolicy(
  argsJson: string,
  origin?: TeamToolOrigin,
): Promise<{ success: boolean; data?: string; error?: string }> {
  let args: {
    action?: 'read' | 'update'
    grants?: Record<string, AtomGrant[]>
    default_member_grants?: AtomGrant[]
    budget?: { max_members?: number; max_tokens?: number; max_depth?: number }
    note?: string
  }
  try {
    args = JSON.parse(argsJson)
  } catch {
    return { success: false, error: '解析 team_policy 参数失败' }
  }
  const svc = getTeamRuntimeService()
  if (!svc) return { success: false, error: '团队运行时服务未装配' }
  const isRead = !args.action || args.action === 'read'
  if (!svc.getActiveTeam()) {
    // 探针去刺(迭代 2):read 对"不存在"应答"空"而非"错";update 保持报错(写操作语义一字不动)
    if (isRead) {
      return {
        success: true,
        data: '当前没有活动团队(无授权快照)。成队方式:use_team 激活固定团队,或 task/batch_task 带 as_teammate:true 组建临时团队。',
      }
    }
    return { success: false, error: '当前没有活动团队。成队方式:use_team 激活固定团队,或 task/batch_task 带 as_teammate:true 组建临时团队。' }
  }

  // 调用方身份只从 __origin 解析(与 team_board 同款;参数自报身份一律忽略)
  const isLead = origin?.source !== 'subagent'

  if (isRead) {
    return { success: true, data: summarizeSnapshot(svc.getSnapshot()) }
  }

  if (args.action === 'update') {
    if (!isLead) {
      return { success: false, error: '只有 Lead 能修改团队授权快照。你可以经 send_message 向 Lead 请示,说明需要的授权与理由。' }
    }
    if (!args.grants && !args.default_member_grants && !args.budget) {
      return { success: false, error: 'update 需要 grants / default_member_grants /budget 至少其一' }
    }
    if (!args.note) {
      return { success: false, error: 'update 缺少必填参数 note(变更原因/用户原文指令,留痕用)' }
    }
    const budget: TeamBudget | undefined = args.budget
      ? { maxMembers: args.budget.max_members, maxTokens: args.budget.max_tokens, maxDepth: args.budget.max_depth }
      : undefined
    // 越界闸(迭代 3):预算超系统默认上限时拒绝,引导用户侧调整——
    // 系统默认未设的字段不拦;熔断另有全局委派配额兜底(人数/累计,登记点强制)
    if (budget) {
      const violations = budgetExceedsDefaults(budget)
      if (violations.length > 0) {
        return {
          success: false,
          error: `预算超系统默认上限,已拒绝:${violations.join(';')}。` +
            '请向用户说明情况,由用户在设置页/CLI 调整系统默认上限后再试(Lead 不可自行突破系统默认)。',
        }
      }
    }
    try {
      const snapshot = await svc.updateSnapshot(
        { grants: args.grants, defaultMemberGrants: args.default_member_grants, budget },
        'lead',
        args.note,
      )
      return { success: true, data: `授权快照已更新并留痕。\n\n${summarizeSnapshot(snapshot)}` }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '快照更新失败' }
    }
  }

  return { success: false, error: `未知动作 "${args.action}"(可选: read/update)` }
}
