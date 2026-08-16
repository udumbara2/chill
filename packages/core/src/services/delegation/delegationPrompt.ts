/**
 * 委派指南 prompt 格式化函数
 *
 * Subagent 列表 / 可用模型列表 / 工具元信息格式化的单一事实源：
 * T1 从旧调度器迁移至此，供 ChatEngine 委派指南 prompt 片段复用。
 *
 * 纯逻辑、无 Node 依赖，渲染进程可用（index.renderer.ts 导出）。
 */

import type {
  AvailableSubagent,
  AvailableModel,
  ToolMetadata,
} from '../../orchestrator/types'

/**
 * 将可用 Subagent 信息格式化为文本，用于注入到 System Prompt
 * @param subagents - 可用 Subagent 列表
 * @returns 格式化后的 Subagent 描述文本
 */
export function formatSubagentsForPrompt(subagents: AvailableSubagent[]): string {
  return subagents
    .map((subagent) => {
      let text = `### ${subagent.name}\n`
      text += `- **subagent_type**: "${subagent.type}"\n`
      if (subagent.templateType) {
        text += `- 类型: ${subagent.templateType}\n`
      }
      text += `- 描述: ${subagent.description}\n`

      if (subagent.capabilities && subagent.capabilities.length > 0) {
        text += `- 能力: ${subagent.capabilities.join(', ')}\n`
      }

      if (subagent.applicableScenarios && subagent.applicableScenarios.length > 0) {
        text += `- 适用场景: ${subagent.applicableScenarios.join(', ')}\n`
      }

      if (subagent.model) {
        text += `- 默认模型: ${subagent.model}\n`
      }

      if (subagent.tools && subagent.tools.length > 0) {
        text += `- 可用工具: ${subagent.tools.join(', ')}\n`
      }

      if (subagent.defaultParameters) {
        text += `- 默认参数:\n`
        const dp = subagent.defaultParameters
        if (dp.maxIterations !== undefined) {
          text += `  - 最大迭代次数: ${dp.maxIterations}\n`
        }
        if (dp.tokenBudget !== undefined) {
          text += `  - Token预算: ${dp.tokenBudget}\n`
        }
        if (dp.timeout !== undefined) {
          text += `  - 超时时间: ${dp.timeout}秒\n`
        }
        if (dp.temperature !== undefined) {
          text += `  - 温度: ${dp.temperature}\n`
        }
      }

      if (subagent.priorityLevel !== undefined) {
        text += `- 优先级: ${subagent.priorityLevel} (${subagent.priorityScope || 'unknown'})\n`
      }

      if (subagent.bridgeProtocol) {
        text += `- 桥接协议: ${subagent.bridgeProtocol}\n`
      }

      return text
    })
    .join('\n')
}

/**
 * 将可用模型信息格式化为文本，用于注入到 System Prompt
 * @param models - 可用模型列表
 * @returns 格式化后的模型描述文本
 */
export function formatModelsForPrompt(models: AvailableModel[]): string {
  return models
    .map((model, index) => {
      let description = `${index + 1}. **${model.name}**（${model.provider}）`
      if (model.description) {
        description += `：${model.description}`
      }
      if (model.capabilities && model.capabilities.length > 0) {
        description += `\n   - 核心能力：${model.capabilities.join(', ')}`
      }
      if (model.tokenConsumptionLevel) {
        description += `\n   - Token消耗：${model.tokenConsumptionLevel}`
      }
      if (model.responseSpeedLevel) {
        description += `\n   - 响应速度：${model.responseSpeedLevel}`
      }
      if (model.supportedFeatures && model.supportedFeatures.length > 0) {
        description += `\n   - 支持功能：${model.supportedFeatures.join(', ')}`
      }
      if (model.applicableScenarios && model.applicableScenarios.length > 0) {
        description += `\n   - 适用场景：${model.applicableScenarios.join(', ')}`
      }
      return description
    })
    .join('\n\n')
}

/**
 * 将工具元信息格式化为文本，用于注入到 System Prompt
 * @param toolMetadata - 工具元信息列表
 * @returns 格式化后的工具描述文本
 */
export function formatToolMetadataForPrompt(toolMetadata: ToolMetadata[]): string {
  return toolMetadata
    .map((tool, index) => {
      let description = `${index + 1}. **${tool.name}**：${tool.description}`
      if (tool.capability_tags && tool.capability_tags.length > 0) {
        description += `\n   - 能力标签：${tool.capability_tags.join(', ')}`
      }
      if (tool.resource_intensity) {
        description += `\n   - 资源消耗：${tool.resource_intensity}`
      }
      if (tool.applicable_scenarios && tool.applicable_scenarios.length > 0) {
        description += `\n   - 适配场景：${tool.applicable_scenarios.join(', ')}`
      }
      return description
    })
    .join('\n\n')
}
