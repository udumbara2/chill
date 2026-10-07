/**
 * run_workflow 工具(M5):按名触发命名工作流
 *
 * 与 task 委派同族同生命周期:登记前预检(不存在/入参缺失/配额)→ 登记注册表 +
 * 受理占位 → 后台执行 → settle(markSettled + 事件 + notifyTaskSettled 回流)。
 * 取消通道复用 cancel_task / Ctrl+K 全停:环境绑定为 AbortController 封装。
 *
 * 审批合规:节点内工具调用经壳层注入的 toolRunner 走统一决策管线(Worker 咽喉同款
 * __origin 注入);未注入 runner 时按 canvas 现状直跑(引擎默认处理器)。
 *
 * 嵌套约束:run_workflow 不下发给 Worker(编排工具过滤),工作流不可嵌套调用。
 */

import type { ToolDefinition } from '../../types/models'
import { TaskExecutionStatus, type TaskToolOutput } from '../../orchestrator/types'
import { getTaskRegistry } from './taskRegistry'
import { getDelegationQuotaError } from './quota'
import { getDelegationContext } from './delegationTools'
import { eventBus, EVENTS } from '../../utils/eventBus'
// 注:workflowGraphBuilder 经动态 import 延迟加载——静态引入会形成
// builtInTools → workflowRunTool → workflowGraphBuilder → toolExecutors → builtInTools 循环依赖
import { definitionToEngineConfig, definitionToEngineInput } from '../../workflow/dsl/workflowSerializer'
import type { WorkflowDefinition } from '../../workflow/dsl/types'
import type { WorkflowTemplateService } from '../workflow/WorkflowTemplateService'
import type { WorkflowState } from '../../workflow/shared'
import type { IsolatedEnvironment } from '../../orchestrator/isolation/types'
import { getTemplateManager } from '../../orchestrator/managers/SubagentTemplateManager'
import { workflowContentHash, type WorkflowRunStore, type WorkflowRunRecord } from '../workflow/workflowRunStore'
import type { AgentNodeDeps } from '../../workflow/agentNodeExecutor'

/** 壳层注入的工作流工具执行器(统一决策管线入口;Worker 咽喉同款 __origin 语义) */
export type WorkflowToolRunner = (
  toolName: string,
  params: Record<string, any>,
  meta: { runId: string },
) => Promise<{ success: boolean; data?: any; error?: string }>

export interface WorkflowRunProviders {
  /** 获取当前进程的 WorkflowTemplateService(CLI/electron 主进程/渲染进程各自装配) */
  getService: () => WorkflowTemplateService | undefined
  /** 工具执行器(可选;缺省时节点工具调用走引擎默认通道) */
  toolRunner?: WorkflowToolRunner
  /** 运行记录存储(M6 断点续跑;缺省时 resume_from 不可用,运行不记录) */
  getRunStore?: () => WorkflowRunStore | undefined
}

let providers: WorkflowRunProviders | null = null

export function setWorkflowRunProviders(p: WorkflowRunProviders): void {
  providers = p
}

/** 工作流索引注入用访问器(ContextAssembler;未装配时返回 undefined) */
export function getWorkflowServiceForIndex(): WorkflowTemplateService | undefined {
  try {
    return providers?.getService()
  } catch {
    return undefined
  }
}

/** run_workflow 工具定义 */
export const runWorkflowToolDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_workflow',
    description:
      '按名运行一个命名工作流(预先保存的多步骤编排,YAML 资产)。用 name 指定工作流(可用清单见系统提示中的工作流索引),input 按该工作流的 inputs 契约传入参。运行是后台异步的:受理后立即返回,完成后会收到通知,届时整合结果答复用户;在收到通知前不要假设已有结果。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '工作流调用键(kebab-case,如 tech-article)',
        },
        input: {
          type: 'object',
          description: '入参对象,键为工作流 inputs 契约里的 name;text 入参传字符串,file 入参传文件路径',
        },
        resume_from: {
          type: 'string',
          description: '可选:从中断的运行记录 id 续跑(已完成的节点不会重跑)',
        },
      },
      required: ['name'],
    },
  },
}

/** 正在运行的工作流 run 的取消通道(runId → AbortController) */
const runAbortControllers = new Map<string, AbortController>()

