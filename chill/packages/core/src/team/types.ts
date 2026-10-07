/**
 * 固定团队（班底）DSL 类型定义
 *
 * 团队 = lead + 成员 + 分工/协作说明 的声明式资产（中央集权式）：
 * 成员固定、流程每次由 Lead（前台主模型或前台 agent）现场编排——
 * 与命名工作流（固定剧本）正交，与单 Agent 模板（单兵定义）正交。
 *
 * 真相源文件 = YAML（用户级 ~/.chill/teams/<name>.yaml，项目级 .agents/teams/<name>.yaml）。
 */

/** 团队成员（agent 引用单 Agent 模板的 subagent_type；引用不存在时 use_team 校验列明） */
export interface TeamMember {
  /** 成员引用的单 Agent 模板标识（kebab-case） */
  agent: string
  /** 分工短语（如"调研员""撰稿人"） */
  role?: string
  /** 协作备注（如"多轮检索、素材不足时上报"） */
  note?: string
  /** 计划批准门：该成员被委派时先出只读计划，Lead 用 approve_plan 批准后才带完整工具开工 */
  plan_first?: boolean
}

/** 团队授权策略段(可选;成队时生成授权快照的初始值——原子化协作机制一期) */
export interface TeamPolicySection {
  /** 新成员(拉新入队者)的缺省授权(原子粒度:工具名如 task,action 级如 team_board:claim) */
  default_member_grants?: string[]
  /** 覆盖性授权表(键=成员名或 'lead',值=授权数组) */
  grants?: Record<string, string[]>
  /** 团队预算(缺省=不限) */
  budget?: {
    max_members?: number
    max_tokens?: number
    max_depth?: number
  }
}

export interface TeamDefinition {
  /** 调用键（kebab-case；文件名与 use_team 的 name 参数） */
  name: string
  /** DSL 版本（当前 1） */
  version: number
  title?: string
  description?: string
  /** 驱动主模型自动匹配的一等字段 */
  when_to_use?: string
  members: TeamMember[]
  /** 协作说明（自由文本，指导 Lead 编排：顺序、打回、轮次上限、素材不足时的处置等） */
  orchestration?: string
  /** 授权策略(可选;成队快照的初始 grants/budget) */
  policy?: TeamPolicySection
  /** 加载来源（由加载器填充，不序列化） */
  sourcePath?: string
  /** 加载来源层级（由加载器填充，不序列化） */
  scope?: 'user' | 'project'
}

export const TEAM_DSL_VERSION = 1

export interface TeamParseResult {
  success: boolean
  definition?: TeamDefinition
  error?: string
  /** 警告信息（不阻断加载） */
  warnings?: string[]
}
