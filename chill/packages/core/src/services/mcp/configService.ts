import type { MCPServerConfig, ConfigValidationResult } from '../../types/mcp'
import { TransportDetector, ElectronTransportDetector, isElectronHost } from './transportDetector'

/**
 * MCP服务器配置解析服务
 */
export class ConfigService {
  /**
   * 解析用户输入的JSON配置
   * 支持多种格式：
   * 1. 标准格式: { "url": "...", "name": "..." } 或 { "command": "...", "args": [...] }
   * 2. mcpServers格式: { "mcpServers": { "server-name": { "url": "..." } } }
   * @param jsonString JSON配置字符串
   * @returns MCP服务器配置对象
   */
  parseConfig(jsonString: string): MCPServerConfig {
    try {
      const parsed = JSON.parse(jsonString)
      
      // 处理 mcpServers 嵌套格式
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        const serverKeys = Object.keys(parsed.mcpServers)
        if (serverKeys.length === 0) {
          throw new Error('mcpServers对象不能为空')
        }
        
        // 使用第一个服务器的配置
        const firstServerKey = serverKeys[0]
        const firstServerConfig = parsed.mcpServers[firstServerKey]
        
        return {
          // 基础字段
          name: firstServerConfig.name || firstServerKey,
          headers: firstServerConfig.headers || {},
          clientName: firstServerConfig.clientName || 'chill',
          clientVersion: firstServerConfig.clientVersion || '1.0.0',
          timeout: firstServerConfig.timeout || 10000,
          
          // 传输类型
          transportType: firstServerConfig.transportType || 'auto',
          
          // HTTP传输字段
          url: firstServerConfig.url,
          
          // stdio传输字段
          command: firstServerConfig.command,
          args: firstServerConfig.args,
          cwd: firstServerConfig.cwd,
          env: firstServerConfig.env
        }
      }
      
      // 处理标准单层格式 - 需要至少有一个传输类型的必需字段
      const hasHttpConfig = parsed.url
      const hasStdioConfig = parsed.command
      
      if (!hasHttpConfig && !hasStdioConfig) {
        throw new Error('配置必须包含至少一种传输类型的必需字段：url（HTTP传输）或command（stdio传输）')
      }
      
      // 验证HTTP配置的URL格式（如果提供了URL）
      if (parsed.url) {
        try {
          new URL(parsed.url)
        } catch {
          throw new Error('无效的URL格式')
        }
      }
      
      return {
        // 基础字段
        name: parsed.name || 'unnamed-server',
        headers: parsed.headers || {},
        clientName: parsed.clientName || 'chill',
        clientVersion: parsed.clientVersion || '1.0.0',
        timeout: parsed.timeout || 10000,
        
        // 传输类型
        transportType: parsed.transportType || 'auto',
        
        // HTTP传输字段
        url: parsed.url,
        
        // stdio传输字段
        command: parsed.command,
        args: parsed.args,
        cwd: parsed.cwd,
        env: parsed.env
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`JSON格式错误: ${error.message}`)
      }
      throw error
    }
  }
  
  /**
   * 验证配置对象
   * @param config 配置对象
   * @returns 验证结果
   */
  validateConfig(config: MCPServerConfig): { valid: boolean; error?: string } {
    if (!config.url) {
      return { valid: false, error: '配置必须包含url字段' }
    }
    
    try {
      new URL(config.url)
      return { valid: true }
    } catch {
      return { valid: false, error: '无效的URL格式' }
    }
  }

  /**
   * 扩展配置验证方法 - 支持HTTP和stdio传输类型
   * @param config MCP服务器配置
   * @returns 验证结果
   */
  validateExtendedConfig(config: MCPServerConfig): ConfigValidationResult {
    const transportType = TransportDetector.detect(config)
    
    try {
      switch (transportType) {
        case 'stdio':
          return this.validateStdioConfig(config)
        case 'http':
          return this.validateHttpConfig(config)
        default:
          return { valid: false, error: `不支持的传输类型: ${transportType}` }
      }
    } catch (error) {
      return { 
        valid: false, 
        error: `配置验证失败: ${error instanceof Error ? error.message : '未知错误'}` 
      }
    }
  }
  
  /**
   * 验证stdio配置
   * @param config MCP服务器配置
   * @returns 验证结果
   */
  private validateStdioConfig(config: MCPServerConfig): ConfigValidationResult {
    if (!config.command || config.command.trim().length === 0) {
      return { 
        valid: false, 
        transportType: 'stdio',
        error: 'stdio配置必须包含有效的command字段' 
      }
    }
    
    // Electron环境特有的验证
    if (isElectronHost()) {
      // 渲染进程验证：检查主进程API是否可用
      try {
        ElectronTransportDetector.getMainProcessApi()
      } catch {
        return {
          valid: false,
          transportType: 'stdio',
          error: '检测到Electron环境但无法访问主进程API，请检查electron-main.ts中的MCP服务配置'
        }
      }
      
      // 检查命令的安全性（渲染进程端的基本检查）
      if (this.isPotentiallyUnsafeCommand(config.command)) {
        return {
          valid: false,
          transportType: 'stdio',
          error: '检测到潜在不安全的命令执行，请确认命令的安全性'
        }
      }
    }
    
    return { valid: true, transportType: 'stdio' }
  }
  
  /**
   * 验证HTTP配置
   * @param config MCP服务器配置
   * @returns 验证结果
   */
  private validateHttpConfig(config: MCPServerConfig): ConfigValidationResult {
    if (!config.url) {
      return { 
        valid: false, 
        transportType: 'http',
        error: 'HTTP配置必须包含url字段' 
      }
    }
    
    try {
      new URL(config.url)
      return { valid: true, transportType: 'http' }
    } catch {
      return { 
        valid: false, 
        transportType: 'http',
        error: '无效的URL格式' 
      }
    }
  }
  
  /**
   * 基本的安全命令检查（渲染进程端）
   * @param command 要检查的命令
   * @returns 是否为潜在不安全命令
   */
  private isPotentiallyUnsafeCommand(command: string): boolean {
    const unsafePatterns = [
      /rm\s+-rf/i,
      /del\s+\//i,
      /format\s+/i,
      /dd\s+if=/i,
      />\s*\/dev\//i,
      /\|\s*sh\b/i,
      /\|\s*bash\b/i
    ]
    
    return unsafePatterns.some(pattern => pattern.test(command))
  }
}
