/**
 * 安全 chokidar 工厂：electron 主进程一切目录/文件监视的唯一创建点。
 *
 * 设计红线（文件监视约定）：
 * 1. 监视器 error 事件是外部环境常态数据（锁定文件 EBUSY、权限 EPERM、目录被删），
 *    不是异常——必须就地消化，严禁上抛（EventEmitter 的 error 无监听即 throw，
 *    会直接杀主进程，历史教训：lstat C:\DumpStack.log.tmp 的 EBUSY 弹崩溃对话框）。
 * 2. chokidar 的 error 事件不会关闭 watcher，就地记录后监视继续工作。
 * 3. 默认 ignorePermissionErrors（吞 EPERM/EACCES 噪音），EBUSY 等其余错误经监听记录，
 *    同一 code+path 60 秒内只记一条（防洪泛）。
 */
import chokidar from 'chokidar'

const ERROR_LOG_THROTTLE_MS = 60_000
const lastErrorLogAt = new Map<string, number>()

const throttledErrorLog = (error: unknown): void => {
  const err = error as NodeJS.ErrnoException
  const key = `${err?.code ?? 'UNKNOWN'}:${err?.path ?? err?.message ?? ''}`
  const now = Date.now()
  const last = lastErrorLogAt.get(key) ?? 0
  if (now - last < ERROR_LOG_THROTTLE_MS) return
  lastErrorLogAt.set(key, now)
  console.error(`【文件监视】watcher 错误（已就地消化，监视继续）: ${err?.code ?? ''} ${err?.message ?? String(error)}`)
}

export const createSafeChokidar = (
  paths: string | readonly string[],
  options?: chokidar.WatchOptions
): chokidar.FSWatcher => {
  const watcher = chokidar.watch(paths as string[], {
    ignorePermissionErrors: true,
    ...options
  })
  watcher.on('error', throttledErrorLog)
  return watcher
}
