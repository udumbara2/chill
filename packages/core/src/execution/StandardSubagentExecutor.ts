import type { ISubagentExecutor } from './ISubagentExecutor'
import type { ISecureStorage } from '../interfaces/ISecureStorage'
import type { TemplateSubagentForkManager } from '../orchestrator/isolation/TemplateSubagentForkManager'
import type { ToolDefinition } from '../types/models'
import { modelInfoService } from '../services/models/modelInfoService'
import { providerManager } from '../services/models/providerManager'
import { SelectedModelsService } from '../services/selectedModelsService'
import { getTaskRegistry } from '../services/delegation/taskRegistry'
import { getDelegationContext } from '../services/delegation/delegationTools'
import { getWriteBoundary } from '../services/writeBoundary'
import { MemoryStore, memoryStore } from '../services/memory/memoryStore'
import type { SubagentRequest, SubagentResponse } from '../orchestrator/isolation/types'
import type { SubagentTemplate } from '../orchestrator/types'
import { wrapSubtaskPrompt } from '../orchestrator/rolePrompt'

export class StandardSubagentExecutor implements ISubagentExecutor {
  private secureStorage: ISecureStorage
  private forkManagerFactory: () => TemplateSubagentForkManager

  constructor(
    secureStorage: ISecureStorage,
    forkManagerFactory: () => TemplateSubagentForkManager
  ) {
    this.secureStorage = secureStorage
    this.forkManagerFactory = forkManagerFactory
  }

  /**
   * 当前会话模型名；SelectedModelsService 未初始化或读取异常时返回 null（落到注册表默认）
   */
  private getSessionModelName(): string | null {
    try {
      return SelectedModelsService.getInstance().getCurrentModelName()
    } catch {
      return null
    }
  }

