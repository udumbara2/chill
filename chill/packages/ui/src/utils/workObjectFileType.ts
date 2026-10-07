/**
 * 文件型工作对象 → 视窗类型分类（业务链「对象 → 类型」的静态映射）
 *
 * 未注册专属类型的文件一律落 'generic'（框架内置兜底视图，保证可见可审计）；
 * 未来新类型（PPT/Excel 等）先落 generic，注册专属视图后在此加映射即自动升级。
 * 会话检测迭代（迭代 7）的工具→类型映射同样以本表为文件细分依据。
 */

export type FileObjectType = 'document' | 'code' | 'html' | 'generic'

const DOCUMENT_EXTS = new Set(['md', 'markdown', 'txt'])
const HTML_EXTS = new Set(['html', 'htm'])
const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'vue', 'mjs', 'cjs',
  'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
  'json', 'yaml', 'yml', 'toml', 'xml', 'css', 'scss', 'less',
  'sh', 'bash', 'bat', 'ps1', 'sql', 'ini', 'conf'
])

/** 按扩展名分类文件路径（无扩展名/未知扩展名 → generic 兜底） */
export function classifyFileType(filePath: string): FileObjectType {
  const normalized = (filePath || '').replace(/\\/g, '/')
  const name = normalized.split('/').pop() || ''
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return 'generic'
  const ext = name.slice(dotIndex + 1).toLowerCase()
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  if (HTML_EXTS.has(ext)) return 'html'
  if (CODE_EXTS.has(ext)) return 'code'
  return 'generic'
}

/** 取文件名（末段） */
export function fileBaseName(filePath: string): string {
  const normalized = (filePath || '').replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}
