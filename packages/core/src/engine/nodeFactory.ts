/**
 * ChatEngine 的 Node 侧装配示例（T2；CLI 的正式接线在 T4，UI 在 T5 自行装配）
 *
 * 本模块 import Node-only 依赖（SessionPersistence → fs、模型服务单例群），
 * 只从 core 的 index.ts（Node 全量入口）导出，不进 index.renderer.ts。
 *
 * 装配内容：
 * - SessionStoreAdapter：复用 persistence/SessionPersistence.ts（~/.chill/sessions/）
 * - EngineModelCaller：ModelServiceFactory + BaseModelService.sendSingleMessage
 *   （引擎自己运行工具循环，模型调用每次只做一次请求；用户模型参数与
 *   ModelServiceFactory.sendChatMessage 同来源——SelectedModelsService.getModelParameters）
 * - 上下文组装门面：memoryStore / agentInstructions / getSkillRegistry 单例
 * - 委派指南数据源：getTemplateManager + convertTemplateToAvailableSubagent、
 *   modelInfoService.getModelsWithApiKeys + convertModelInfoToAvailableModel
 * - agent 资源：AgentFileManager.listAgents → ExecutableResource（映射与 CLI 现状一致）
 */

import type { IPathProvider } from '../interfaces/IPathProvider'
import type { ILocalAgentExecutor } from '../interfaces/ILocalAgentExecutor'
import type { ISecureStorage } from '../interfaces/ISecureStorage'
import type { ExecutableResource } from '../types/workflow'
import { SessionPersistence } from '../persistence/SessionPersistence'
import { ModelServiceFactory } from '../services/models/modelServiceFactory'
import { BaseModelService } from '../services/models/baseModelService'
import { modelInfoService } from '../services/models/modelInfoService'
import { SelectedModelsService } from '../services/selectedModelsService'
import { memoryStore } from '../services/memory/memoryStore'
import { agentInstructions } from '../services/agentInstructions'
import { getSkillRegistry } from '../skills/SkillRegistry'
import type { MCPService } from '../services/mcp/mcpService'
import type { BuiltInToolExecutor } from '../services/builtInToolExecutor'
import { AgentFileManager, type AgentSummary } from '../agent/AgentFileManager'
import { getTemplateManager } from '../orchestrator/managers/SubagentTemplateManager'
import { convertTemplateToAvailableSubagent } from '../orchestrator/managers/templateToAvailableSubagent'
import { ChatEngine } from './ChatEngine'
import { convertModelInfoToAvailableModel } from './delegationGuide'
import { saveCurrentGoal, archiveCurrentGoal, clearCurrentGoal } from '../services/goalPersistence'
import type { HookRunner } from '../services/hooks/HookRunner'
import type { MediaProvider, SessionStoreAdapter } from './types'

export interface NodeChatEngineOptions {
  /** AGENTS.md 等工作目录（通常为 process.cwd()） */
  workDir: string
  /** 用户数据路径提供者（会话落盘目录推导） */
  pathProvider: IPathProvider
  /** 内置工具统一执行入口（plan 拦截门所在） */
  builtInToolExecutor: BuiltInToolExecutor
  /** MCP 服务（单例聚合；经 getAggregatedOpenAITools 取工具） */
  mcpService: MCPService
  /** 本地 Agent 资源来源（可选；缺省不加载 agent 资源工具） */
  agentFileManager?: AgentFileManager
  /** local_agent 资源执行器（agentFileManager 提供时必需） */
  localAgentExecutor?: ILocalAgentExecutor
  /** 远程 agent 资源执行所需（可选） */
  secureStorage?: ISecureStorage
  /** 媒体 provider（fileId→base64；可选） */
  mediaProvider?: MediaProvider
  /** 会话目录覆盖（自迭代体验窗口等场景；可选） */
  sessionsDirOverride?: string
  /**
   * 会话持久化适配器覆盖（可选）：注入后不再内部创建 SessionPersistence。
   * 用于——① 宿主需与本工厂外的 watch/loadIfNewer 共享同一 persistence 实例（CLI）；
   * ② UI 渲染进程经 IPC 落盘（session:save/session:list，T5）
   */
  sessionStore?: SessionStoreAdapter
  /** 工具循环最大迭代次数（可选，缺省不限） */
  maxToolIterations?: number
  /** hooks 运行器（可选；引擎据此接线全部生命周期挂载点并透传给 builtInToolExecutor 的 Worker 咽喉） */
  hookRunner?: HookRunner | null
}

