/**
 * 工作流 DSL 序列化器:三个投影方向
 *
 * 1. definitionToYaml / parseWorkflowDefinition:Definition ⇄ YAML 文本(真相源文件)
 * 2. definitionToCanvas / canvasToDefinition:Definition ⇄ 画布图(legacy 四类型:start/model/tool/code)
 * 3. definitionToEngineConfig:Definition → 引擎可直接 compile 的 {nodes, edges} + 输入 Maps
 *
 * 硬规则落实:
 * - 运行时状态(executionResult/onExecute/selected)在 canvasToDefinition 中剥掉,永不进文件
 * - position 是可选布局提示;round-trip 以 Definition 为准
 * - start 不是 DSL 节点:投影到画布/引擎时按"零入度节点"自动补 start 节点与入边,
 *   反向投影时丢弃 start 节点及其出边
 */

import { dump as dumpYaml } from 'js-yaml'
import type { Edge, BranchConfig, ConditionalEdge } from '../../types/edge'
import { EdgeType } from '../../types/edge'
import type { WorkflowNode, ModelNodeData, ToolNodeData, CodeExecutorNodeData, StartNodeData } from '../../types/workflow'
import type { WorkflowNodeConfig } from '../shared'
import type { DefaultEdgeConfig } from '../workflowGraphBuilder'
import type { SubagentTemplate } from '../../orchestrator/types'
import { isToolAllowedByPolicy, resolveAgentToolPolicy } from '../../orchestrator/toolPolicy'
import { PLAN_MODE_BLOCKED_TOOLS, TOOL_POLICY_ALL, TOOL_POLICY_NONE } from '../../orchestrator/toolPolicy'
import type { ToolDefinition } from '../../services/models/types'
import type { WorkflowDefinition, WorkflowNodeDef, WorkflowEdgeDef } from './types'
import { isDeepAgentNode } from './types'

/** 内联字段 ⇒ 工具名过滤(权限字段两层生效:in-process 层在构建清单时过滤) */
function filterToolNamesByPolicy(
  names: string[],
  fields: { disallowed_tools?: string[]; readonly?: boolean },
): string[] {
  const disallowed = new Set(fields.disallowed_tools ?? [])
  return names.filter(
    (name) =>
      !disallowed.has(name) && !(fields.readonly === true && PLAN_MODE_BLOCKED_TOOLS.includes(name)),
  )
}

/** 画布/引擎投影时合成的 start 节点 id(保留字,DSL 节点 id 校验不允许同名冲突由 from/to 校验兜底) */
export const START_NODE_ID = 'start'

