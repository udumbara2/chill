import type { SubagentTemplate } from '../types/workflow'

export interface ITemplateLoader {
  loadBuiltinTemplates(): Promise<SubagentTemplate[]>
}
