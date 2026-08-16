import type { CliContext } from '../context/CliContext.js'
import type { MCPConfigPersistence } from '@assistant-ai/core'

type ConnectStep = 0 | 1 | 2 | 3 | 4 | 5

export class CliMcpService {
  private ctx: CliContext
  private persistence: MCPConfigPersistence
  private connectStep: ConnectStep = 0
  private connectTransportType: string = ''
  private connectConfig: Record<string, any> = {}

  constructor(ctx: CliContext, persistence: MCPConfigPersistence) {
    this.ctx = ctx
    this.persistence = persistence
  }

  cancelConnect(): void {
    if (this.connectStep > 0) {
      this.connectStep = 0
      process.stdout.write('已取消连接向导\n')
    }
  }

  async handleCommand(input: string): Promise<string | null> {
    if (this.connectStep > 0) {
      return this.handleConnectInput(input)
    }

    const parts = input.trim().split(/\s+/)
    const sub = parts[0]

    switch (sub) {
      case 'connect':
        return this.startConnect()
      case 'disconnect':
        await this.disconnect(parts[1])
        return null
      case 'list':
        await this.list()
        return null
      case 'tools':
        await this.tools(parts[1])
        return null
      default:
        process.stdout.write(`未知 MCP 命令: ${sub}\n`)
        process.stdout.write('可用命令: connect, disconnect <id>, list, tools [id]\n')
        return null
    }
  }

  private startConnect(): string {
    this.connectStep = 1
    this.connectTransportType = ''
    this.connectConfig = {}
    process.stdout.write('--- MCP 连接向导 (空输入取消) ---\n')
    return '传输类型 (stdio/http): '
  }

  private async handleConnectInput(input: string): Promise<string | null> {
    // 步骤 4（stdio 参数）和步骤 5（HTTP Headers）允许空输入
    const allowsEmptyInput =
      (this.connectStep === 4 && this.connectTransportType === 'stdio') ||
      this.connectStep === 5

    if (input === '' && !allowsEmptyInput) {
      this.connectStep = 0
      process.stdout.write('已取消连接\n')
      return null
    }

    switch (this.connectStep) {
      case 1: {
        const t = input.trim().toLowerCase()
        if (!['stdio', 'http'].includes(t)) {
          process.stdout.write('无效的传输类型，请输入 stdio 或 http\n')
          return '传输类型 (stdio/http): '
        }
        this.connectTransportType = t
        this.connectStep = 2
        return '连接名称: '
      }
      case 2: {
        const name = input.trim()
        if (!name) {
          process.stdout.write('连接名称不能为空\n')
          return '连接名称: '
        }
        this.connectConfig.name = name
        if (this.connectTransportType === 'stdio') {
          this.connectStep = 3
          return '命令: '
        } else {
          this.connectStep = 4
          return 'URL: '
        }
      }
      case 3: {
        const command = input.trim()
        if (!command) {
          process.stdout.write('命令不能为空\n')
          return '命令: '
        }
        this.connectConfig.command = command
        this.connectStep = 4
        return '参数（用空格分隔，无参数直接回车）: '
      }
      case 4: {
        if (this.connectTransportType === 'stdio') {
          this.connectConfig.args = input.trim() ? input.trim().split(/\s+/) : []
          return this.doConnect()
        } else {
          const url = input.trim()
          if (!url) {
            process.stdout.write('URL 不能为空\n')
            return 'URL: '
          }
          this.connectConfig.url = url
          this.connectStep = 5
          return 'Headers（格式 "Key: Value"，多个用逗号分隔，无则直接回车）: '
        }
      }
      case 5: {
        const headersInput = input.trim()
        if (headersInput) {
          const headers: Record<string, string> = {}
          const pairs = headersInput.split(',').map(s => s.trim())
          for (const pair of pairs) {
            const colonIdx = pair.indexOf(':')
            if (colonIdx > 0) {
              headers[pair.slice(0, colonIdx).trim()] = pair.slice(colonIdx + 1).trim()
            }
          }
          this.connectConfig.headers = headers
        }
        return this.doConnect()
      }
      default:
        this.connectStep = 0
        return null
    }
  }

