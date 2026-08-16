import type { ExecutableResource, ToolConfig, RemoteAgentConfig } from '../types/workflow'
import type { ToolDefinition } from '../types/models'

export function convertResourceToOpenAITool(resource: ExecutableResource): ToolDefinition {
  const baseTool: ToolDefinition = {
    type: 'function',
    function: {
      name: '',
      description: '',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  }

  switch (resource.type) {
    case 'tool': {
      const toolConfig = resource.config as ToolConfig
      return toolConfig.toolDefinition
    }

    case 'local_agent':
      return {
        type: 'function',
        function: {
          name: `execute_local_agent_${sanitizeName(resource.name, resource.id)}`,
          description: `执行本地工作流 Agent: ${resource.description}\n\n这是一个本地 Agent，可以执行复杂的工作流任务。`,
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: '输入给 Agent 的任务描述或问题'
              },
              context: {
                type: 'object',
                description: '可选的上下文信息',
                additionalProperties: true
              }
            },
            required: ['input']
          }
        }
      }

    case 'remote_agent': {
      const remoteConfig = resource.config as RemoteAgentConfig
      return {
        type: 'function',
        function: {
          name: `execute_remote_agent_${sanitizeName(resource.name, resource.id)}`,
          description: `调用远程 A2A Agent: ${resource.description}\n\nAgent URL: ${remoteConfig.url}`,
          parameters: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: '发送给远程 Agent 的消息'
              },
              session_id: {
                type: 'string',
                description: '会话 ID（可选，不传则自动生成）'
              }
            },
            required: ['message']
          }
        }
      }
    }

    default:
      return baseTool
  }
}

export function convertResourcesToOpenAITools(resources: ExecutableResource[]): ToolDefinition[] {
  return resources
    .filter(resource => resource.enabled)
    .map(resource => convertResourceToOpenAITool(resource))
}

export function sanitizeName(name: string, id?: string): string {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  
  if (!sanitized) {
    if (id) {
      sanitized = 'agent_' + id.slice(-8)
    } else {
      sanitized = 'agent_' + Math.random().toString(36).substring(2, 10)
    }
  }
  
  return sanitized
}
