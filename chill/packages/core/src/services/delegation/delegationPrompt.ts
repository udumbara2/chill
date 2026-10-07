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
import { resolveAgentToolPolicy } from '../../orchestrator/toolPolicy'

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

      // 工具权限展示经 resolveAgentToolPolicy 渲染（与执行侧同一解析器）：
      // readonly → 只读标注；默认名单 → 名单原文(可被 available_tools 覆盖);
      // 未声明(零默认) → 显式告知"默认不使用工具",防 Lead 盲视
      const toolPolicy = resolveAgentToolPolicy({
        type: subagent.templateType,
        tools: subagent.tools,
        disallowed_tools: subagent.disallowedTools,
        readonly: subagent.readonly,
      })
      if (toolPolicy?.readonly) {
        text += `- 工具权限: 只读 agent（修改性工具不可用，available_tools 请勿指派写工具）\n`
      } else if (toolPolicy?.whitelist && toolPolicy.whitelist.size > 0) {
        text += `- 默认工具: ${[...toolPolicy.whitelist].join(', ')}（模板默认名单；不指定 available_tools 按此名单，显式指派则覆盖）\n`
      } else if (toolPolicy?.whitelist && toolPolicy.whitelist.size === 0) {
        text += `- 默认工具: 无（模板未声明 tools，默认不使用任何工具；如任务确需，请显式指派 available_tools）\n`
      } else if (!toolPolicy && (!subagent.templateType || subagent.templateType === 'builtin' || subagent.templateType === 'custom')) {
        // 本地模板显式 [all]（policy null = 不限制；远程模板策略不适用,不展示）
        text += `- 默认工具: 全部（模板声明 tools: [all]；显式指派 available_tools 可收窄）\n`
      }
      if (toolPolicy && toolPolicy.disallowed.size > 0) {
        text += `- 禁用工具: ${[...toolPolicy.disallowed].join(', ')}\n`
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