  private async doConnect(): Promise<string | null> {
    this.connectStep = 0
    const result = await this.ctx.mcpClient.connectWithId(this.connectConfig as any)
    if (result.success) {
      const servers = await this.persistence.loadServers()
      const idx = servers.findIndex((s: any) => s.name === this.connectConfig.name)
      if (idx >= 0) {
        servers[idx] = this.connectConfig as any
      } else {
        servers.push(this.connectConfig as any)
      }
      await this.persistence.saveServers(servers)

      // 同步连接状态到 state.json，与 UI 端保持一致
      const states = this.persistence.loadStates()
      const name = this.connectConfig.name || ''
      states[name] = { connected: true, lastConnected: Date.now() }
      this.persistence.saveStates(states)

      process.stdout.write(`MCP 连接成功: ${result.connectionId} (${result.transportType})\n`)
    } else {
      process.stdout.write(`MCP 连接失败: ${result.error}\n`)
    }
    return null
  }

  private async disconnect(id?: string): Promise<void> {
    if (!id) {
      process.stdout.write('用法: disconnect <连接ID>\n')
      return
    }

    const result = await this.ctx.mcpClient.disconnectWithId(id)
    if (result.success) {
      const servers = await this.persistence.loadServers()
      // 保持所有已保存的服务器配置，只更新连接状态
      const remainingResult = await this.ctx.mcpClient.listConnections()
      const connectedNames = new Set(
        (remainingResult.connections || []).map((c: any) => c.name).filter(Boolean)
      )

      const states = this.persistence.loadStates()
      for (const server of servers) {
        const name = server.name || ''
        states[name] = {
          connected: connectedNames.has(name),
          lastConnected: states[name]?.lastConnected
        }
      }
      this.persistence.saveStates(states)

      process.stdout.write(`MCP 连接 ${id} 已断开\n`)
    } else {
      process.stdout.write(`断开失败: ${result.error}\n`)
    }
  }

  private async list(): Promise<void> {
    const activeResult = await this.ctx.mcpClient.listConnections()
    const activeMap = new Map<string, any>()
    if (activeResult.success && activeResult.connections) {
      for (const conn of activeResult.connections) {
        activeMap.set(conn.name || conn.connectionId, conn)
      }
    }

    const savedServers = await this.persistence.loadServers()
    if (savedServers.length === 0 && activeMap.size === 0) {
      process.stdout.write('暂无 MCP 服务器\n')
      return
    }

    for (const server of savedServers) {
      const active = activeMap.get(server.name || '')
      const status = active ? active.status : 'disconnected'
      const connId = active ? active.connectionId : '-'
      const transportType = server.transportType || server.command ? 'stdio' : server.url ? 'http' : '?'
      process.stdout.write(`  ${connId}  ${server.name || 'unnamed'}  ${transportType}  ${status}\n`)
      if (active) activeMap.delete(server.name || '')
    }

    // 显示有活跃连接但无对应保存配置的连接（临时手动连接等）
    for (const [name, conn] of activeMap) {
      process.stdout.write(`  ${conn.connectionId}  ${name}  ${conn.transportType}  ${conn.status}\n`)
    }
  }

  private async tools(id?: string): Promise<void> {
    try {
      const result = await this.ctx.mcpClient.listTools(id)
      if (!result.success || !result.tools || result.tools.length === 0) {
        process.stdout.write('暂无可用工具\n')
        return
      }

      const connId = result.connectionId || id || '当前连接'
      process.stdout.write(`[${connId}] 工具列表:\n`)
      for (const tool of result.tools as any[]) {
        const toolName = tool.function?.name || tool.name || '未知'
        const toolDesc = tool.function?.description || tool.description || ''
        process.stdout.write(`  ${toolName}  ${toolDesc}\n`)
      }
    } catch {
      process.stdout.write('获取工具列表失败\n')
    }
  }
}
