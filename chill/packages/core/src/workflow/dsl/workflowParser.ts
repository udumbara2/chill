/**
 * 工作流 YAML 解析器 + 校验器
 *
 * 校验全部产出可读中文错误(带文件路径),非法文件由加载层"带原因可见"而非静默跳过。
 * 校验规则:
 * - name 必填,kebab-case;version 必填且为支持的 DSL 版本
 * - nodes 至少 1 个;id 唯一且符合规范;每节点恰好 agent|tool 其一
 * - agent 节点:template 与内联字段(system_prompt/model/tools)互斥;内联时 system_prompt 必填
 * - tool 节点:name 必填
 * - edges:from/to 必须引用存在的节点 id;when 与 fallback 互斥;同一 from 至多一条 fallback 边
 * - inputs:name 唯一;type 仅 text|file
 */

import { load as loadYaml } from 'js-yaml'
import { ConditionType, OperatorType, ContentOperatorType, ExpressionType, LogicalOperatorType } from '../../types/edge'
import type { ConditionExpression } from '../../types/edge'
import type { WorkflowDefinition, WorkflowParseResult, WorkflowNodeDef, WorkflowEdgeDef, WorkflowInputDef } from './types'
import { WORKFLOW_DSL_VERSION, WORKFLOW_NAME_PATTERN, WORKFLOW_NODE_ID_PATTERN, isDeepAgentNode } from './types'
import { validateStringArrayField, warnIfZeroToolsWithMounts } from '../../orchestrator/parsers/stringArrayField'
import { TOOL_POLICY_ALL } from '../../orchestrator/toolPolicy'

