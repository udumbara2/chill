export interface FileReadOptions {
  limit?: number
  offset?: number
}

export interface FileSystemResult<T = any> {
  success: boolean
  data?: T
  error?: string
}

export interface IFileSystemProvider {
  readFile(path: string, options?: FileReadOptions): Promise<FileSystemResult>
  writeFile(path: string, content: string): Promise<FileSystemResult>
  deleteFile(path: string): Promise<FileSystemResult>
  listDirectory(path: string, options?: Record<string, any>): Promise<FileSystemResult>
  getCurrentDirectory(): string | null
  /** 存在性检查的统一契约:data 一律为 boolean(true=存在),禁止返回包装对象 */
  fileExists(path: string): Promise<FileSystemResult<boolean>>
  getPathType(path: string): Promise<FileSystemResult>
  /** 文件改名/移动（可选实现）：原子写 tmp+rename 的消费方（定时任务清单 TaskStore 等）鸭子类型检出；
   *  未实现的宿主由消费方退化直写（读取侧 mtime 惰性重载 + 损坏 fail-open 兜底） */
  renameFile?(from: string, to: string): Promise<FileSystemResult>
  /** 监听目录变更（可选实现） */
  watch?(path: string, callback: (event: string, filename: string) => void): (() => void) | void
  /** 读取文件二进制内容（base64 返回）。可选实现：知识库 PDF 摄入等需要原始字节的场景使用；
   *  未实现的宿主在调用方会收到明确的中文降级提示 */
  readFileBase64?(path: string): Promise<FileSystemResult<{ base64: string }>>
  /** 文件元信息（mtimeMs+size）。可选实现：快照时效对账（ensureSnapshot 陈旧重读）鸭子类型检出，
   *  同 renameFile 先例；未实现的宿主由消费方退化为"每次重读"（正确性优先） */
  statFile?(path: string): Promise<FileSystemResult<{ mtimeMs: number; size: number }>>
  /** 独占创建（O_EXCL 语义）。可选实现：跨进程原子抢占原语（定时任务触发 claim，M6）鸭子类型
   *  检出，同 statFile 先例；data=true=创建成功，data=false=已存在（EEXIST）；其他失败走
   *  success=false。未实现的宿主由消费方优雅降级（无 claim，乐观判重现状） */
  createFileExclusive?(path: string, content: string): Promise<FileSystemResult<boolean>>
}