/** ToolDefinition(OpenAI 形状 function.name)与名字桩两种形态的名字提取 */
function toolNameOf(t: any): string | undefined {
  const name = t?.function?.name ?? t?.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/** 名字 → ToolDefinition 桩(画布展示与反向序列化只依赖 function.name) */
function toolStub(name: string): ToolDefinition {
  return {
    type: 'function',
    function: { name, description: '', parameters: { type: 'object', properties: {}, required: [] } },
  } as ToolDefinition
}

// ==================== Definition → YAML 文本 ====================

export function definitionToYaml(def: WorkflowDefinition): string {
  const { sourcePath: _sp, scope: _sc, ...serializable } = def
  return dumpYaml(serializable, { noRefs: true, lineWidth: -1, sortKeys: false })
}

// ==================== Definition → 图(画布/引擎共用) ====================

/**
 * 计算入口节点(start 的直连后继):
 * 零入度节点为入口;若因条件回边导致全部节点都有入边(如评审打回环),
 * 以 DSL 中第一个声明的节点为入口(确定性兜底,写文件时把起始节点放最前即可控)。
 * 注意:仅作起点的条件分支目标(如 lint)有入边,不会被误判为入口。
 */
function entryNodeIds(def: WorkflowDefinition): string[] {
  const hasIncoming = new Set(def.edges.map((e) => e.to))
  const entries = def.nodes.map((n) => n.id).filter((id) => !hasIncoming.has(id))
  if (entries.length === 0 && def.nodes.length > 0) {
    return [def.nodes[0].id]
  }
  return entries
}

interface BuiltEdges {
  defaultEdges: DefaultEdgeConfig[]
  conditionalEdges: ConditionalEdge[]
}

/** DSL 边 → 引擎/画布边:按 from 分组,条件/兜底边合并为一条 ConditionalEdge(branches 格式) */
function buildGraphEdges(def: WorkflowDefinition): BuiltEdges {
  const defaultEdges: DefaultEdgeConfig[] = []
  const conditionalEdges: ConditionalEdge[] = []

  const condGroups = new Map<string, WorkflowEdgeDef[]>()
  for (const e of def.edges) {
    if (e.when || e.fallback) {
      const group = condGroups.get(e.from) ?? []
      group.push(e)
      condGroups.set(e.from, group)
    } else {
      defaultEdges.push({ source: e.from, target: e.to, type: EdgeType.DEFAULT })
    }
  }

  for (const [from, group] of condGroups) {
    const fallbackEdge = group.find((e) => e.fallback)
    const branches: BranchConfig[] = group
      .filter((e) => e.when)
      .map((e, i) => ({
        id: `branch_${from}_${e.to}_${i}`,
        label: e.label ?? `${from} → ${e.to}`,
        condition: e.when!,
        targetNodeId: e.to,
        priority: e.priority ?? i,
        maxIterations: e.max_iterations,
      }))
    conditionalEdges.push({
      id: `cond_${from}`,
      source: from,
      target: branches[0]?.targetNodeId ?? fallbackEdge?.to ?? '',
      type: EdgeType.CONDITIONAL,
      data: {
        branches,
        fallbackNodeId: fallbackEdge?.to ?? '__end__',
      },
    })
  }

  return { defaultEdges, conditionalEdges }
}

/** DSL 节点类型 → 引擎/画布 legacy 类型 */
function nodeTypeOf(node: WorkflowNodeDef): 'model' | 'tool' | 'code' {
  if (node.agent) return 'model'
  return node.tool!.name === 'run_code' ? 'code' : 'tool'
}

/** Definition → 引擎可直接 compileWorkflow 的 {nodes, edges} */
export function definitionToEngineConfig(def: WorkflowDefinition): {
  nodes: WorkflowNodeConfig[]
  edges: (DefaultEdgeConfig | ConditionalEdge)[]
} {
  const nodes: WorkflowNodeConfig[] = [{ id: START_NODE_ID, type: 'start' }]
  for (const n of def.nodes) {
    nodes.push({
      id: n.id,
      type: isDeepAgentNode(n) ? 'agent' : nodeTypeOf(n),
      data: n.agent ?? undefined,
    })
  }
  const { defaultEdges, conditionalEdges } = buildGraphEdges(def)
  for (const entry of entryNodeIds(def)) {
    defaultEdges.unshift({ source: START_NODE_ID, target: entry, type: EdgeType.DEFAULT })
  }
  return { nodes, edges: [...defaultEdges, ...conditionalEdges] }
}

// ==================== Definition → 引擎输入 Maps ====================

export interface EngineConfigResolver {
  /** 按 subagent_type 解析单 Agent 模板;不存在返回 undefined(调用方报可读错误) */
  resolveTemplate(templateType: string): SubagentTemplate | undefined
  /** 工具名数组 → ToolDefinition 数组(未知工具名由调用方决定忽略或报错) */
  resolveTools(toolNames: string[]): ToolDefinition[]
}

/**
 * Definition → 引擎输入 Maps(systemPrompts/modelConfigs/selectedToolsMap/toolParamsMap/codeExecutorConfigs)
 * 模板引用节点在此展开(系统提示词/模型/工具取模板定义;模板 model 为字符串时写入 modelConfigs.model)
 */
export function definitionToEngineInput(
  def: WorkflowDefinition,
  resolver: EngineConfigResolver,
): {
  systemPrompts: Record<string, string>
  modelConfigs: Record<string, Record<string, any>>
  selectedToolsMap: Record<string, ToolDefinition[]>
  toolParamsMap: Record<string, Record<string, any>>
  codeExecutorConfigs: Record<string, { interactiveMode?: boolean; language?: string }>
  errors: string[]
} {
  const systemPrompts: Record<string, string> = {}
  const modelConfigs: Record<string, Record<string, any>> = {}
  const selectedToolsMap: Record<string, ToolDefinition[]> = {}
  const toolParamsMap: Record<string, Record<string, any>> = {}
  const codeExecutorConfigs: Record<string, { interactiveMode?: boolean; language?: string }> = {}
  const errors: string[] = []

  for (const node of def.nodes) {
    if (node.agent) {
      const a = node.agent
      if (a.template) {
        const template = resolver.resolveTemplate(a.template)
        if (!template) {
          errors.push(`节点 "${node.id}" 引用的单 Agent 模板 "${a.template}" 不存在`)
          continue
        }
        systemPrompts[node.id] = template.system_prompt ?? ''
        if (typeof template.model === 'string' && template.model) {
          modelConfigs[node.id] = { model: template.model }
        }
        if (template.tools && template.tools.length > 0) {
          // 关键字(all/none)不是真实工具名,不进 resolveTools(深绑定节点工具由 Worker 侧模板全字段生效)
          const names = template.tools.filter((n) => n !== TOOL_POLICY_ALL && n !== TOOL_POLICY_NONE)
          if (names.length > 0) {
            // 权限字段过滤(toolPolicy 同规则:readonly 扣修改性工具、disallowed 扣黑名单)
            const policy = resolveAgentToolPolicy(template)
            const allowed = names.filter((name) => isToolAllowedByPolicy(policy, name))
            if (allowed.length > 0) {
              selectedToolsMap[node.id] = resolver.resolveTools(allowed)
            }
          }
        }
      } else {
        systemPrompts[node.id] = a.system_prompt ?? ''
        if (a.model) {
          modelConfigs[node.id] = { model: a.model, ...(a.default_parameters ?? {}) }
        }
        if (a.tools && a.tools.length > 0) {
          // 关键字过滤(all/none 非真实工具名;深绑定内联节点的 [all] 合法,由 Worker 侧生效)
          const names = a.tools.filter((n) => n !== TOOL_POLICY_ALL && n !== TOOL_POLICY_NONE)
          const allowed = filterToolNamesByPolicy(names, a)
          if (allowed.length > 0) {
            selectedToolsMap[node.id] = resolver.resolveTools(allowed)
          }
        }
      }
      continue
    }

    const t = node.tool!
    if (t.name === 'run_code') {
      codeExecutorConfigs[node.id] = { interactiveMode: t.params?.interactive === true, language: t.params?.language }
    } else {
      const tools = resolver.resolveTools([t.name])
      if (tools.length === 0) {
        errors.push(`节点 "${node.id}" 引用的工具 "${t.name}" 不存在`)
        continue
      }
      selectedToolsMap[node.id] = tools
      // toolParamsMap 的键结构:节点 id → 工具名 → 参数(toolNodeExecutor 按 toolName 取参)
      toolParamsMap[node.id] = { [t.name]: t.params ?? {} }
    }
  }

  return { systemPrompts, modelConfigs, selectedToolsMap, toolParamsMap, codeExecutorConfigs, errors }
}

// ==================== Definition ⇄ 画布图 ====================

/** Definition → 画布节点/边(position 缺失时由 UI 自动布局;此处 position 置 0 由 UI 检测覆盖) */
export function definitionToCanvas(def: WorkflowDefinition): { nodes: WorkflowNode[]; edges: Edge[] } {
  const nodes: WorkflowNode[] = []
  const startData: StartNodeData = { label: '开始' }
  nodes.push({ id: START_NODE_ID, type: 'start', position: { x: 0, y: 0 }, data: startData })

  for (const n of def.nodes) {
    const position = n.position ?? { x: 0, y: 0 }
    const type = nodeTypeOf(n)
    if (type === 'model') {
      const a = n.agent!
      const data: ModelNodeData = {
        label: n.label ?? n.id,
        systemPrompt: a.system_prompt,
        agentTemplate: a.template,
        // 模板形态 model(字符串)→ 画布 selectedModel;default_parameters → 画布 parameters
        selectedModel: a.model ? { id: a.model, name: a.model, provider: '' } : null,
        parameters: a.default_parameters,
        selectedTools: (a.tools ?? []).map(toolStub),
        disallowedTools: a.disallowed_tools,
        readonly: a.readonly,
        memory: a.memory,
        skills: a.skills,
        knowledge: a.knowledge,
        maxTurns: a.max_turns ?? a.max_iterations, // 循环上限单一出口(旧 YAML 的 max_iterations 兼容读)
        prompt: a.prompt,
      }
      nodes.push({ id: n.id, type: 'model', position, data })
    } else if (type === 'code') {
      const data: CodeExecutorNodeData = {
        label: n.label ?? n.id,
        interactiveMode: n.tool!.params?.interactive === true,
        defaultLanguage: n.tool!.params?.language,
      }
      nodes.push({ id: n.id, type: 'code', position, data })
    } else {
      const data: ToolNodeData = {
        label: n.label ?? n.id,
        selectedTools: [toolStub(n.tool!.name)],
        // 画布 toolParams 按工具名嵌套(ToolNode.vue 以 tool.function.name 为键)
        toolParams: { [n.tool!.name]: n.tool!.params ?? {} },
      }
      nodes.push({ id: n.id, type: 'tool', position, data })
    }
  }

  const { defaultEdges, conditionalEdges } = buildGraphEdges(def)
  const edges: Edge[] = [
    ...defaultEdges.map((e) => ({
      id: `e_${e.source}_${e.target}`,
      source: e.source,
      target: e.target,
      type: 'default' as const,
    })),
    ...conditionalEdges,
  ]
  // start → 零入度节点
  for (const entry of entryNodeIds(def)) {
    edges.unshift({ id: `e_${START_NODE_ID}_${entry}`, source: START_NODE_ID, target: entry, type: 'default' })
  }
  return { nodes, edges }
}

/**
 * 画布图 → Definition(剥运行时状态;start 节点及其出边不进入 DSL)
 * meta 提供 name/version/description/when_to_use/inputs(资产元信息由编辑器头部表单维护)
 */
export function canvasToDefinition(
  nodes: WorkflowNode[],
  edges: Edge[],
  meta: Pick<WorkflowDefinition, 'name' | 'title' | 'version' | 'description' | 'when_to_use' | 'inputs'>,
): WorkflowDefinition {
  // start 节点按 type 识别(真实存量里 start 的 id 可能是 "1" 等任意值,不能按 id 判断)
  const startNodeIds = new Set(nodes.filter((n) => n.type === 'start').map((n) => n.id))
  const defNodes: WorkflowNodeDef[] = []
  for (const n of nodes) {
    if (startNodeIds.has(n.id)) continue
    const position = n.position ? { x: n.position.x, y: n.position.y } : undefined
    if (n.type === 'model') {
      const data = n.data as ModelNodeData
      const toolNames = (data.selectedTools ?? [])
        .map(toolNameOf)
        .filter((name): name is string => !!name)
      const node: WorkflowNodeDef = { id: n.id, label: data.label !== n.id ? data.label : undefined, position }
      node.agent = data.agentTemplate
        ? { template: data.agentTemplate }
        : {
            system_prompt: data.systemPrompt,
            // 画布 selectedModel/parameters → 模板形态 model(字符串)+ default_parameters
            model: data.selectedModel?.name,
            default_parameters: data.parameters,
            tools: toolNames.filter((name) => !name.startsWith('@')),
            disallowed_tools: data.disallowedTools,
            readonly: data.readonly,
            memory: data.memory as 'user' | 'project' | 'local' | undefined,
            skills: data.skills,
            knowledge: data.knowledge,
            // 循环上限单一出口:只写 max_turns(兼容读旧画布数据的 maxIterations)
            max_turns: data.maxTurns ?? data.maxIterations,
            prompt: data.prompt,
          }
      // 空数组不落盘(四字段对称;"不写=省略"与解析器归一化语义一致)
      for (const f of ['tools', 'disallowed_tools', 'skills', 'knowledge'] as const) {
        const v = node.agent[f]
        if (Array.isArray(v) && v.length === 0) delete node.agent[f]
      }
      defNodes.push(node)
    } else if (n.type === 'code') {
      const data = n.data as CodeExecutorNodeData
      defNodes.push({
        id: n.id,
        label: data.label !== n.id ? data.label : undefined,
        position,
        tool: {
          name: 'run_code',
          params: {
            ...(data.defaultLanguage ? { language: data.defaultLanguage } : {}),
            ...(data.interactiveMode ? { interactive: true } : {}),
          },
        },
      })
    } else {
      const data = n.data as ToolNodeData
      const toolName = (data.selectedTools ?? []).map(toolNameOf).find((name): name is string => !!name)
      // 画布 toolParams 按工具名嵌套,DSL 恢复为平铺 params
      const nestedParams = data.toolParams ?? {}
      defNodes.push({
        id: n.id,
        label: data.label !== n.id ? data.label : undefined,
        position,
        tool: { name: toolName ?? '', params: (toolName && nestedParams[toolName]) || {} },
      })
    }
  }

  const defEdges: WorkflowEdgeDef[] = []
  for (const e of edges) {
    // start 出边不进 DSL(start 是 inputs 契约,不是节点)
    if (startNodeIds.has(e.source)) continue
    if (e.type === EdgeType.CONDITIONAL && e.data) {
      const data = e.data as ConditionalEdge['data']
      for (const branch of data.branches ?? []) {
        defEdges.push({
          from: e.source,
          to: branch.targetNodeId,
          when: branch.condition,
          priority: branch.priority,
          max_iterations: branch.maxIterations,
          label: branch.label,
        })
      }
      if (data.fallbackNodeId && data.fallbackNodeId !== '__end__') {
        defEdges.push({ from: e.source, to: data.fallbackNodeId, fallback: true })
      }
      continue
    }
    defEdges.push({ from: e.source, to: e.target })
  }

  return {
    name: meta.name,
    version: meta.version,
    title: meta.title,
    description: meta.description,
    when_to_use: meta.when_to_use,
    inputs: meta.inputs,
    nodes: defNodes,
    edges: defEdges,
  }
}
