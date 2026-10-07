import type { IFileMtimeProvider } from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

/**
 * hooks 配置的 mtime 探测（core IFileMtimeProvider 的渲染进程实现）：
 * 渲染进程 fs 是空 shim，经 hooks:mtime IPC 桥到主进程 fs.stat
 * （对照 CLI 的 NodeFileMtimeProvider；文件不存在或探测失败返回 null，
 * loader 按"无法廉价判变"降级为每次重读，不影响正确性）。
 */
export class ElectronIPCHookMtimeProvider implements IFileMtimeProvider {
  async getMtimeMs(path: string): Promise<number | null> {
    try {
      const result = await getHostAPI().hooksMtime(path)
      return typeof result === 'number' ? result : null
    } catch {
      return null
    }
  }
}
