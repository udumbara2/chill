import type { RemoteAgentConfig } from '../../types/workflow'
import type { SubagentTemplate } from '../types'
import { SubagentTemplateManager } from '../managers/SubagentTemplateManager'
import { CozeTemplateGenerator } from './templateGenerators/CozeTemplateGenerator'
import { A2ATemplateGenerator } from './templateGenerators/A2ATemplateGenerator'
export class RemoteAgentRegistrar {
  private templateManager: SubagentTemplateManager

  private cozeGenerator = new CozeTemplateGenerator()

  private a2aGenerator = new A2ATemplateGenerator()

  private previousAgents: RemoteAgentConfig[] = []

  private onTemplatesReloaded?: (remoteTemplates: SubagentTemplate[], allTemplates: SubagentTemplate[]) => void

  constructor(
    templateManager: SubagentTemplateManager,
    onTemplatesReloaded?: (remoteTemplates: SubagentTemplate[], allTemplates: SubagentTemplate[]) => void
  ) {
    this.templateManager = templateManager
    this.onTemplatesReloaded = onTemplatesReloaded
  }

  async handleAgentsChanged(newAgents: RemoteAgentConfig[]): Promise<void> {
    try {
      const prevAgents = this.previousAgents.length > 0 ? this.previousAgents : []

      const changes = await this.detectChanges(prevAgents, newAgents || [])

      await this.handleChanges(changes)

      this.previousAgents = JSON.parse(JSON.stringify(newAgents || []))
    } catch (error) {
      console.error('[RemoteAgentRegistrar] 处理 remoteAgents 变化时出错:', error)
    }
  }

  private async detectChanges(
    oldAgents: RemoteAgentConfig[],
    newAgents: RemoteAgentConfig[]
  ): Promise<Array<{
    type: 'added' | 'removed' | 'modified'
    agent: RemoteAgentConfig
    subagentType: string
  }>> {
    const changes: Array<{
      type: 'added' | 'removed' | 'modified'
      agent: RemoteAgentConfig
      subagentType: string
    }> = []

    const getAgentId = async (agent: RemoteAgentConfig): Promise<string> => {
      if (agent.type === 'coze') {
        return agent.bot_id ? `coze-${agent.bot_id}` : ''
      }
      return await this.generateA2AId(agent.url || '')
    }

    const oldAgentMap = new Map<string, RemoteAgentConfig>()
    for (const agent of oldAgents) {
      const id = await getAgentId(agent)
      if (id) oldAgentMap.set(id, agent)
    }

    const newAgentMap = new Map<string, RemoteAgentConfig>()
    for (const agent of newAgents) {
      const id = await getAgentId(agent)
      if (id) newAgentMap.set(id, agent)
    }

    for (const [id, newAgent] of newAgentMap) {
      const oldAgent = oldAgentMap.get(id)
      if (!oldAgent) {
        changes.push({
          type: 'added',
          agent: newAgent,
          subagentType: id,
        })
      } else {
        const oldJson = JSON.stringify(oldAgent)
        const newJson = JSON.stringify(newAgent)
        if (oldJson !== newJson) {
          changes.push({
            type: 'modified',
            agent: newAgent,
            subagentType: id,
          })
        }
      }
    }

    for (const [id, oldAgent] of oldAgentMap) {
      if (!newAgentMap.has(id)) {
        changes.push({
          type: 'removed',
          agent: oldAgent,
          subagentType: id,
        })
      }
    }

    return changes
  }

  private async handleChanges(
    changes: Array<{
      type: 'added' | 'removed' | 'modified'
      agent: RemoteAgentConfig
      subagentType: string
    }>
  ): Promise<void> {
    for (const change of changes) {
      try {
        switch (change.type) {
          case 'added':
            await this.generateTemplate(change.agent, change.subagentType)
            break
          case 'modified':
            await this.generateTemplate(change.agent, change.subagentType)
            break
          case 'removed':
            await this.deleteTemplate(change.subagentType)
            break
        }
      } catch (error) {
        console.error(`[RemoteAgentRegistrar] 处理变化失败 (${change.type} ${change.subagentType}):`, error)
      }
    }

    if (changes.length > 0) {
      await this.reloadTemplates()
    }
  }

  private async generateTemplate(agent: RemoteAgentConfig, _subagentType: string): Promise<void> {
    try {
      let template: SubagentTemplate

      if (agent.type === 'coze') {
        template = await this.cozeGenerator.generateTemplateObject(agent)
      } else {
        template = await this.a2aGenerator.generateTemplateObject(agent)
      }

      this.templateManager.registerRemoteTemplate(template)
    } catch (error) {
      console.error(`[RemoteAgentRegistrar] 注册远程模板失败 (${_subagentType}):`, error)
    }
  }

  private async deleteTemplate(subagentType: string): Promise<void> {
    try {
      this.templateManager.unregisterRemoteTemplate(subagentType)
    } catch (error) {
      console.error(`[RemoteAgentRegistrar] 注销远程模板失败 (${subagentType}):`, error)
    }
  }

  private async generateA2AId(url: string): Promise<string> {
    const encoder = new TextEncoder()
    const data = encoder.encode(url)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    return `a2a-${hashHex.substring(0, 16)}`
  }

  private async reloadTemplates(): Promise<void> {
    try {
      if (this.onTemplatesReloaded) {
        const remoteTemplates = this.templateManager.getRemoteTemplates()
        const allTemplates = this.templateManager.getAllTemplates()
        this.onTemplatesReloaded(remoteTemplates, allTemplates)
      }
    } catch (error) {
      console.error('[RemoteAgentRegistrar] 模板重载回调失败:', error)
    }
  }
}
