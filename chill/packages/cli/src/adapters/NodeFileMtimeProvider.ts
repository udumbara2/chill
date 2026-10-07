import { stat } from 'node:fs/promises'
import type { IFileMtimeProvider } from '@assistant-ai/core'

/**
 * hooks 配置的 mtime 探测（core IFileMtimeProvider 的 Node 实现）：
 * HookConfigLoader 的 mtime 惰性重载依赖此窄接口（IFileSystemProvider 无 stat 能力）；
 * 文件不存在或探测失败返回 null——loader 按"无法廉价判变"降级为每次重读，不影响正确性。
 */
export class NodeFileMtimeProvider implements IFileMtimeProvider {
  async getMtimeMs(path: string): Promise<number | null> {
    try {
      return (await stat(path)).mtimeMs
    } catch {
      return null
    }
  }
}
