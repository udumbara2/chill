export interface Edge<Data = any> {
  id: string
  source: string
  target: string
  type?: string
  data?: Data
  sourceHandle?: string | null
  targetHandle?: string | null
}

export enum EdgeType {
  DEFAULT = 'default',
  CONDITIONAL = 'conditional'
}

export enum OperatorType {
  EQ = 'eq',
  NE = 'ne',
  GT = 'gt',
  LT = 'lt',
  GTE = 'gte',
  LTE = 'lte',
  CONTAINS = 'contains',
  NOT_CONTAINS = 'not_contains'
}

export enum LogicalOperatorType {
  AND = 'and',
  OR = 'or',
  NOT = 'not'
}

export enum ExpressionType {
  BASIC = 'basic',
  LOGICAL = 'logical',
  GROUP = 'group'
}

export interface BasicConditionExpression {
  type: ExpressionType.BASIC
  field: string
  operator: OperatorType
  value: string | number | boolean
}

export interface LogicalOperatorExpression {
  type: ExpressionType.LOGICAL
  operator: LogicalOperatorType
  left: ConditionExpression
  right: ConditionExpression
}

export interface GroupExpression {
  type: ExpressionType.GROUP
  expression: ConditionExpression
}

export type ConditionExpression = BasicConditionExpression | LogicalOperatorExpression | GroupExpression

export type ContentOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'regex'

export enum ContentOperatorType {
  EQUALS = 'equals',
  NOT_EQUALS = 'not_equals',
  CONTAINS = 'contains',
  NOT_CONTAINS = 'not_contains',
  STARTS_WITH = 'starts_with',
  ENDS_WITH = 'ends_with',
  REGEX = 'regex'
}

export enum ConditionType {
  TOOL_CALL = 'tool_call',
  CONTENT = 'content',
  STATE_FIELD = 'state_field',
  EXPRESSION = 'expression'
}

export interface RouterCondition {
  type: ConditionType
  fallback?: string
}

export interface ToolCallCondition extends RouterCondition {
  type: ConditionType.TOOL_CALL
  messages_key?: string
}

export interface StateFieldCondition extends RouterCondition {
  type: ConditionType.STATE_FIELD
  field: string
  operator: OperatorType
  value: string | number | boolean
  branches?: Record<string, string>
}

export interface ExpressionCondition extends RouterCondition {
  type: ConditionType.EXPRESSION
  expression: ConditionExpression
}

export interface ContentCondition extends RouterCondition {
  type: ConditionType.CONTENT
  operator: ContentOperator
  value: string
}

export type BranchCondition = ToolCallCondition | ContentCondition | StateFieldCondition | ExpressionCondition

export interface BranchConfig {
  id: string
  label: string
  condition: BranchCondition
  targetNodeId: string
  priority: number
  maxIterations?: number
}

export interface ConditionalEdgeData {
  branches?: BranchConfig[]
  condition?: BranchCondition
  fallbackNodeId?: string
  label?: string
  branchId?: string
  isLoopHighlighted?: boolean
  loopBranchId?: string
  currentIteration?: number
  maxIterations?: number
}

export type ConditionalEdge = Edge<ConditionalEdgeData> & {
  type: EdgeType.CONDITIONAL
  data: ConditionalEdgeData
  animated?: boolean
}