/** 构造中断错误(与委派 createAbortError 同约定) */
function createAbortError(): Error {
  const err = new Error('Request aborted')
  err.name = 'AbortError'
  return err
}

interface RunWorkflowArgs {
  name?: string
  input?: Record<string, any>
  resume_from?: string
  /** 调用归属保留字段（2.1 主会话注入；登记时拷贝 engineHandle，执行语义不读） */
  __origin?: { handle?: string }
}

function readableAvailableList(service: WorkflowTemplateService): string {
  const all = service.getAllWorkflows()
  if (all.length === 0) return '(当前没有可用的工作流)'
  return all.map((w) => `- ${w.name}: ${w.description || w.title || ''}`).join('\n')
}

/** 入参契约校验:必填缺失/未知入参报可读错误;返回 start 节点的 text/files */
function buildStartInput(
  def: WorkflowDefinition,
  input: Record<string, any> | undefined,
): { text?: string; files?: string[]; error?: string } {
  const contract = def.inputs ?? []
  const provided = input ?? {}
  const missing = contract.filter((i) => i.required && (provided[i.name] === undefined || provided[i.name] === null || provided[i.name] === ''))
  if (missing.length > 0) {
    const lines = contract
      .map((i) => `- ${i.name}(${i.type ?? 'text'}${i.required ? ',必填' : ''}): ${i.description ?? ''}`)
      .join('\n')
    return { error: `缺少必填入参: ${missing.map((i) => i.name).join(', ')}。该工作流的入参契约:\n${lines}` }
  }
  const textParts: string[] = []
  const files: string[] = []
  for (const item of contract) {
    const value = provided[item.name]
    if (value === undefined || value === null) continue
    if (item.type === 'file') {
      files.push(String(value))
    } else {
      textParts.push(contract.length === 1 ? String(value) : `${item.name}: ${value}`)
    }
  }
  // 契约未声明的多余入参:并入文本,不报错(宽松)
  const contracted = new Set(contract.map((i) => i.name))
  for (const [k, v] of Object.entries(provided)) {
    if (!contracted.has(k)) textParts.push(`${k}: ${v}`)
  }
  return { text: textParts.join('\n') || undefined, files: files.length > 0 ? files : undefined }
}

/**
 * run_workflow 工具执行(builtInToolExecutor 异步入口调用)
 * @returns 交互模式为受理占位(RUNNING),sync(-p)为真实结果
 */