  async execute(
    template: Record<string, unknown>,
    taskDescription: string,
    mergedParams: Record<string, unknown>,
    _startTime: number,
    tools?: ToolDefinition[],
    availableTools?: string[],
    apiKey?: string,
    baseURL?: string,
    environmentKey?: string
  ): Promise<Record<string, unknown>> {
    const subagentType = template.subagent_type as string
    if (!subagentType) {
      return { status: 'failed', final_output: '', error_info: { message: '模板缺少 subagent_type' } }
    }

    // 模型兜底链：委派 override > 模板 model > 当前会话模型 > 注册表默认
    const model =
      (mergedParams.model as string) ||
      (template.model as string) ||
      this.getSessionModelName() ||
      modelInfoService.getDefaultModelName()
    const info = modelInfoService.getModelInfoByName(model)
    if (!info) {
      throw new Error(
        `Model not found in ModelInfoService: ${model}. Ensure the model is registered before execution.`
      )
    }

    // 子任务场景角色包装（T3 角色与能力分离）：模板 system_prompt 只作能力描述，
    // 角色框架（"执行子任务的 Subagent"）由 wrapSubtaskPrompt 统一提供；
    // 写边界集合与状态分支随委派携带（Worker 不吃主会话注入器，与 write-boundary 注入同源）
    const writeBoundary = getWriteBoundary()
    let systemPrompt = wrapSubtaskPrompt(template as unknown as SubagentTemplate, {
      roots: writeBoundary.listWritableRoots(),
      readonly: writeBoundary.isReadonlyMode(),
      fullAccess: writeBoundary.isFullAccess(),
    })
    const userPromptTemplate = (template.user_prompt_template as string) || ''

    // per-agent 记忆分层（委派通道：一次解析、随任务注册表登记，执行零查表）：
    // ① 全局共享记忆索引只读注入所有本地 subagent（含用户偏好层，写作/评审类任务需要贴合用户）；
    // ② 模板声明 memory 时解析三作用域目录（workDir 取经 DelegationContext——
    //    task 执行刻意不传参、由引擎按轮注册的语境通道），追加自身空间索引与读写指引
    const memoryScope = template.memory as 'user' | 'project' | 'local' | undefined
    let memoryDir: string | undefined
    const globalIndex = await memoryStore.buildIndexInjection().catch(() => null)
    if (globalIndex) {
      systemPrompt += '\n\n【全局共享记忆（只读参考）】以下是全局长期记忆索引，仅供你参考用户偏好与项目事实；不要写入它（你的写入应进自己的记忆空间，或由你判断确属用户偏好时用 scope: "global"）。\n' + globalIndex
    }
    if (memoryScope) {
      try {
        const workDir = getDelegationContext()?.workDir
        memoryDir = await memoryStore.resolveAgentMemoryDir(memoryScope, subagentType, workDir)
        const ownIndex = await MemoryStore.getScoped(memoryDir).buildIndexInjection().catch(() => null)
        systemPrompt +=
          `\n\n【你的专属记忆空间】你拥有跨会话保留的持久记忆空间（目录：${memoryDir}）。\n` +
          `- 写入/更新调用 save_memory、删除调用 delete_memory（缺省即写入你自己的空间）；用户偏好、用户纠正等"属于用户"的认知，用 scope: "global" 写入全局共享记忆。\n` +
          `- 索引中某条详情可用 read_file 读取 ${memoryDir}/<文件名>。\n` +
          (ownIndex ? `当前记忆索引：\n${ownIndex}` : '（暂无记忆）')
      } catch {
        memoryDir = undefined // 解析失败降级为无私域（不阻断任务）
      }
    }

    // key 解析与主对话同约定：按 provider 经 resolveId 落稳定 id（与 /key set、add_model 的存储名目一致）
    const resolvedApiKey =
      apiKey ||
      (await this.secureStorage.getApiKey(providerManager.resolveId(info.provider || model))) || ''
    const resolvedBaseURL = baseURL || info.adapterConfig?.baseURL || null
    if (!resolvedBaseURL) {
      throw new Error(
        `No baseURL found for model: ${model}. adapterConfig.baseURL is required.`
      )
    }

    const config = {
      model,
      modelType: info.type,
      adapterConfig: info.adapterConfig,
      temperature: (mergedParams.temperature as number | undefined) ?? 0.6,
      // thinking 模型的推理 token 与正文共享 maxTokens 配额——4000 会被思考耗尽导致空输出；
      // 默认按能力区分：thinking 模型 32000，其余 4000（mergedParams.maxTokens 优先）
      maxTokens: (mergedParams.maxTokens as number | undefined) ?? (info.supportsThinking ? 32000 : 4000),
      maxIterations: (mergedParams.max_iterations as number | undefined) ?? 10,
      // 模板 timeout 贯通到 fork 层（fork 硬超时与 pending 超时以此为据，缺省 600s）
      timeout: (mergedParams.timeout as number | undefined) ?? 600,
      systemPrompt,
      userPromptTemplate,
      apiKey: resolvedApiKey || undefined,
      baseURL: resolvedBaseURL,
    }

    const forkManager = this.forkManagerFactory()
    const environment = await forkManager.createEnvironment(subagentType, config)

    const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const userMessage = userPromptTemplate
      ? userPromptTemplate.replace(/\{\{task_description\}\}/g, taskDescription)
      : taskDescription

    const request: SubagentRequest = {
      taskId,
      subagentType,
      subagentConfig: config,
      userMessage,
      systemPrompt,
      toolDefinitions: tools,
      authorizedTools: availableTools,
    }

    // Worker 标识上抛（cancel_task 的前提）：sendRequest await 前把 绑定键 → environment
    // 登记进任务注册表，settle 时清项；执行完自行 destroy 的现成语义不变。
    // 绑定键优先用上游透传的 toolCall.id（environmentKey，注册表条目的主键，
    // cancel_task 由此直达环境），缺省回退执行器内部 taskId（兼容未透传的调用方）
    const bindKey = environmentKey ?? taskId
    const taskRegistry = getTaskRegistry()
    taskRegistry.bindEnvironment(bindKey, environment, memoryDir)
    try {
      const response: SubagentResponse = await environment.sendRequest(request)
      await environment.destroy()
      return response.success
        ? { status: 'completed', final_output: response.output || '' }
        : {
            status: 'failed',
            final_output: '',
            error_info: { message: response.error || '未知错误' },
          }
    } catch (err) {
      await environment.destroy().catch(() => {})
      return {
        status: 'failed',
        final_output: '',
        error_info: {
          message: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      taskRegistry.unbindEnvironment(bindKey)
    }
  }
}
