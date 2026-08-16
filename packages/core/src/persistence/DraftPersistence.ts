import { join } from 'path'
import * as fs from 'fs'
import type { IPathProvider } from '../interfaces/IPathProvider'

export interface DraftResult {
  success: boolean
  error?: string
}

export interface LoadDraftResult extends DraftResult {
  draft?: unknown | null
}

export interface ExistsDraftResult extends DraftResult {
  exists?: boolean
}

export class DraftPersistence {
  private draftFilePath: string

  constructor(pathProvider: IPathProvider) {
    const draftsDir = join(pathProvider.getUserDataPath(), 'workflows', '.drafts')
    if (!fs.existsSync(draftsDir)) {
      fs.mkdirSync(draftsDir, { recursive: true })
    }
    this.draftFilePath = join(draftsDir, 'draft.json')
  }

  async saveDraft(draft: unknown): Promise<DraftResult> {
    try {
      fs.writeFileSync(this.draftFilePath, JSON.stringify(draft, null, 2), 'utf-8')
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to save draft:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async loadDraft(): Promise<LoadDraftResult> {
    try {
      if (!fs.existsSync(this.draftFilePath)) {
        return { success: true, draft: null }
      }
      const content = fs.readFileSync(this.draftFilePath, 'utf-8')
      const draft = JSON.parse(content)
      return { success: true, draft }
    } catch (error: unknown) {
      console.error('Failed to load draft:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async existsDraft(): Promise<ExistsDraftResult> {
    try {
      const exists = fs.existsSync(this.draftFilePath)
      return { success: true, exists }
    } catch (error: unknown) {
      console.error('Failed to check draft:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }

  async clearDraft(): Promise<DraftResult> {
    try {
      if (fs.existsSync(this.draftFilePath)) {
        fs.unlinkSync(this.draftFilePath)
      }
      return { success: true }
    } catch (error: unknown) {
      console.error('Failed to clear draft:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  }
}
