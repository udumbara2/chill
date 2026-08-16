import { join } from 'path'
import * as fs from 'fs'
import type { IPathProvider } from '../interfaces/IPathProvider'

export interface WorkflowResult {
  success: boolean
  error?: string
}

export interface SaveWorkflowResult extends WorkflowResult {
  id?: string
}

export interface LoadWorkflowResult extends WorkflowResult {
  workflow?: unknown
}

export interface WorkflowSummary {
  id: string
  name: string
  updatedAt: number
}

export interface ListWorkflowsResult extends WorkflowResult {
  workflows?: WorkflowSummary[]
}

export class WorkflowPersistence {
  private workflowsPath: string

  constructor(pathProvider: IPathProvider) {
    this.workflowsPath = join(pathProvider.getUserDataPath(), 'workflows')
    if (!fs.existsSync(this.workflowsPath)) {
      fs.mkdirSync(this.workflowsPath, { recursive: true })
    }
  }

  async saveWorkflow(workflow: Record<string, unknown>): Promise<SaveWorkflowResult> {
    try {
      const metadata = workflow.metadata as Record<string, unknown> | undefined
      const id = metadata?.id
      if (!id) {
        return { success: false, error: 'Workflow ID is required' }
      }
      const fileName = `${id}.json`
      const filePath = join(this.workflowsPath, fileName)

      fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2), 'utf-8')

      return { success: true, id: String(id) }
    } catch (error: unknown) {
      console.error('Failed to save workflow:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async loadWorkflow(id: string): Promise<LoadWorkflowResult> {
    try {
      const filePath = join(this.workflowsPath, `${id}.json`)
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Workflow not found' }
      }
      const content = fs.readFileSync(filePath, 'utf-8')
      const workflow = JSON.parse(content)

      return { success: true, workflow }
    } catch (error: unknown) {
      console.error('Failed to load workflow:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async listWorkflows(): Promise<ListWorkflowsResult> {
    try {
      const files = fs.readdirSync(this.workflowsPath)
      const workflows: WorkflowSummary[] = files
        .filter(file => file.endsWith('.json') && !file.startsWith('.'))
        .map(file => {
          const filePath = join(this.workflowsPath, file)
          const content = fs.readFileSync(filePath, 'utf-8')
          const workflow = JSON.parse(content)
          return {
            id: workflow.metadata?.id || '',
            name: workflow.metadata?.name || '',
            updatedAt: workflow.metadata?.updatedAt || 0
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
      return { success: true, workflows }
    } catch (error: unknown) {
      console.error('Failed to list workflows:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async deleteWorkflow(id: string): Promise<WorkflowResult> {
    try {
      const filePath = join(this.workflowsPath, `${id}.json`)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to delete workflow:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }
}
