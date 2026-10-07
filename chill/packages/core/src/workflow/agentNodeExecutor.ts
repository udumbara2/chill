/**
 * 深绑定 agent 节点执行器(Worker 独立上下文循环)
 *
 * template 引用节点与声明驮具字段的内联节点经此执行:
 * 渲染任务说明(prompt 优先级链)→ 具名模板/匿名临时模板 → 经 LocalSubagentAdapter 直达
 * 委派驮具(Worker:fresh 独立上下文、模板全字段生效)→ 最终交付追加到编排状态流。
 * 节点的中间轮次留在 Worker 会话,编排状态只承载最终交付(对齐 CC/dsh 深绑定语义)。
 */

import type { WorkflowState } from './shared'
import { admitWorkflowSpawn } from '../services/collab/admission'
import { extractTextContent } from './shared'
import { MessageRole, type Message, type ToolDefinition } from '../services/models/types'
import type { SubagentTemplate, TaskToolOutput } from '../orchestrator/types'
import { TaskExecutionStatus, TemplatePriority } from '../orchestrator/types'
import type { WorkflowAgentNodeConfig, WorkflowNodeDef } from './dsl/types'

/** 模板执行函数签名(由壳层/run_workflow 经 LocalSubagentAdapter 提供) */
export type AgentNodeExecuteFn = (
  template: SubagentTemplate,
  taskDescription: string,
  tools: ToolDefinition[] | undefined,
  availableTools: string[] | undefined,
  environmentKey?: string,
) => Promise<TaskToolOutput>

export interface AgentNodeDeps {
  /** 工作流调用键(匿名节点 Worker 身份派生源:wf_<workflow>_<nodeId>) */
  workflowName: string
  resolveTemplate(templateType: string): SubagentTemplate | undefined
  /** 全量工具定义池(会话级,含内置+MCP);executor 优先级链按模板默认从中过滤 */
  allToolDefinitions(): ToolDefinition[]
  executeTemplate: AgentNodeExecuteFn
  inputValues: Record<string, any>
  environmentKeyFor(nodeId: string): string
}

/** 匿名内联节点 → 临时 SubagentTemplate(与 parseTemplate 产物同形;不注册进 templateManager) */
export function ephemeralTemplate(
  workflowName: string,
  nodeId: string,
  a: WorkflowAgentNodeConfig,
): SubagentTemplate {
  const maxIterations = a.max_turns ?? a.max_iterations
  return {
    name: nodeId,
    description: '',
    subagent_type: `wf_${workflowName}_${nodeId}`,
    priority: 2 as TemplatePriority.USER,
    parameters: {},
    system_prompt: a.system_prompt,
    model: a.model,
    tools: a.tools,
    disallowed_tools: a.disallowed_tools,
    readonly: a.readonly,
    memory: a.memory,
    skills: a.skills,
    knowledge: a.knowledge,
    default_parameters: {
      ...(a.default_parameters ?? {}),
      ...(maxIterations ? { max_iterations: maxIterations } : {}),
    },
  }
}

function lastMessageText(state: WorkflowState): string {
  const last = state.messages[state.messages.length - 1]
  return last ? extractTextContent(last.content) : ''
}

/**
 * 渲染节点任务说明
 * 优先级链:节点 prompt > 模板自带 user_prompt_template > 缺省 {{prev}}
 * 变量:{{prev}}(上游最后一条输出)/ {{input.<name>}}(start 入参)/ {{nodes.<id>}}(指定节点最近产出)
 * {{nodes.<id>}} 引用尚无产出的节点 → 响亮报错(业务失败,入状态流)
 */
export function renderNodePrompt(
  node: WorkflowNodeDef,
  namedTemplate: SubagentTemplate | undefined,
  state: WorkflowState,
  inputValues: Record<string, any>,
): string {
  const templateText = node.agent!.prompt ?? namedTemplate?.user_prompt_template ?? '{{prev}}'
  return templateText.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, v: string) => {
    if (v === 'prev') return lastMessageText(state)
    if (v.startsWith('input.')) {
      const key = v.slice('input.'.length)
      return inputValues[key] !== undefined ? String(inputValues[key]) : ''
    }
    if (v.startsWith('nodes.')) {
      const key = v.slice('nodes.'.length)
      const output = state.nodeOutputs?.[key]
      if (output === undefined) {
        throw new Error(`prompt 引用的节点输出 {{nodes.${key}}} 不存在(该节点尚无产出)`)
      }
      return output
    }
    return _m
  })
}

/**
 * 深绑定 agent 节点执行器
 * 业务失败(worker 执行失败/模板缺失/渲染失败)作为节点失败消息入状态流(不中断图,与引擎现状一致);
 * 配置错误已在 run 启动前的集中预检拦截。
 */
export async function agentNodeExecutor(
  state: WorkflowState,
  nodeId: string,
  node: WorkflowNodeDef,
  deps: AgentNodeDeps,
): Promise<WorkflowState> {
  const a = node.agent!
  let resultText: string
  try {
    const named = a.template ? deps.resolveTemplate(a.template) : undefined
    if (a.template && !named) {
      throw new Error(`节点 "${nodeId}" 引用的单 Agent 模板 "${a.template}" 不存在`)
    }
    const template = named ?? ephemeralTemplate(deps.workflowName, nodeId, a)
    // 节点 max_turns 覆盖模板循环上限(显式节点参数优先)
    const effectiveTemplate =
      a.max_turns && named
        ? { ...named, default_parameters: { ...(named.default_parameters ?? {}), max_iterations: a.max_turns } }
        : template

    const taskDescription = renderNodePrompt(node, named, state, deps.inputValues)
    // 统一协作基板(迭代 3):caller='workflow' 显式准入——身份=匿名单元,永不入队、不计配额、无编排豁免
    // (语义钉死在 collab/admission;本行无行为变化,防统一身份解析后凭空入队)
    admitWorkflowSpawn()
    // 工作流无 Lead:传全量工具定义池 + availableTools=undefined,模板默认(省略=零/[all]=全量/
    // 名单)在 StandardSubagentExecutor 优先级链单一解析;同名传 availableTools 会误触发"显式指派"分支
    const output = await deps.executeTemplate(
      effectiveTemplate,
      taskDescription,
      deps.allToolDefinitions(),
      undefined,
      deps.environmentKeyFor(nodeId),
    )
    resultText =
      output.status === TaskExecutionStatus.COMPLETED
        ? output.final_output
        : `节点执行失败: ${output.error_info?.message ?? '未知错误'}`
  } catch (error: any) {
    resultText = `节点执行失败: ${error?.message ?? error}`
  }

  const message: Message = { role: MessageRole.ASSISTANT, content: resultText, timestamp: new Date() }
  return {
    ...state,
    messages: [...state.messages, message],
    currentNode: nodeId,
    nodeOutputs: { ...(state.nodeOutputs ?? {}), [nodeId]: resultText },
  }
}
