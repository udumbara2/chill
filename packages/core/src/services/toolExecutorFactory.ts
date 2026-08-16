import type { ExecutableResource } from '../types/workflow'
import type { ExecutableTool } from './toolExecutorRegistry'
import { MCPTool, BuiltInTool, LocalAgentTool, RemoteAgentTool } from './toolExecutors'
import type { Message } from '../types/models'
import type { BuiltInToolExecutor } from './builtInToolExecutor'
import type { ILocalAgentExecutor } from '../interfaces/ILocalAgentExecutor'
import type { ISecureStorage } from '../interfaces/ISecureStorage'

export class ToolExecutorFactory {
  static create(
    resource: ExecutableResource,
    messages?: Message[],
    localExecutor?: ILocalAgentExecutor,
    secureStorage?: ISecureStorage
  ): ExecutableTool {
    switch (resource.type) {
      case 'tool':
        return new MCPTool(resource.name, messages)

      case 'local_agent':
        if (!localExecutor) {
          throw new Error('localExecutor is required for local_agent')
        }
        return new LocalAgentTool(resource, localExecutor)

      case 'remote_agent':
        if (!secureStorage) {
          throw new Error('secureStorage is required for remote_agent')
        }
        return new RemoteAgentTool(resource, secureStorage)

      default:
        throw new Error(`Unknown resource type: ${resource.type}`)
    }
  }

  static createByName(name: string, type: string, messages?: Message[], builtInExecutor?: BuiltInToolExecutor): ExecutableTool {
    switch (type) {
      case 'builtin':
        if (!builtInExecutor) {
          throw new Error('builtInExecutor is required for builtin tools')
        }
        return new BuiltInTool(name, undefined, builtInExecutor)

      case 'mcp':
        return new MCPTool(name, messages)

      default:
        throw new Error(`Unknown tool type: ${type}`)
    }
  }
}
