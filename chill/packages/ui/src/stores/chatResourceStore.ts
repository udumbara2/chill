import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  ExecutableResource,
  ExecutableResourceType,
  RemoteAgentConfig,
  ToolConfig,
  ToolDefinition
} from '@assistant-ai/core'
import { MCPService } from '@assistant-ai/core'
import { useMCPStore } from './mcpStore'
import { tryGetHostAPI } from '../host/hostApi'

/**
 * CHAT资源管理Store
 * 负责整合和管理CHAT模块可调用资源（Tool + RemoteAgent；本地工作流 Agent 体系已退役）
 */
export const useChatResourceStore = defineStore('chatResource', () => {
  // ==================== State ====================
  
  /** 所有可执行资源列表 */
  const resources = ref<ExecutableResource[]>([])
  
  /** 加载状态 */
  const isLoading = ref(false)
  
  /** 错误信息 */
  const error = ref<string | null>(null)
  
  /** 远程Agent配置列表（从localStorage加载） */
  const remoteAgents = ref<RemoteAgentConfig[]>([])

  // MCP服务实例（懒加载）
  let mcpServiceInstance: MCPService | null = null
  
  // ==================== Getters ====================
  
  /** 获取所有资源 */
  const allResources = computed(() => resources.value)
  
  /** 获取启用的资源 */
  const enabledResources = computed(() => 
    resources.value.filter(r => r.enabled)
  )
  
  /** 获取远程Agent资源 */
  const remoteAgentResources = computed(() =>
    resources.value.filter(r => r.type === 'remote_agent')
  )
  
  /** 获取工具资源 */
  const toolResources = computed(() =>
    resources.value.filter(r => r.type === 'tool')
  )
  
  /** 获取资源数量 */
  const resourceCount = computed(() => ({
    total: resources.value.length,
    enabled: enabledResources.value.length,
    remoteAgents: remoteAgentResources.value.length,
    tools: toolResources.value.length
  }))
  
  // ==================== Private Methods ====================
  
  /**
   * 获取MCP服务实例
   */
  function getMCPService(): MCPService {
    if (!mcpServiceInstance) {
      mcpServiceInstance = new MCPService()
      // MCP 工具开关门（修复：chatResourceStore 自建实例缺 mcpStoreGetter →
      // getOpenAITools() 的 !mcpStore?.getMCPToolsEnabled() 恒 true → 永远返回空）。
      // 与 main.ts 的 ModelServiceFactory.initialize 传入的 getter 同源（useMCPStore）
      const mcpStore = useMCPStore()
      mcpServiceInstance.setMCPStoreGetter(() => ({
        getMCPToolsEnabled: () => mcpStore.getMCPToolsEnabled()
      }))
    }
    return mcpServiceInstance
  }
  
  /**
   * 生成 A2A URL 的 SHA-256 前 16 位 hex 作为 key
   */
  async function computeA2AKey(url: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(url)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    return `a2a-${hashHex.substring(0, 16)}`
  }

  /**
   * 通过 IPC 从磁盘加载远程 Agent 配置
   * 首次读取为空时，回退 localStorage 数据并迁移
   */
  async function loadRemoteAgentsFromDisk(): Promise<RemoteAgentConfig[]> {
    try {
      const api = tryGetHostAPI()
      if (!api?.orchestratorReadRemoteConfigs) {
        // 非 Electron 环境，回退 localStorage
        return loadRemoteAgentsFromLegacyStorage()
      }

      const result = await api.orchestratorReadRemoteConfigs()
      const configs = result?.configs
      if (result?.success && configs && configs.length > 0) {
        return configs
      }

      // 首次读取为空 → 从 localStorage 迁移
      const legacyConfigs = loadRemoteAgentsFromLegacyStorage()
      if (legacyConfigs.length > 0) {
        // 逐项写入磁盘
        for (const config of legacyConfigs) {
          await saveRemoteAgent(config)
        }
        // 清除 localStorage
        localStorage.removeItem('chat-remote-agents')
      }
      return legacyConfigs
    } catch (err) {
      console.error('从磁盘加载远程Agent配置失败:', err)
      return loadRemoteAgentsFromLegacyStorage()
    }
  }

  /**
   * 从 localStorage 加载（旧方式，迁移回退用）
   */
  function loadRemoteAgentsFromLegacyStorage(): RemoteAgentConfig[] {
    try {
      const saved = localStorage.getItem('chat-remote-agents')
      if (saved) {
        const agents: RemoteAgentConfig[] = JSON.parse(saved)
        return agents.map(agent => ({
          ...agent,
          name: agent.name || agent.agentCard?.name,
          description: agent.description || agent.agentCard?.description
        }))
      }
    } catch (err) {
      console.error('加载远程Agent配置失败:', err)
    }
    return []
  }

  /**
   * 通过 IPC 保存单个远程 Agent 配置到磁盘
   */
  async function saveRemoteAgent(config: RemoteAgentConfig): Promise<void> {
    const api = tryGetHostAPI()
    if (!api?.orchestratorWriteRemoteConfig) return

    let key: string | null = null
    if (config.type === 'coze' && config.bot_id) {
      key = `coze-${config.bot_id}`
    } else if (config.url) {
      key = await computeA2AKey(config.url)
    }

    if (key) {
      await api.orchestratorWriteRemoteConfig(key, config)
    }
  }

  /**
   * 通过 IPC 删除单个远程 Agent 配置
   */
  async function deleteRemoteAgentByKey(key: string): Promise<void> {
    const api = tryGetHostAPI()
    if (!api?.orchestratorDeleteRemoteConfig) return

    await api.orchestratorDeleteRemoteConfig(key)
  }
  
  /**
   * 将MCP工具转换为ExecutableResource
   */
  async function convertToolsToResources(): Promise<ExecutableResource[]> {
    try {
      const mcpService = getMCPService()
      const tools = await mcpService.getOpenAITools()
      
      return tools.map((tool: ToolDefinition & { serverName?: string }): ExecutableResource => {
        const toolName = tool.function?.name || 'unknown-tool'
        const toolDescription = tool.function?.description || ''
        
        const config: ToolConfig = {
          type: 'tool',
          serverName: tool.serverName || 'unknown',
          toolDefinition: tool
        }
        
        return {
          id: `tool-${toolName}-${Date.now()}`,
          name: toolName,
          description: toolDescription,
          type: 'tool',
          capabilities: ['tool_execution'],
          config,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      })
    } catch (err) {
      console.error('转换MCP工具失败:', err)
      return []
    }
  }
  
  /**
   * 将远程Agent配置转换为ExecutableResource
   */
  function convertRemoteAgentsToResources(remoteAgentConfigs: RemoteAgentConfig[]): ExecutableResource[] {
    return remoteAgentConfigs.map((config, index): ExecutableResource => {
      // 判断是否为Coze类型
      if (config.type === 'coze') {
        const agentName = config.agentCard?.name || `扣子Agent-${index + 1}`
        const agentDescription = config.agentCard?.description || `扣子Agent: ${config.bot_id}`
        
        return {
          id: `remote-agent-${config.bot_id || `coze-${index}`}`,
          name: agentName,
          description: agentDescription,
          type: 'remote_agent',
          capabilities: ['coze_chat'],
          config,
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }
      
      // A2A类型
      const agentName = config.agentCard?.name || `远程Agent-${index + 1}`
      const agentDescription = config.agentCard?.description || `A2A远程Agent服务: ${config.url}`
      
      return {
        id: `remote-agent-${config.url ? btoa(config.url).replace(/[^a-z0-9]/gi, '').substring(0, 20) : `a2a-${index}`}`,
        name: agentName,
        description: agentDescription,
        type: 'remote_agent',
        capabilities: config.agentCard?.skills?.map(s => s.id) || ['a2a_execution'],
        config,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
    })
  }
  
  // ==================== Actions ====================
  
  /**
   * 加载所有资源
   * 整合本地Agent、MCP工具和远程Agent
   */
  async function loadResources(): Promise<void> {
    try {
      isLoading.value = true
      error.value = null
      
      // 通过 IPC 从磁盘加载远程 Agent 配置并更新 remoteAgents ref
      const remoteAgentConfigs = await loadRemoteAgentsFromDisk()
      remoteAgents.value = remoteAgentConfigs
      
      // 加载 MCP 工具资源
      const tools = await convertToolsToResources()

      // 转换远程Agent配置
      const remoteAgentResources = convertRemoteAgentsToResources(remoteAgentConfigs)

      // 合并所有资源（本地工作流 Agent 已退役，不再参与资源列表）
      resources.value = [...tools, ...remoteAgentResources]

    } catch (err) {
      error.value = err instanceof Error ? err.message : '加载资源失败'
      console.error('加载资源失败:', err)
    } finally {
      isLoading.value = false
    }
  }
  
  /**
   * 根据能力标签获取资源
   * @param capability 能力标签
   */
  function getResourcesByCapability(capability: string): ExecutableResource[] {
    return resources.value.filter(resource => 
      resource.enabled && resource.capabilities?.includes(capability)
    )
  }
  
  /**
   * 根据类型获取资源
   * @param type 资源类型
   */
  function getResourcesByType(type: ExecutableResourceType): ExecutableResource[] {
    return resources.value.filter(resource => 
      resource.enabled && resource.type === type
    )
  }
  
  /**
   * 根据ID获取资源
   * @param id 资源ID
   */
  function getResourceById(id: string): ExecutableResource | undefined {
    return resources.value.find(r => r.id === id)
  }
  
  /**
   * 删除远程Agent配置
   * @param config 远程Agent配置（需包含 type/bot_id 或 url 字段）
   */
  async function deleteRemoteAgent(config: RemoteAgentConfig): Promise<void> {
    let key: string | null = null
    if (config.type === 'coze' && config.bot_id) {
      key = `coze-${config.bot_id}`
    } else if (config.url) {
      key = await computeA2AKey(config.url)
    }

    if (key) {
      await deleteRemoteAgentByKey(key)
    }
    
    // 重新加载资源
    await loadResources()
  }

  /**
   * 保存远程Agent配置到存储（兼容旧调用，现改为通过 IPC 逐个保存）
   */
  async function saveRemoteAgents(): Promise<void> {
    for (const agent of remoteAgents.value) {
      await saveRemoteAgent(agent)
    }
  }
  
  /**
   * 启用/禁用资源
   * @param id 资源ID
   * @param enabled 是否启用
   */
  function setResourceEnabled(id: string, enabled: boolean): void {
    const resource = resources.value.find(r => r.id === id)
    if (resource) {
      resource.enabled = enabled
      resource.updatedAt = Date.now()
    }
  }
  
  /**
   * 刷新资源（重新加载）
   */
  async function refreshResources(): Promise<void> {
    await loadResources()
  }
  
  /**
   * 清空资源
   */
  function clearResources(): void {
    resources.value = []
  }
  
  // ==================== Return ====================
  
  return {
    // State
    resources,
    isLoading,
    error,
    remoteAgents,

    // Getters
    allResources,
    enabledResources,
    remoteAgentResources,
    toolResources,
    resourceCount,

    // Actions
    loadResources,
    getResourcesByCapability,
    getResourcesByType,
    getResourceById,
    deleteRemoteAgent,
    saveRemoteAgents,
    setResourceEnabled,
    refreshResources,
    clearResources
  }
})
