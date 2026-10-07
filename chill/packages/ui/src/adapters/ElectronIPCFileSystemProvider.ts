import type { IFileSystemProvider, FileSystemResult, FileReadOptions } from '@assistant-ai/core'
import { useWritingViewStore } from '../stores/writingViewStore'
import { useProjectStore } from '../stores/projectStore'
import { getHostAPI } from '../host/hostApi'

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
      const result = await getHostAPI().fileRead(filePath, options)
      // 主进程统一返回 { success, ... };失败必须如实上抛,不能包装成成功吞掉错误
      if (!result?.success) {
        return { success: false, error: result?.error || '读取文件失败' }
      }
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
      const result = await getHostAPI().fileReadBase64(filePath)
      if (!result?.success) {
        return { success: false, error: result?.error || '读取文件失败' }
      }
      return {
        success: true,
        // success 蕴含 base64 在场（宿主成功路径必填；! 为类型层断言，运行时行为不变）
        data: { base64: result.base64! }
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
      const result = await getHostAPI().fileWrite(filePath, content)
      // 主进程统一返回 { success, ... };失败必须如实上抛,不能包装成成功吞掉错误
      if (!result?.success) {
        return { success: false, error: result?.error || '写入文件失败' }
      }
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
      const result = await getHostAPI().fileDelete(filePath)
      // 主进程统一返回 { success, ... };失败必须如实上抛,不能包装成成功吞掉错误
      // (工作流/模板"删不掉"的根因:此前此处 success 恒为 true)
      if (!result?.success) {
        return { success: false, error: result?.error || '删除文件失败' }
      }
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

  // 原子写 tmp+rename 的 rename 一环（core TaskStore 定时任务清单等的鸭子类型契约
  // MaybeRenameFs.renameFile；经既有 file:rename IPC 通道桥到主进程 fs.rename，无需新通道）
  async renameFile(from: string, to: string): Promise<FileSystemResult> {
    try {
      const result = await getHostAPI().fileRename(from, to)
      if (!result?.success) {
        return { success: false, error: result?.error || '重命名文件失败' }
      }
      return { success: true, data: result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '重命名文件失败'
      }
    }
  }

  async listDirectory(dirPath: string, options?: Record<string, any>): Promise<FileSystemResult> {
    try {
      const result = await getHostAPI().fileListDirectory(dirPath, options)
      // 主进程统一返回 { success, ... };失败必须如实上抛,不能包装成成功吞掉错误
      if (!result?.success) {
        return { success: false, error: result?.error || '读取目录失败' }
      }
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
      const result = await getHostAPI().fileExists(filePath)
      // 契约:data 一律为 boolean(见 IFileSystemProvider);IPC 层返回 {success, exists},在此映射
      if (!result?.success) {
        return { success: false, error: result?.error || '检查文件存在性失败' }
      }
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
      const result = await getHostAPI().getPathType(filePath)
      // 主进程统一返回 { success, ... };失败必须如实上抛,不能包装成成功吞掉错误
      if (!result?.success) {
        return { success: false, error: result?.error || '获取路径类型失败' }
      }
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

  /** 文件元信息（core IFileSystemProvider.statFile 契约：快照时效对账；经 file:stat IPC 桥） */
  async statFile(filePath: string): Promise<FileSystemResult<{ mtimeMs: number; size: number }>> {
    try {
      const result = await getHostAPI().fileStat(filePath)
      if (!result?.success) {
        return { success: false, error: result?.error || '获取文件信息失败' }
      }
      return {
        success: true,
        // success 蕴含两字段在场（宿主成功路径必填；! 为类型层断言，运行时行为不变）
        data: { mtimeMs: result.mtimeMs!, size: result.size! }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '获取文件信息失败'
      }
    }
  }

  /** 独占创建（core IFileSystemProvider.createFileExclusive 契约，M6 定时任务触发 claim）：
   *  经 file:create-exclusive IPC 桥到主进程 O_EXCL；宿主未实现该方法（Web 壳）时
   *  如实 success=false——claimGate 侧 fail-closed（Web 渲染层无时钟，实际不触达） */
  async createFileExclusive(filePath: string, content: string): Promise<FileSystemResult<boolean>> {
    try {
      const api = getHostAPI() as { fileCreateExclusive?: (p: string, c: string) => Promise<{ success: boolean; created?: boolean; error?: string }> }
      if (typeof api.fileCreateExclusive !== 'function') {
        return { success: false, error: '当前宿主未实现独占创建（fileCreateExclusive）' }
      }
      const result = await api.fileCreateExclusive(filePath, content)
      if (!result?.success) {
        return { success: false, error: result?.error || '独占创建失败' }
      }
      return { success: true, data: result.created === true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '独占创建失败'
      }
    }
  }
}