export async function executeRunWorkflow(
  toolCallId: string,
  args: RunWorkflowArgs,
  options?: { sync?: boolean },
): Promise<{ success: boolean; content?: string; error?: string }> {
  const service = providers?.getService()
  if (!service) {
    return { success: false, error: '工作流服务未初始化(宿主未装配 WorkflowTemplateService)' }
  }
  if (!args.name || typeof args.name !== 'string') {
    return { success: false, error: 'run_workflow 需要提供 name 参数(工作流调用键)' }
  }
  const def = service.getWorkflowByName(args.name)
  if (!def) {
    return {
      success: false,
      error: `工作流 "${args.name}" 不存在。当前可用:\n${readableAvailableList(service)}`,
    }
  }
  if (args.resume_from && !providers?.getRunStore?.()) {
    return { success: false, error: '当前宿主未装配运行记录存储,resume_from 不可用' }
  }
  const runStore = providers?.getRunStore?.()

  // 续跑预检:记录存在、属于同名工作流、内容哈希一致、非进行中
  let resumeRecord: WorkflowRunRecord | undefined
  if (args.resume_from) {
    resumeRecord = await runStore!.load(args.resume_from)
    if (!resumeRecord) {
      return { success: false, error: `运行记录 "${args.resume_from}" 不存在,无法续跑` }
    }
    if (resumeRecord.workflowName !== def.name) {
      return { success: false, error: `运行记录 "${args.resume_from}" 属于工作流 "${resumeRecord.workflowName}",与 "${def.name}" 不符` }
    }
    if (resumeRecord.contentHash !== workflowContentHash(def)) {
      return { success: false, error: `工作流 "${def.name}" 的定义自该次运行后已变更,无法续跑(已完成节点的产出可能与新定义不符),请从头运行` }
    }
    if (resumeRecord.status === 'running') {
      return { success: false, error: `运行 "${args.resume_from}" 仍在进行中,不能重复续跑` }
    }
    if (resumeRecord.status === 'completed') {
      return { success: false, error: `运行 "${args.resume_from}" 已完成,无需续跑(产出: ${(resumeRecord.finalOutput ?? '').slice(0, 200)})` }
    }
  }

  const startInput = buildStartInput(def, args.input)
  if (startInput.error && !resumeRecord) return { success: false, error: startInput.error }

  // ---- 集中预检(登记/执行前,响亮拒绝):模板引用存在、工具可用、配置合法 ----
  {
    const preflightToolDefs = getDelegationContext()?.toolDefinitions ?? []
    const missingTools = new Set<string>()
    const collectingResolver = {
      resolveTemplate: (t: string) => getTemplateManager().getTemplateByType(t),
      resolveTools: (names: string[]): ToolDefinition[] =>
        names.flatMap((name) => {
          const hit = preflightToolDefs.find((d) => d.function?.name === name)
          if (!hit) missingTools.add(name)
          return hit ? [hit] : []
        }),
    }
    const preflightMaps = definitionToEngineInput(def, collectingResolver)
    const preflightErrors = [...preflightMaps.errors]
    if (missingTools.size > 0) {
      preflightErrors.push(`以下工具在当前会话不可用: ${[...missingTools].join(', ')}`)
    }
    if (preflightErrors.length > 0) {
      return { success: false, error: `工作流 "${args.name}" 预检失败,未启动:\n${preflightErrors.join('\n')}` }
    }
  }

  // 资源限额(登记前同步拒绝,与 task 同闸)
  const quotaError = getDelegationQuotaError()
  if (quotaError) return { success: false, error: quotaError }

  const runId = args.resume_from ?? `wf_${def.name}_${Date.now()}`
  const displayName = def.title || def.name

  // ---- 真实执行(后台/同步共用) ----
  const doRun = async (): Promise<TaskToolOutput> => {
    const {
      compileWorkflow,
      executeWorkflow,
      startNodeExecutor,
      modelNodeExecutor,
      toolNodeExecutor,
      codeExecutorNode,
    } = await import('../../workflow/workflowGraphBuilder')
    const { extractTextContent } = await import('../../workflow/shared')
    const abortController = new AbortController()
    runAbortControllers.set(runId, abortController)
    const abortMap = new Map([[runId, abortController]])
    // 运行记录(M6):续跑基于既有记录,否则新建;节点完成即增量落盘(原子写)
    const record: WorkflowRunRecord = resumeRecord ?? {
      runId,
      workflowName: def.name,
      contentHash: workflowContentHash(def),
      input: args.input,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      completedNodes: [],
    }
    record.status = 'running'
    const completedNodeMessages = new Map(record.completedNodes.map((n) => [n.nodeId, n.messages] as const))
    try {
      const { nodes, edges } = definitionToEngineConfig(def)
      const runner = providers?.toolRunner
      const runnerFn = runner
        ? (name: string, params: Record<string, any>) => runner(name, params, { runId })
        : undefined
      // 节点处理器:注入 runner(统一决策管线)与取消通道;每步执行前检查中断;
      // 已完成节点命中运行记录直接跳过(不重跑),新完成节点增量落记录
      const guard = () => {
        if (abortController.signal.aborted) throw createAbortError()
      }
      const withRecord =
        (handler: (state: WorkflowState, nodeId: string, ...rest: any[]) => any) =>
        async (state: WorkflowState, nodeId: string, ...rest: any[]) => {
          guard()
          if (completedNodeMessages.has(nodeId)) return state
          const before = state.messages?.length ?? 0
          const next = await handler(state, nodeId, ...rest)
          // 执行后复查:运行在等待期间被取消时,该节点产出不得入记录(否则续跑会跳过未真正完成的节点)
          guard()
          const produced = (next.messages ?? []).slice(before)
          record.completedNodes.push({ nodeId, messages: produced })
          completedNodeMessages.set(nodeId, produced)
          if (runStore) await runStore.save(record).catch(() => {})
          return next
        }
      // 模板/工具解析:模板走 core 单例 getTemplateManager(与委派同源);
      // 工具名 → ToolDefinition 从当轮委派上下文的全量工具集匹配(与 task 的 available_tools 同源)
      const toolDefs = getDelegationContext()?.toolDefinitions ?? []
      const resolver = {
        resolveTemplate: (t: string) => getTemplateManager().getTemplateByType(t),
        resolveTools: (names: string[]): ToolDefinition[] => {
          const missing: string[] = []
          const found = names.flatMap((name) => {
            const hit = toolDefs.find((d) => d.function?.name === name)
            if (!hit) missing.push(name)
            return hit ? [hit] : []
          })
          if (missing.length > 0) {
            throw new Error(`以下工具在当前会话不可用: ${missing.join(', ')}`)
          }
          return found
        },
      }
      // 深绑定 agent 节点依赖(LocalSubagentAdapter 直达 ForkManager 的执行通道)
      // 动态 import(防 builtInTools → workflowRunTool → … → builtInTools 循环;agentNodeExecutor 经 shared 拉入 toolExecutors)
      const { getTaskExecutor } = await import('../../orchestrator/executor/TaskExecutor')
      const { agentNodeExecutor } = await import('../../workflow/agentNodeExecutor')
      const agentDeps: AgentNodeDeps = {
        workflowName: def.name,
        resolveTemplate: resolver.resolveTemplate,
        // 全量工具定义池(与 task 委派同源);executor 优先级链按模板默认过滤,节点侧不再预解析
        allToolDefinitions: () => toolDefs,
        executeTemplate: (template, taskDescription, tools, availableTools, environmentKey) =>
          getTaskExecutor().executeTemplateDirect(template, taskDescription, tools, availableTools, environmentKey),
        inputValues: (args.input as Record<string, any>) ?? {},
        environmentKeyFor: (nodeId) => `${runId}__node_${nodeId}`,
      }
      const handlers: Record<string, Function> = {
        start: withRecord((state: WorkflowState, nodeId: string) => startNodeExecutor(state, nodeId)),
        model: withRecord((state: WorkflowState, nodeId: string, loopBranches?: any[]) =>
          modelNodeExecutor(state, nodeId, loopBranches ?? [], runId, abortMap, runnerFn)),
        tool: withRecord((state: WorkflowState, nodeId: string) => toolNodeExecutor(state, nodeId, runnerFn)),
        code: withRecord((state: WorkflowState, nodeId: string) => codeExecutorNode(state, nodeId)),
        // 深绑定 agent 节点(template 引用/驮具字段)→ Worker 独立上下文循环;
        // 节点任务以所属 run 的 batchId 登记(/tasks 按 run 分组可见、可单独取消)
        agent: withRecord(async (state: WorkflowState, nodeId: string) => {
          const nodeDef = def.nodes.find((n) => n.id === nodeId)
          if (!nodeDef) throw new Error(`节点 "${nodeId}" 的定义缺失`)
          const runEntry = getTaskRegistry().getByToolCallId(toolCallId)
          const runBatchId = runEntry?.batchId
          const nodeKey = agentDeps.environmentKeyFor(nodeId)
          if (runBatchId) {
            getTaskRegistry().register({
              taskId: nodeKey,
              toolCallId: nodeKey,
              subagentType: `workflow-node:${nodeId}`,
              description: `工作流「${displayName}」节点「${nodeDef.label ?? nodeId}」`,
              batchId: runBatchId,
              ...(runEntry?.engineHandle ? { engineHandle: runEntry.engineHandle } : {}),
            })
          }
          const next = await agentNodeExecutor(state, nodeId, nodeDef, agentDeps)
          if (runBatchId && getTaskRegistry().getByToolCallId(nodeKey)?.status === 'running') {
            getTaskRegistry().unbindEnvironment(nodeKey)
            const produced = next.messages[next.messages.length - 1]
            getTaskRegistry().markSettled(nodeKey, {
              status: TaskExecutionStatus.COMPLETED,
              final_output: produced ? extractTextContent(produced.content) : '',
            })
          }
          return next
        }),
      }
      const { graph } = compileWorkflow(nodes, edges, { nodeHandlers: handlers })

      const maps = definitionToEngineInput(def, resolver)
      if (maps.errors.length > 0) {
        throw new Error(`工作流配置解析失败:\n${maps.errors.join('\n')}`)
      }

      const input: Partial<WorkflowState> = {
        // 续跑:start 节点命中记录被跳过,初始消息由已完成节点的产出按序回填
        text: resumeRecord ? undefined : startInput.text,
        files: resumeRecord ? undefined : startInput.files,
        messages: resumeRecord ? record.completedNodes.flatMap((n) => n.messages) : undefined,
        modelConfigs: maps.modelConfigs,
        selectedToolsMap: maps.selectedToolsMap,
        toolParamsMap: maps.toolParamsMap,
        systemPrompts: maps.systemPrompts,
        codeExecutorConfigs: maps.codeExecutorConfigs,
        executionResults: [],
      }
      const finalState = await executeWorkflow(graph, input, runId)
      const lastMessage = finalState.messages[finalState.messages.length - 1]
      const outputText = lastMessage ? extractTextContent(lastMessage.content) : '(无输出)'
      record.status = 'completed'
      record.finalOutput = outputText
      if (runStore) await runStore.save(record).catch(() => {})
      return { status: TaskExecutionStatus.COMPLETED, final_output: outputText }
    } catch (error: any) {
      const aborted = error?.name === 'AbortError' || abortController.signal.aborted
      record.status = aborted ? 'cancelled' : 'failed'
      record.error = error?.message ?? String(error)
      if (runStore) await runStore.save(record).catch(() => {})
      const resumeHint = runStore ? `(运行标识: ${runId},排除问题后可用 resume_from 续跑,已完成节点不会重跑)` : ''
      return {
        status: TaskExecutionStatus.FAILED,
        final_output: '',
        error_info: {
          code: aborted ? 'CANCELLED' : 'RUN_FAILED',
          message: aborted ? `工作流已被取消${resumeHint}` : `工作流执行失败: ${error?.message ?? error}${resumeHint}`,
        },
      }
    } finally {
      runAbortControllers.delete(runId)
    }
  }

  // ---- sync(-p 非交互):await 真实结果,不登记 ----
  if (options?.sync) {
    const output = await doRun()
    return output.status === TaskExecutionStatus.COMPLETED
      ? { success: true, content: output.final_output }
      : { success: false, error: output.error_info?.message ?? '工作流执行失败' }
  }

  // ---- 交互模式:登记 + 占位 + 后台执行 ----
  const registry = getTaskRegistry()
  const wfEngineHandle = typeof args.__origin?.handle === 'string' && args.__origin.handle ? args.__origin.handle : undefined
  registry.register({
    taskId: runId,
    toolCallId,
    subagentType: `workflow:${def.name}`,
    description: `运行工作流「${displayName}」`,
    batchId: registry.newBatchId(),
    ...(wfEngineHandle ? { engineHandle: wfEngineHandle } : {}),
  })

  // 环境绑定 = AbortController 封装(cancel_task / Ctrl+K 全停经 environment.destroy 到达)
  const environment: IsolatedEnvironment = {
    id: runId,
    sendRequest: () => Promise.reject(new Error('工作流运行不支持 sendRequest')),
    destroy: async () => {
      runAbortControllers.get(runId)?.abort()
    },
  }
  registry.bindEnvironment(toolCallId, environment)

  const ctx = getDelegationContext()
  eventBus.emit(EVENTS.SUBAGENT_TASK_STARTED, {
    taskId: runId,
    subagentType: `workflow:${def.name}`,
    description: `运行工作流「${displayName}」`,
  })

  doRun().then(async (output) => {
    registry.unbindEnvironment(toolCallId)
    if (registry.getByToolCallId(toolCallId)?.status === 'cancelled') return
    registry.markSettled(toolCallId, output)
    eventBus.emit(
      output.status === TaskExecutionStatus.COMPLETED ? EVENTS.SUBAGENT_TASK_COMPLETED : EVENTS.SUBAGENT_TASK_FAILED,
      { taskId: runId, subagentType: `workflow:${def.name}`, description: `运行工作流「${displayName}」`, taskOutput: output },
    )
    ctx?.notifyTaskSettled?.(toolCallId, output)
  })

  return {
    success: true,
    content:
      `工作流已受理,后台执行中(运行标识: ${runId}),完成时会收到通知,届时请整合结果答复用户;` +
      '在收到通知前不要假设已有结果。',
  }
}
