import { join } from 'path'
import * as fs from 'fs'
import type { IPathProvider } from '../interfaces/IPathProvider'

export interface AgentResult {
  success: boolean
  error?: string
}

export interface SaveAgentResult extends AgentResult {
  id?: string
}

export interface LoadAgentResult extends AgentResult {
  agent?: unknown
}

export interface AgentSummary {
  id: string
  name: string
  updatedAt: number
  sourceWorkflowId: string
  autoSyncEnabled: boolean
}

export interface ListAgentsResult extends AgentResult {
  agents?: AgentSummary[]
}

export class AgentFileManager {
  private agentsPath: string
  private onAgentSaved?: (agent: Record<string, unknown>) => void
  private onAgentDeleted?: (id: string) => void

  constructor(pathProvider: IPathProvider) {
    const userDataPath = pathProvider.getUserDataPath()
    this.agentsPath = join(userDataPath, 'agents', 'local')
    if (!fs.existsSync(this.agentsPath)) {
      fs.mkdirSync(this.agentsPath, { recursive: true })
    }

    const oldAgentsPath = join(userDataPath, 'agents')
    if (oldAgentsPath !== this.agentsPath && fs.existsSync(oldAgentsPath)) {
      const entries = fs.readdirSync(oldAgentsPath)
      const jsonFiles = entries.filter(f => f.endsWith('.json'))
      for (const file of jsonFiles) {
        const oldPath = join(oldAgentsPath, file)
        const newPath = join(this.agentsPath, file)
        if (fs.statSync(oldPath).isFile() && !fs.existsSync(newPath)) {
          fs.copyFileSync(oldPath, newPath)
          fs.unlinkSync(oldPath)
        }
      }
    }
  }

  setOnAgentSaved(callback: (agent: Record<string, unknown>) => void): void {
    this.onAgentSaved = callback
  }

  setOnAgentDeleted(callback: (id: string) => void): void {
    this.onAgentDeleted = callback
  }

  async saveAgent(agent: Record<string, unknown>): Promise<SaveAgentResult> {
    try {
      const metadata = agent.metadata as Record<string, unknown> | undefined
      const id = metadata?.id
      if (!id) {
        return { success: false, error: 'Agent ID is required' }
      }

      const fileName = `${id}.json`
      const filePath = join(this.agentsPath, fileName)
      fs.writeFileSync(filePath, JSON.stringify(agent, null, 2), 'utf-8')

      if (this.onAgentSaved) {
        try {
          this.onAgentSaved(agent)
        } catch {
          // 回调失败不影响保存
        }
      }

      return { success: true, id: String(id) }
    } catch (error: unknown) {
      console.error('Failed to save agent:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async loadAgent(id: string): Promise<LoadAgentResult> {
    try {
      const filePath = join(this.agentsPath, `${id}.json`)
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Agent not found' }
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const agent = JSON.parse(content)
      return { success: true, agent }
    } catch (error: unknown) {
      console.error('Failed to load agent:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async listAgents(): Promise<ListAgentsResult> {
    try {
      const files = fs.readdirSync(this.agentsPath)
      const agents: AgentSummary[] = files
        .filter(file => file.endsWith('.json') && !file.startsWith('.'))
        .map(file => {
          const filePath = join(this.agentsPath, file)
          const content = fs.readFileSync(filePath, 'utf-8')
          const agent = JSON.parse(content)
          return {
            id: agent.metadata?.id || '',
            name: agent.metadata?.name || '',
            updatedAt: agent.metadata?.updatedAt || 0,
            sourceWorkflowId: agent.metadata?.sourceWorkflowId || '',
            autoSyncEnabled: agent.metadata?.autoSyncEnabled || false
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return { success: true, agents }
    } catch (error: unknown) {
      console.error('Failed to list agents:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async deleteAgent(id: string): Promise<AgentResult> {
    try {
      const filePath = join(this.agentsPath, `${id}.json`)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }

      if (this.onAgentDeleted) {
        try {
          this.onAgentDeleted(id)
        } catch {
          // 回调失败不影响删除
        }
      }

      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to delete agent:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }
}
