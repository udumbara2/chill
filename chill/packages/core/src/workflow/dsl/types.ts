/**
 * 命名工作流 DSL 类型定义
 *
 * 真相源文件 = YAML(用户级 ~/.chill/workflows/<name>.yaml,项目级 .agents/workflows/<name>.yaml)。
 * 设计原则(见规划 plans/cyclops-ice-banshee.md):
 * - 语义与几何分离:position 可选,仅作画布布局提示,不影响执行语义
 * - 运行时状态不进文件:本类型不含 executionResult/onExecute 等运行时字段
 * - 不可嵌套:节点只能引用单 Agent 模板与工具,不能引用其他工作流
 * - start 不是节点:入参契约由 inputs 表达
 */

import type { BranchCondition } from '../../types/edge'

/** 工作流入参契约项 */
export interface WorkflowInputDef {
  name: string
  /** text=文本入参;file=文件路径入参(对齐旧 start 节点 textInput/fileInputs) */
  type?: 'text' | 'file'
  description?: string
  required?: boolean
}

/**
 * agent 节点配置:节点即模板——字段 = 模板 frontmatter 全集(身份字段除外)+ 执行参数。
 * template 引用(具名,活引用)与内联字段(匿名副本)互斥。
 */
export interface WorkflowAgentNodeConfig {
  /** 引用单 Agent 模板 subagent_type;与全部内联字段互斥 */
  template?: string
  system_prompt?: string
  /** 模型名(模板形态,字符串;旧对象形态 {name,provider,parameters} 解析期兼容映射) */
  model?: string
  /** 模型参数(对齐模板 default_parameters;画布旧 parameters 经序列化映射) */
  default_parameters?: Record<string, any>
  /** 工具默认名单(省略=零工具;[all]=全量;空数组由解析层归一化为省略并警告) */
  tools?: string[]
  /** 工具黑名单(在默认名单/全量结果上再扣除;空数组由解析层归一化为省略并警告) */
  disallowed_tools?: string[]
  /** 只读声明(权限字段,两层执行都生效:构建工具清单时过滤) */
  readonly?: boolean
  /** per-agent 记忆作用域(驮具字段;声明即需 Worker 独立上下文执行) */
  memory?: 'user' | 'project' | 'local'
  /** 技能白名单(驮具字段) */
  skills?: string[]
  /** 知识库绑定(驮具字段) */
  knowledge?: string[]
  /** 循环上限(对齐模板 max_iterations;Worker 层缺省取值来源) */
  max_iterations?: number
  /** 工具循环最大迭代次数(两层通用的防失控上限,不是固定执行 n 次) */
  max_turns?: number
  /** 节点任务说明模板:{{prev}} / {{input.<name>}} / {{nodes.<id>}};缺省 = {{prev}} */
  prompt?: string
}

/** tool 节点配置:确定性执行预配置工具;name 为 run_code 时映射引擎 code 节点 */
export interface WorkflowToolNodeConfig {
  name: string
  params?: Record<string, any>
}

export interface WorkflowNodeDef {
  /** 语义 id(kebab-case/下划线),边引用它;禁止时间戳/uuid 由校验器警告级处理 */
  id: string
  label?: string
  agent?: WorkflowAgentNodeConfig
  tool?: WorkflowToolNodeConfig
  /** 画布布局提示,可选 */
  position?: { x: number; y: number }
}

export interface WorkflowEdgeDef {
  from: string
  to: string
  /** 条件分支(复用引擎 BranchCondition 类型,表达力与画布条件边一致) */
  when?: BranchCondition
  /** 多分支时的评估优先级,小者先评估 */
  priority?: number
  /** 循环分支的最大迭代次数(对齐 BranchConfig.maxIterations) */
  max_iterations?: number
  label?: string
  /** true 表示该边是源节点的兜底分支(fallback);此时不得带 when */
  fallback?: boolean
}

export interface WorkflowDefinition {
  name: string
  /** DSL 版本,当前为 1;为将来演进留门 */
  version: number
  /** 展示名(可选,任意语言;name 是机器调用键,title 给人看) */
  title?: string
  description?: string
  /** 驱动主模型自动匹配的一等字段 */
  when_to_use?: string
  inputs: WorkflowInputDef[]
  nodes: WorkflowNodeDef[]
  edges: WorkflowEdgeDef[]
  /** 加载来源(由加载器填充,不序列化) */
  sourcePath?: string
  /** 加载来源层级(由加载器填充,不序列化) */
  scope?: 'user' | 'project'
}

export const WORKFLOW_DSL_VERSION = 1

/** name 调用键命名规范:kebab-case */
export const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 节点 id 规范:小写字母/数字/下划线/连字符,字母开头 */
export const WORKFLOW_NODE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/

export interface WorkflowParseResult {
  success: boolean
  definition?: WorkflowDefinition
  error?: string
  /** 警告信息（行为相关：有损/可能与预期不同，UI 可见） */
  warnings?: string[]
  /** 卫生通知（无损归一化，仅控制台日志） */
  infos?: string[]
}

/**
 * 深绑定判定：template 引用，或声明驮具字段（memory/skills/knowledge）
 * → 'agent' 节点（Worker 独立上下文）。dsl 层共用（serializer 投影与 parser 校验同一判定）
 */
export function isDeepAgentNode(node: WorkflowNodeDef): boolean {
  const a = node.agent
  if (!a) return false
  return !!(a.template || a.memory || (a.skills && a.skills.length > 0) || (a.knowledge && a.knowledge.length > 0))
}