export function parseWorkflowDefinition(content: string, filePath?: string): WorkflowParseResult {
  const at = filePath ? ` (${filePath})` : ''
  let raw: any
  try {
    raw = loadYaml(content)
  } catch (error: any) {
    return { success: false, error: `YAML 解析失败${at}: ${error.message}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: `工作流文件必须是 YAML 对象${at}` }
  }

  // name
  if (!raw.name || typeof raw.name !== 'string') {
    return { success: false, error: `工作流缺少必填字段 "name"${at}` }
  }
  if (!WORKFLOW_NAME_PATTERN.test(raw.name)) {
    return { success: false, error: `name "${raw.name}" 不符合命名规范,只能包含小写字母、数字和连字符${at}` }
  }

  // version
  if (raw.version === undefined || raw.version === null) {
    return { success: false, error: `工作流缺少必填字段 "version"(当前 DSL 版本为 ${WORKFLOW_DSL_VERSION})${at}` }
  }
  if (typeof raw.version !== 'number' || raw.version > WORKFLOW_DSL_VERSION || raw.version < 1) {
    return { success: false, error: `不支持的 DSL 版本 "${raw.version}",当前支持 1..${WORKFLOW_DSL_VERSION}${at}` }
  }

  // when_to_use / description / title
  for (const field of ['description', 'when_to_use', 'title'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      return { success: false, error: `字段 "${field}" 必须是字符串${at}` }
    }
  }

  // inputs
  const inputsResult = validateInputs(raw.inputs, at)
  if (inputsResult.error) return { success: false, error: inputsResult.error }

  // nodes
  const nodesResult = validateNodes(raw.nodes, at)
  if (nodesResult.error) return { success: false, error: nodesResult.error }
  const nodes = nodesResult.nodes!
  const warnings = nodesResult.warnings ?? []
  const infos = nodesResult.infos ?? []
  const nodeIds = new Set(nodes.map((n) => n.id))

  // edges
  const edgesResult = validateEdges(raw.edges, nodeIds, at)
  if (edgesResult.error) return { success: false, error: edgesResult.error }

  const definition: WorkflowDefinition = {
    name: raw.name,
    version: raw.version,
    title: raw.title,
    description: raw.description,
    when_to_use: raw.when_to_use,
    inputs: inputsResult.inputs!,
    nodes,
    edges: edgesResult.edges!,
  }
  return { success: true, definition, ...(warnings.length > 0 ? { warnings } : {}), ...(infos.length > 0 ? { infos } : {}) }
}

function validateInputs(raw: any, at: string): { inputs?: WorkflowInputDef[]; error?: string } {
  if (raw === undefined || raw === null) return { inputs: [] }
  if (!Array.isArray(raw)) return { error: `字段 "inputs" 必须是数组${at}` }
  const seen = new Set<string>()
  const inputs: WorkflowInputDef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !item.name || typeof item.name !== 'string') {
      return { error: `inputs 数组项缺少必填字段 "name"${at}` }
    }
    if (seen.has(item.name)) return { error: `inputs 中存在重名入参 "${item.name}"${at}` }
    seen.add(item.name)
    if (item.type !== undefined && item.type !== 'text' && item.type !== 'file') {
      return { error: `入参 "${item.name}" 的 type 必须是 text 或 file${at}` }
    }
    inputs.push({
      name: item.name,
      type: item.type,
      description: item.description,
      required: item.required === true,
    })
  }
  return { inputs }
}

function validateNodes(raw: any, at: string): { nodes?: WorkflowNodeDef[]; warnings?: string[]; infos?: string[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `工作流必须至少包含 1 个节点(nodes 数组为空或缺失)${at}` }
  }
  const seen = new Set<string>()
  const nodes: WorkflowNodeDef[] = []
  const warnings: string[] = []
  const infos: string[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: `nodes 数组项必须是对象${at}` }
    if (!item.id || typeof item.id !== 'string') return { error: `节点缺少必填字段 "id"${at}` }
    if (!WORKFLOW_NODE_ID_PATTERN.test(item.id)) {
      return { error: `节点 id "${item.id}" 不符合规范(字母开头,小写字母/数字/下划线/连字符)${at}` }
    }
    if (item.id === 'start') {
      return { error: `节点 id "start" 是保留字(投影到画布/引擎时用于入口节点),请换一个语义化 id${at}` }
    }
    if (seen.has(item.id)) return { error: `节点 id "${item.id}" 重复${at}` }
    seen.add(item.id)

    const hasAgent = item.agent !== undefined && item.agent !== null
    const hasTool = item.tool !== undefined && item.tool !== null
    if (hasAgent === hasTool) {
      return { error: `节点 "${item.id}" 必须恰好包含 agent 或 tool 其一${at}` }
    }

    const node: WorkflowNodeDef = { id: item.id }
    if (item.label !== undefined) {
      if (typeof item.label !== 'string') return { error: `节点 "${item.id}" 的 label 必须是字符串${at}` }
      node.label = item.label
    }
    if (item.position !== undefined) {
      const p = item.position
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') {
        return { error: `节点 "${item.id}" 的 position 必须是 { x: number, y: number }${at}` }
      }
      node.position = { x: p.x, y: p.y }
    }

    if (hasAgent) {
      const a = item.agent
      if (typeof a !== 'object') return { error: `节点 "${item.id}" 的 agent 必须是对象${at}` }
      const hasTemplate = typeof a.template === 'string' && a.template.trim() !== ''
      const INLINE_FIELDS = ['system_prompt', 'model', 'default_parameters', 'tools', 'disallowed_tools', 'readonly', 'memory', 'skills', 'knowledge', 'max_iterations'] as const
      const usedInline = INLINE_FIELDS.filter((f) => a[f] !== undefined)
      if (hasTemplate && usedInline.length > 0) {
        return { error: `节点 "${item.id}" 的 agent.template 与内联字段(${usedInline.join('/')})互斥${at}` }
      }
      if (!hasTemplate && usedInline.length === 0) {
        return { error: `节点 "${item.id}" 的 agent 必须包含 template 或内联 system_prompt${at}` }
      }
      if (!hasTemplate && (typeof a.system_prompt !== 'string' || !a.system_prompt.trim())) {
        return { error: `节点 "${item.id}" 的内联 agent 缺少 system_prompt${at}` }
      }
      if (hasTemplate && !WORKFLOW_NAME_PATTERN.test(a.template)) {
        return { error: `节点 "${item.id}" 引用的模板名 "${a.template}" 不符合命名规范${at}` }
      }
      // 字符串数组字段(规则单一事实源:stringArrayField.ts;空数组/关键字归一化+警告,不再硬报错)
      const normalizedArrays: Partial<Record<'tools' | 'disallowed_tools' | 'skills' | 'knowledge', string[] | undefined>> = {}
      for (const field of ['tools', 'disallowed_tools', 'skills', 'knowledge'] as const) {
        const result = validateStringArrayField(field, a[field], `节点 "${item.id}" 的 agent.${field}`)
        if (result.error) return { error: `${result.error}${at}` }
        if (result.warning) warnings.push(`${result.warning}${at}`)
        if (result.info) infos.push(`${result.info}${at}`)
        normalizedArrays[field] = result.value
      }
      // 浅节点(非深绑定)写 [all]:浅节点工具=画布勾选清单,"全部"随系统工具集变化,违反 WYSIWYG
      // 深绑定判定与 serializer 同一函数(内联节点无 template——互斥规则先行拒绝)
      const isDeep = isDeepAgentNode({
        id: item.id,
        agent: { ...a, template: undefined, tools: normalizedArrays.tools, skills: normalizedArrays.skills, knowledge: normalizedArrays.knowledge },
      })
      if (!isDeep && normalizedArrays.tools?.includes(TOOL_POLICY_ALL)) {
        return { error: `节点 "${item.id}" 的 agent.tools 浅节点不支持 [all](浅节点的工具就是画布上勾选的清单),请显式列举所需工具,或声明 memory/skills/knowledge 改为深绑定节点${at}` }
      }
      // hedged 警告:声明 memory/knowledge 但零工具(省略)→ 可能部分不生效
      const mountWarning = warnIfZeroToolsWithMounts(
        { tools: normalizedArrays.tools, memory: a.memory, knowledge: normalizedArrays.knowledge },
        `节点 "${item.id}" 的 agent`,
      )
      if (mountWarning) warnings.push(`${mountWarning}${at}`)
      if (a.readonly !== undefined && typeof a.readonly !== 'boolean') {
        return { error: `节点 "${item.id}" 的 agent.readonly 必须是布尔值${at}` }
      }
      if (a.memory !== undefined && !['user', 'project', 'local'].includes(a.memory)) {
        return { error: `节点 "${item.id}" 的 agent.memory 必须是 user/project/local 之一${at}` }
      }
      for (const field of ['max_iterations', 'max_turns'] as const) {
        const value = a[field]
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
          return { error: `节点 "${item.id}" 的 agent.${field} 必须是 ≥1 的整数${at}` }
        }
      }
      // model:模板形态为字符串;兼容旧对象形态 {name, provider, parameters} → 映射为字符串+default_parameters
      let model: string | undefined
      let defaultParameters: Record<string, any> | undefined = a.default_parameters
      if (a.model !== undefined) {
        if (typeof a.model === 'string') {
          model = a.model
        } else if (typeof a.model === 'object' && a.model !== null && typeof a.model.name === 'string' && a.model.name) {
          model = a.model.name
          if (a.model.parameters !== undefined) {
            if (typeof a.model.parameters !== 'object' || a.model.parameters === null) {
              return { error: `节点 "${item.id}" 的 agent.model.parameters 必须是对象${at}` }
            }
            defaultParameters = defaultParameters ?? a.model.parameters
          }
        } else {
          return { error: `节点 "${item.id}" 的 agent.model 必须是模型名字符串(旧对象形态仅接受含 name 的对象)${at}` }
        }
      }
      if (defaultParameters !== undefined && (typeof defaultParameters !== 'object' || defaultParameters === null || Array.isArray(defaultParameters))) {
        return { error: `节点 "${item.id}" 的 agent.default_parameters 必须是对象${at}` }
      }
      // prompt 任务说明模板:变量白名单 {{prev}} / {{input.<name>}} / {{nodes.<id>}}
      if (a.prompt !== undefined) {
        if (typeof a.prompt !== 'string') return { error: `节点 "${item.id}" 的 agent.prompt 必须是字符串${at}` }
        const promptError = validatePromptTemplate(a.prompt, item.id, at)
        if (promptError) return { error: promptError }
      }
      node.agent = {
        template: hasTemplate ? a.template : undefined,
        system_prompt: a.system_prompt,
        model,
        default_parameters: defaultParameters,
        tools: normalizedArrays.tools,
        disallowed_tools: normalizedArrays.disallowed_tools,
        readonly: a.readonly,
        memory: a.memory,
        skills: normalizedArrays.skills,
        knowledge: normalizedArrays.knowledge,
        max_iterations: a.max_iterations,
        max_turns: a.max_turns,
        prompt: a.prompt,
      }
    }

    if (hasTool) {
      const t = item.tool
      if (typeof t !== 'object' || typeof t.name !== 'string' || !t.name.trim()) {
        return { error: `节点 "${item.id}" 的 tool 必须包含 name${at}` }
      }
      if (t.params !== undefined && (typeof t.params !== 'object' || t.params === null || Array.isArray(t.params))) {
        return { error: `节点 "${item.id}" 的 tool.params 必须是对象${at}` }
      }
      node.tool = { name: t.name, params: t.params }
    }

    nodes.push(node)
  }
  return { nodes, warnings, infos }
}

function validateEdges(
  raw: any,
  nodeIds: Set<string>,
  at: string,
): { edges?: WorkflowEdgeDef[]; error?: string } {
  if (raw === undefined || raw === null) return { edges: [] }
  if (!Array.isArray(raw)) return { error: `字段 "edges" 必须是数组${at}` }
  const edges: WorkflowEdgeDef[] = []
  const fallbackBySource = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: `edges 数组项必须是对象${at}` }
    if (typeof item.from !== 'string' || typeof item.to !== 'string') {
      return { error: `边缺少必填字段 "from"/"to"${at}` }
    }
    if (!nodeIds.has(item.from)) return { error: `边的 from "${item.from}" 引用了不存在的节点${at}` }
    if (!nodeIds.has(item.to)) return { error: `边的 to "${item.to}" 引用了不存在的节点${at}` }
    const isFallback = item.fallback === true
    if (isFallback && item.when !== undefined) {
      return { error: `边 ${item.from} → ${item.to} 的 when 与 fallback 互斥${at}` }
    }
    if (isFallback) {
      if (fallbackBySource.has(item.from)) {
        return { error: `节点 "${item.from}" 存在多条 fallback 边${at}` }
      }
      fallbackBySource.add(item.from)
    }
    if (item.when !== undefined) {
      const condError = validateCondition(item.when, `边 ${item.from} → ${item.to}`, at)
      if (condError) return { error: condError }
    }
    if (item.priority !== undefined && typeof item.priority !== 'number') {
      return { error: `边 ${item.from} → ${item.to} 的 priority 必须是数字${at}` }
    }
    if (item.max_iterations !== undefined && (typeof item.max_iterations !== 'number' || item.max_iterations < 1)) {
      return { error: `边 ${item.from} → ${item.to} 的 max_iterations 必须是 ≥1 的数字${at}` }
    }
    edges.push({
      from: item.from,
      to: item.to,
      when: item.when,
      priority: item.priority,
      max_iterations: item.max_iterations,
      label: item.label,
      fallback: isFallback || undefined,
    })
  }
  return { edges }
}

/** 校验 BranchCondition(与引擎 types/edge.ts 四种条件对齐) */
function validateCondition(cond: any, where: string, at: string): string | null {
  if (!cond || typeof cond !== 'object') return `${where} 的 when 必须是对象${at}`
  switch (cond.type) {
    case ConditionType.TOOL_CALL:
      return null
    case ConditionType.CONTENT:
      if (!Object.values(ContentOperatorType).includes(cond.operator)) {
        return `${where} 的 content 条件 operator 无效${at}`
      }
      if (typeof cond.value !== 'string') return `${where} 的 content 条件缺少 value(字符串)${at}`
      return null
    case ConditionType.STATE_FIELD:
      if (typeof cond.field !== 'string' || !cond.field) return `${where} 的 state_field 条件缺少 field${at}`
      if (!Object.values(OperatorType).includes(cond.operator)) {
        return `${where} 的 state_field 条件 operator 无效${at}`
      }
      if (cond.value === undefined) return `${where} 的 state_field 条件缺少 value${at}`
      return null
    case ConditionType.EXPRESSION:
      return validateExpression(cond.expression, where, at)
    default:
      return `${where} 的 when.type 必须是 ${Object.values(ConditionType).join('/')}${at}`
  }
}

function validateExpression(expr: any, where: string, at: string): string | null {
  if (!expr || typeof expr !== 'object') return `${where} 的 expression 条件缺少 expression${at}`
  const e = expr as ConditionExpression
  switch (e.type) {
    case ExpressionType.BASIC: {
      const b = e as any
      if (typeof b.field !== 'string' || !b.field) return `${where} 的 basic 表达式缺少 field${at}`
      if (!Object.values(OperatorType).includes(b.operator)) return `${where} 的 basic 表达式 operator 无效${at}`
      if (b.value === undefined) return `${where} 的 basic 表达式缺少 value${at}`
      return null
    }
    case ExpressionType.LOGICAL: {
      const l = e as any
      if (!Object.values(LogicalOperatorType).includes(l.operator)) return `${where} 的 logical 表达式 operator 无效${at}`
      return validateExpression(l.left, where, at) ?? validateExpression(l.right, where, at)
    }
    case ExpressionType.GROUP:
      return validateExpression((e as any).expression, where, at)
    default:
      return `${where} 的表达式 type 必须是 basic/logical/group${at}`
  }
}

/** prompt 任务说明模板变量白名单校验:{{prev}} / {{input.<name>}} / {{nodes.<id>}} */
const PROMPT_VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

export function validatePromptTemplate(prompt: string, nodeId: string, at: string): string | null {
  for (const match of prompt.matchAll(PROMPT_VAR_PATTERN)) {
    const v = match[1]
    if (v === 'prev') continue
    if (/^input\.[a-zA-Z0-9_-]+$/.test(v)) continue
    if (/^nodes\.[a-z][a-z0-9_-]*$/.test(v)) continue
    return `节点 "${nodeId}" 的 prompt 含非法变量 {{${v}}}(允许 {{prev}} / {{input.<name>}} / {{nodes.<id>}})${at}`
  }
  return null
}
