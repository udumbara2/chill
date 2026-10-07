import { join, extname } from 'path'
import * as fs from 'fs'
import { randomUUID } from 'crypto'
import type { IPathProvider } from '../interfaces/IPathProvider'

export class AttachmentManager {
  private static readonly ATTACHMENTS_DIR = 'attachments'
  private static _pathProvider: IPathProvider | null = null

  static getAttachmentsRootDir(): string {
    if (!this._pathProvider) {
      throw new Error('AttachmentManager is not initialized. Call initialize(pathProvider) first.')
    }
    return join(this._pathProvider.getUserDataPath(), this.ATTACHMENTS_DIR)
  }

  static initialize(pathProvider: IPathProvider): void {
    this._pathProvider = pathProvider

    try {
      const attachmentsDir = this.getAttachmentsRootDir()

      if (!fs.existsSync(attachmentsDir)) {
        fs.mkdirSync(attachmentsDir, { recursive: true })
      }

      const testFile = join(attachmentsDir, '.write_test')
      try {
        fs.writeFileSync(testFile, '')
        fs.unlinkSync(testFile)
      } catch (permError) {
        console.error('Attachments directory is not writable:', permError)
        throw new Error(`Attachments directory is not writable: ${attachmentsDir}`)
      }
    } catch (error) {
      console.error('Failed to initialize attachments directory:', error)
    }
  }

  static async saveAttachment(buffer: Buffer, fileName: string): Promise<string> {
    try {
      const fileId = randomUUID()
      const ext = extname(fileName).toLowerCase()
      const now = new Date()
      const year = now.getFullYear().toString()
      const month = (now.getMonth() + 1).toString().padStart(2, '0')
      
      const attachmentsDir = this.getAttachmentsRootDir()
      const yearDir = join(attachmentsDir, year)
      const monthDir = join(yearDir, month)
      
      if (!fs.existsSync(monthDir)) {
        fs.mkdirSync(monthDir, { recursive: true })
      }
      
      const filePath = join(monthDir, `${fileId}${ext}`)
      await fs.promises.writeFile(filePath, new Uint8Array(buffer))
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`File was not written successfully: ${filePath}`)
      } 
      
      const resultFileId = `${year}/${month}/${fileId}${ext}`
      return resultFileId
    } catch (error) {
      console.error('Failed to save attachment:', error)
      throw new Error(`Failed to save attachment: ${error}`)
    }
  }

  static getAttachmentPath(fileId: string): string {
    const attachmentsDir = this.getAttachmentsRootDir()
    const fullPath = join(attachmentsDir, fileId)
    return fullPath
  }

  static async deleteAttachment(fileId: string): Promise<boolean> {
    try {
      const filePath = this.getAttachmentPath(fileId)
      
      if (!fs.existsSync(filePath)) {
        console.warn(`Attachment not found: ${fileId}`)
        return false
      }
      
      await fs.promises.unlink(filePath)
      console.log(`Attachment deleted: ${fileId}`)
      return true
    } catch (error) {
      console.error(`Failed to delete attachment ${fileId}:`, error)
      return false
    }
  }

  static async readAsBase64(fileId: string): Promise<string> {
    try {
      const filePath = this.getAttachmentPath(fileId)
      
      if (!fs.existsSync(filePath)) {
        throw new Error(`Attachment not found: ${fileId}`)
      }
      
      const buffer = await fs.promises.readFile(filePath)
      return buffer.toString('base64')
    } catch (error) {
      console.error(`Failed to read attachment ${fileId} as base64:`, error)
      throw error
    }
  }
}
