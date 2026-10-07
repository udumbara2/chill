import type { ExecutableResource, ExecutableResourceType, ToolDefinition } from '@assistant-ai/core'
import { getBuiltInTools, MCPService, ToolRegistry, ToolExecutorFactory } from '@assistant-ai/core'
import type { BuiltInToolExecutor, ISecureStorage } from '@assistant-ai/core'
export { convertResourceToOpenAITool, convertResourcesToOpenAITools } from '@assistant-ai/core'

export interface ResourceToolAdapterDeps {
  getCurrentDirectory: () => string | null
  getMCPToolsEnabled: () => boolean
  getEnabledResources: () => ExecutableResource[]
  loadResources: () => Promise<void>
  getMCPStore: () => { getMCPToolsEnabled: () => boolean }
  builtInExecutor: BuiltInToolExecutor
  secureStorage?: ISecureStorage
}

export async function prepareAllResources(deps: ResourceToolAdapterDeps): Promise<{ tools: ToolDefinition[]; registry: ToolRegistry }> {
  const { convertResourcesToOpenAITools } = await import('@assistant-ai/core')

  const registry = new ToolRegistry()

  if (deps.getEnabledResources().length === 0) {
    await deps.loadResources()
  }

  // 本地工作流 Agent（local_agent）已退役，仅剩远程 Agent 资源
  const agentResources = deps.getEnabledResources().filter(
    r => r.type === 'remote_agent'
  )

  const agentTools = convertResourcesToOpenAITools(agentResources)

  const allBuiltInTools = getBuiltInTools()

  const hasDirectory = !!deps.getCurrentDirectory()

  const writingTools = ['get_current_directory', 'list_files']
  const builtInTools = hasDirectory
    ? allBuiltInTools
    : allBuiltInTools.filter(t => !writingTools.includes(t.function.name))

  let mcpTools: ToolDefinition[] = []
  if (deps.getMCPToolsEnabled()) {
    try {
      const mcpService = new MCPService()
      mcpService.setMCPStoreGetter(deps.getMCPStore)
      mcpTools = await mcpService.getOpenAITools()
    } catch (error) {
      console.warn('获取MCP工具失败:', error)
    }
  }

  for (const tool of builtInTools) {
    const executor = ToolExecutorFactory.createByName(tool.function.name, 'builtin', undefined, deps.builtInExecutor)
    registry.register(executor)
  }

  for (const tool of mcpTools) {
    const executor = ToolExecutorFactory.createByName(tool.function.name, 'mcp')
    registry.register(executor)
  }

  for (const resource of agentResources) {
    try {
      const executor = ToolExecutorFactory.create(resource, undefined, deps.secureStorage)
      registry.register(executor)
    } catch (error) {
      console.warn(`注册Agent资源失败: ${resource.name}`, error)
    }
  }

  const tools = [...builtInTools, ...mcpTools, ...agentTools]

  return { tools, registry }
}

export async function prepareChatTools(deps: ResourceToolAdapterDeps): Promise<{ tools: ToolDefinition[]; registry: ToolRegistry }> {
  const registry = new ToolRegistry()

  const allBuiltInTools = getBuiltInTools()

  const hasDirectory = !!deps.getCurrentDirectory()

  const writingTools = ['get_current_directory', 'list_files']
  const builtInTools = hasDirectory
    ? allBuiltInTools
    : allBuiltInTools.filter(t => !writingTools.includes(t.function.name))

  let mcpTools: ToolDefinition[] = []
  if (deps.getMCPToolsEnabled()) {
    try {
      const mcpService = new MCPService()
      mcpService.setMCPStoreGetter(deps.getMCPStore)
      mcpTools = await mcpService.getOpenAITools()
    } catch (error) {
      console.warn('获取MCP工具失败:', error)
    }
  }

  for (const tool of builtInTools) {
    const executor = ToolExecutorFactory.createByName(tool.function.name, 'builtin', undefined, deps.builtInExecutor)
    registry.register(executor)
  }

  for (const tool of mcpTools) {
    const executor = ToolExecutorFactory.createByName(tool.function.name, 'mcp')
    registry.register(executor)
  }

  const tools = [...builtInTools, ...mcpTools]

  return { tools, registry }
}

export async function prepareResourcesByType(
  types: ExecutableResourceType[],
  deps: Pick<ResourceToolAdapterDeps, 'loadResources' | 'getEnabledResources'>
): Promise<ToolDefinition[]> {
  const { convertResourcesToOpenAITools } = await import('@assistant-ai/core')

  if (deps.getEnabledResources().length === 0) {
    await deps.loadResources()
  }

  const filteredResources = deps.getEnabledResources().filter(r =>
    types.includes(r.type)
  )

  return convertResourcesToOpenAITools(filteredResources)
}
