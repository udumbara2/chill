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
  /** 监听目录变更（可选实现） */
  watch?(path: string, callback: (event: string, filename: string) => void): (() => void) | void
  /** 读取文件二进制内容（base64 返回）。可选实现：知识库 PDF 摄入等需要原始字节的场景使用；
   *  未实现的宿主在调用方会收到明确的中文降级提示 */
  readFileBase64?(path: string): Promise<FileSystemResult<{ base64: string }>>
}