/** AgentSummary → ExecutableResource 映射（与 CLI CliChatService 现状一致，供 agent 资源工具注册） */
export function buildLocalAgentResources(agents: AgentSummary[]): ExecutableResource[] {
  return agents.map((a) => ({
    id: `local-agent-${a.id}`,
    name: a.name,
    description: `本地工作流Agent: ${a.name}`,
    type: 'local_agent' as const,
    capabilities: ['workflow_execution'],
    config: {
      type: 'local_agent' as const,
      agentId: a.id,
      metadata: {
        id: a.id,
        name: a.name,
        description: '',
        createdAt: Date.now(),
        updatedAt: a.updatedAt,
        version: 1,
        agentCard: {
          name: a.name,
          version: '1.0.0',
          capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
          skills: [],
        },
        sourceWorkflowId: a.sourceWorkflowId,
        sourceWorkflowVersion: 1,
        autoSyncEnabled: a.autoSyncEnabled,
      },
    },
    enabled: true,
    createdAt: a.updatedAt,
    updatedAt: a.updatedAt,
  }))
}

/** 创建 Node 侧 ChatEngine（装配示例；宿主按要求裁剪可选依赖） */
export function createNodeChatEngine(options: NodeChatEngineOptions): ChatEngine {
  const sessionStore: SessionStoreAdapter =
    options.sessionStore ??
    (() => {
      const sessionPersistence = new SessionPersistence(options.pathProvider, options.sessionsDirOverride)
      return {
        save: (record, mode) => sessionPersistence.save(record, mode),
        load: (id) => sessionPersistence.load(id),
      }
    })()

  return new ChatEngine({
    workDir: options.workDir,
    builtInToolExecutor: options.builtInToolExecutor,
    mcpService: options.mcpService,
    sessionStore,
    modelCaller: {
      callOnce: async ({ modelName, messages, tools, streamCallback, abortController, parameterOverrides }) => {
        const info = modelInfoService.getModelInfoByName(modelName)
        if (!info) {
          throw new Error(`模型未注册: ${modelName}`)
        }
        // 用户模型参数与 ModelServiceFactory.sendChatMessage 同来源，确保与现状同一套调用路径；
        // parameterOverrides（如压缩调用关思考）最后合并，覆盖用户参数
        const userParams = {
          ...(SelectedModelsService.getInstance().getModelParameters(modelName) || {}),
          ...parameterOverrides,
        }
        const service = await ModelServiceFactory.getInstance().createModelService(
          info.type,
          userParams,
          modelName
        )
        if (typeof (service as BaseModelService).sendSingleMessage !== 'function') {
          throw new Error(`模型服务不支持单次调用: ${modelName}`)
        }
        return (service as BaseModelService).sendSingleMessage(
          messages,
          tools,
          streamCallback,
          abortController
        )
      },
    },
    modelInfo: modelInfoService,
    selectedModels: SelectedModelsService.getInstance(),
    memoryStore,
    agentInstructions,
    skillRegistry: getSkillRegistry(),
    getSubagents: () => {
      try {
        return getTemplateManager()
          .getAllTemplates()
          .map((t) => convertTemplateToAvailableSubagent(t))
      } catch {
        return []
      }
    },
    getSubagentTemplate: (subagentType) => {
      try {
        return getTemplateManager().getTemplateByType(subagentType)
      } catch {
        return undefined
      }
    },
    getAvailableModels: async () => {
      try {
        const infos = await modelInfoService.getModelsWithApiKeys()
        return infos.map((info) => convertModelInfoToAvailableModel(info))
      } catch {
        return []
      }
    },
    localAgentResources: options.agentFileManager
      ? async () => {
          const result = await options.agentFileManager!.listAgents()
          if (!result.success || !result.agents) return []
          return buildLocalAgentResources(result.agents)
        }
      : undefined,
    localAgentExecutor: options.localAgentExecutor,
    secureStorage: options.secureStorage,
    mediaProvider: options.mediaProvider,
    maxToolIterations: options.maxToolIterations,
    hookRunner: options.hookRunner,
    // 目标文档落盘（~/.chill/goals/）与熔断请示应答通道（现读 executor 上的 provider）
    goalStore: {
      save: (state) => saveCurrentGoal(state),
      archive: (state) => { archiveCurrentGoal(state) },
      clear: () => clearCurrentGoal(),
    },
    getUserInputProvider: () => options.builtInToolExecutor.getUserInputProvider(),
  })
}
