import { TemplateType } from '../types'
import type { SubagentTemplate } from '../types'
import type { AvailableSubagent } from '../types'

const TYPE_MAPPING: Record<string, { templateType: AvailableSubagent['templateType']; priorityLevel: number; priorityScope: string }> = {
  [TemplateType.BUILTIN]: { templateType: 'builtin', priorityLevel: 3, priorityScope: 'builtin' },
  [TemplateType.CUSTOM]: { templateType: 'custom', priorityLevel: 2, priorityScope: 'project' },
  [TemplateType.REMOTE_MCP]: { templateType: 'remote-mcp', priorityLevel: 4, priorityScope: 'remote' },
  [TemplateType.REMOTE_API]: { templateType: 'remote-api', priorityLevel: 4, priorityScope: 'remote' },
}

const FALLBACK = TYPE_MAPPING[TemplateType.BUILTIN]

export function convertTemplateToAvailableSubagent(t: SubagentTemplate): AvailableSubagent {
  const mapping = (t.type !== undefined ? TYPE_MAPPING[t.type] : undefined) ?? FALLBACK

  return {
    type: t.subagent_type,
    name: t.name,
    description: t.description || '',
    capabilities: t.tags || [],
    applicableScenarios: t.tags || [],
    templateType: mapping.templateType,
    priorityLevel: mapping.priorityLevel,
    priorityScope: mapping.priorityScope,
    model: t.model,
    tools: t.tools,
    defaultParameters: t.default_parameters
      ? {
          maxIterations: t.default_parameters.max_iterations,
          tokenBudget: t.default_parameters.token_budget,
          timeout: t.default_parameters.timeout,
          temperature: t.default_parameters.temperature,
        }
      : undefined,
    bridgeProtocol: t.bridge_protocol,
    bridgeConfig: t.bridge_config,
    isOverridable: t.is_overridable,
  }
}
