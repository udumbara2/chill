import type { MCPServerConfig, TransportType } from '../../types/mcp'

/**
 * 宿主环境探测回调（T7 原则 2：core 不直接探测 window.electronAPI）。
 * Electron 壳（UI 渲染进程）装配时经 setEnvironmentProbe 注入；
 * CLI/Node 宿主不注入则一律视为非 electron 环境。
 */
export interface EnvironmentProbe {
  /** 当前是否在 Electron 渲染进程（存在桥接 API） */
  isElectron(): boolean
  /** 取主进程桥接 API（isElectron 为 true 时必须提供） */
  getMainProcessApi?(): unknown
}

let environmentProbe: EnvironmentProbe | null = null

/** 注入宿主环境探测回调（传 null 复位为非 electron 环境） */
export function setEnvironmentProbe(probe: EnvironmentProbe | null): void {
  environmentProbe = probe
}

/** 当前是否在 Electron 渲染进程（未注入探测回调时恒 false） */
export function isElectronHost(): boolean {
  try {
    return environmentProbe?.isElectron() ?? false
  } catch {
    return false
  }
}

/** 取主进程桥接 API（非 electron 环境或未提供时抛错） */
export function getMainProcessApiFromHost(): unknown {
  if (isElectronHost() && environmentProbe?.getMainProcessApi) {
    return environmentProbe.getMainProcessApi()
  }
  throw new Error('不在Electron环境中运行，无法访问主进程API')
}

/**
 * MCP传输类型检测器
 * 负责检测配置中指定的传输类型，支持自动检测
 */
export class TransportDetector {
  /**
   * 检测配置中的传输类型
   * @param config MCP服务器配置
   * @returns 检测到的传输类型
   */
  static detect(config: MCPServerConfig): TransportType {
    // 1. 如果配置明确指定了传输类型（非auto），直接返回
    if (config.transportType && config.transportType !== 'auto') {
      return config.transportType
    }
    
    // 2. 如果配置为auto或者未指定，进行自动检测
    if (this.hasValidStdioConfig(config)) {
      return 'stdio'
    }
    
    if (this.hasValidHttpConfig(config)) {
      return 'http'
    }
    
    // 3. 默认返回HTTP（向后兼容）
    return 'http'
  }
  
  /**
   * 检查配置是否包含有效的stdio配置
   * @param config MCP服务器配置
   * @returns 是否包含有效的stdio配置
   */
  private static hasValidStdioConfig(config: MCPServerConfig): boolean {
    return Boolean(
      config.command && 
      config.command.trim().length > 0 &&
      config.command !== 'your-command-here' // 排除示例值
    )
  }
  
  /**
   * 检查配置是否包含有效的HTTP配置
   * @param config MCP服务器配置
   * @returns 是否包含有效的HTTP配置
   */
  private static hasValidHttpConfig(config: MCPServerConfig): boolean {
    if (!config.url) return false
    
    try {
      new URL(config.url)
      return true
    } catch {
      return false
    }
  }
  
  /**
   * 获取配置的描述信息，用于调试和日志
   * @param config MCP服务器配置
   * @returns 配置描述信息
   */
  static getConfigDescription(config: MCPServerConfig): string {
    const transportType = this.detect(config)
    const serverName = config.name || 'unnamed-server'
    
    switch (transportType) {
      case 'stdio':
        return `stdio服务器 "${serverName}" (command: ${config.command})`
      case 'http':
        return `HTTP服务器 "${serverName}" (url: ${config.url})`
      default:
        return `未知传输类型服务器 "${serverName}"`
    }
  }
}

/**
 * Electron环境下的传输检测器
 * 专门处理Electron环境下的传输检测和环境判断
 */
export class ElectronTransportDetector {
  /**
   * 检测当前运行环境
   * @param config MCP服务器配置
   * @returns 运行环境类型
   */
  static detectEnvironment(config: MCPServerConfig): 'main-process' | 'renderer-process' {
    // 检测是否在Electron环境中运行
    const isElectron = this.isElectronEnvironment()
    
    if (!isElectron) {
      throw new Error('当前不在Electron环境中运行')
    }
    
    // 根据传输类型和配置决定运行环境
    const transportType = TransportDetector.detect(config)
    
    if (transportType === 'stdio') {
      // stdio传输只能在主进程运行
      return 'main-process'
    }
    
    // HTTP传输也可以在主进程运行，为了架构一致性建议在主进程处理
    return 'main-process'
  }
  
  /**
   * 检测是否在Electron环境中
   * @returns 是否在Electron环境中
   */
  private static isElectronEnvironment(): boolean {
    return isElectronHost()
  }
  
  /**
   * 获取主进程API接口
   * @returns 主进程API接口
   */
  static getMainProcessApi() {
    return getMainProcessApiFromHost()
  }
  
  /**
   * 检查配置在当前环境下是否可行
   * @param config MCP服务器配置
   * @returns 检查结果
   */
  static checkConfigViability(config: MCPServerConfig): {
    viable: boolean
    reason: string
    suggestedAction?: string
  } {
    try {
      const environment = this.detectEnvironment(config)
      
      // 检查传输类型在当前环境下的可行性
      const transportType = TransportDetector.detect(config)
      
      if (transportType === 'stdio' && environment === 'renderer-process') {
        return {
          viable: false,
          reason: 'stdio传输无法在渲染进程中运行',
          suggestedAction: '请在主进程中运行此配置或切换到HTTP传输'
        }
      }
      
      return {
        viable: true,
        reason: `配置在${environment}环境下可行`
      }
    } catch (error) {
      return {
        viable: false,
        reason: error instanceof Error ? error.message : '未知环境错误'
      }
    }
  }
  
  /**
   * 获取Electron环境的详细诊断信息
   * @param config MCP服务器配置
   * @returns 诊断信息
   */
  static getEnvironmentDiagnostics(config: MCPServerConfig): {
    isElectron: boolean
    environment: 'main-process' | 'renderer-process' | 'unknown'
    transportType: TransportType
    configDescription: string
    viabilityCheck: {
      viable: boolean
      reason: string
      suggestedAction?: string
    }
  } {
    const isElectron = this.isElectronEnvironment()
    const environment = isElectron ? this.detectEnvironment(config) : 'unknown'
    const transportType = TransportDetector.detect(config)
    const configDescription = TransportDetector.getConfigDescription(config)
    const viabilityCheck = this.checkConfigViability(config)
    
    return {
      isElectron,
      environment,
      transportType,
      configDescription,
      viabilityCheck
    }
  }
}