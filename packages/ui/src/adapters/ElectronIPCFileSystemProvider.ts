import type { IFileSystemProvider, FileSystemResult, FileReadOptions } from '@assistant-ai/core'
import { useWritingViewStore } from '../stores/writingViewStore'
import { useProjectStore } from '../stores/projectStore'

declare const window: Window & {
  electronAPI: any
}

export class ElectronIPCFileSystemProvider implements IFileSystemProvider {
  getCurrentDirectory(): string | null {
    try {
      // 项目=文件夹绑定：当前会话归属项目已绑定文件夹时，以项目文件夹为写边界权威来源
      const projectStore = useProjectStore()
      const sessionId = projectStore.currentSessionId
      if (sessionId) {
        const projectId = projectStore.sessionProjectIdOf(sessionId)
        const folderPath = projectId
          ? projectStore.projects.find(p => p.id === projectId)?.folderPath
          : undefined
        if (folderPath) return folderPath
      }
      // 未命中（未分组/未绑定）回退写作编辑器打开的目录
      const store = useWritingViewStore()
      return store.getCurrentDirectory()
    } catch {
      return null
    }
  }

  async readFile(filePath: string, options?: FileReadOptions): Promise<FileSystemResult> {
    try {
      const result = await window.electronAPI.fileRead(filePath, options)
      return {
        success: true,
        data: result
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '读取文件失败'
      }
    }
  }

  async readFileBase64(filePath: string): Promise<FileSystemResult<{ base64: string }>> {
    try {
      const result = await window.electronAPI.fileReadBase64(filePath)
      if (!result?.success) {
        return { success: false, error: result?.error || '读取文件失败' }
      }
      return {
        success: true,
        data: { base64: result.base64 }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '读取文件失败'
      }
    }
  }

  async writeFile(filePath: string, content: string): Promise<FileSystemResult> {
    try {
      const result = await window.electronAPI.fileWrite(filePath, content)
      return {
        success: true,
        data: result
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '写入文件失败'
      }
    }
  }

  async deleteFile(filePath: string): Promise<FileSystemResult> {
    try {
      const result = await window.electronAPI.fileDelete(filePath)
      return {
        success: true,
        data: result
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '删除文件失败'
      }
    }
  }

  async listDirectory(dirPath: string, options?: Record<string, any>): Promise<FileSystemResult> {
    try {
      const result = await window.electronAPI.fileListDirectory(dirPath, options)
      return {
        success: true,
        data: result
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '读取目录失败'
      }
    }
  }

  async fileExists(filePath: string): Promise<FileSystemResult<boolean>> {
    try {
      const result = await window.electronAPI.fileExists(filePath)
      // 契约:data 一律为 boolean(见 IFileSystemProvider);IPC 层返回 {success, exists},在此映射
      return {
        success: true,
        data: result.exists === true
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '检查文件存在性失败'
      }
    }
  }

  async getPathType(filePath: string): Promise<FileSystemResult> {
    try {
      const result = await window.electronAPI.getPathType(filePath)
      return {
        success: true,
        data: result
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取路径类型失败'
      }
    }
  }
}
