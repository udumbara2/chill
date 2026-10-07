const dangerousPatterns = [
  'format-volume',
  'clear-disk',
  'remove-item -recurse -force c:\\',
  'remove-item -recurse -force "c:\\',
  'rm -rf /',
  'dismount-diskimage',
  'initialize-disk',
  '-executionpolicy bypass',
  '-verb runas',
  'bypass -windowstyle hidden',
  'invoke-expression',
  'iex ',
  'downloadstring(',
  'downloadfile(',
  'net.webclient',
  'start-bitstransfer',
  'get-credential',
  'convertto-securestring',
  'export-clixml',
  'stop-process -name svchost',
  'stop-process -name csrss',
  'stop-process -name smss',
  'stop-process -name lsass',
  'remove-item -path hklm:\\',
  'remove-item -path hkcu:\\',
  'remove-item -recurse -force "chill-workcopy"',
  'remove-item -recurse -force chill-workcopy',
  'rd /s /q chill-workcopy'
]

export function isDangerousCommand(command: string): boolean {
  if (!command) return false

  const lowerCmd = command.toLowerCase()

  return dangerousPatterns.some(pattern => lowerCmd.includes(pattern))
}

/**
 * 代码内容危险绊线（execute_code 工具）：对齐 Claude Code circuit breaker 定位——
 * "tripwire for obvious mistakes, not an enforcement boundary"。
 * 只拦「递归删除文件系统根/用户主目录」这一个明确、刻意的破坏性行为，无论通过什么途径表达
 * （shell 命令字符串 / Node fs API / Python API，含内嵌在 exec/os.system 等调用里的命令文本）。
 * 刻意不拦正常能力（child_process、spawn、eval、动态执行等）——验证脚本大量使用子进程，
 * 拦宽泛类别会误伤核心场景；深度恶意变形不属于绊线职责，由审批层（人工确认）兜底。
 */
const dangerousCodePatterns: RegExp[] = [
  // shell 命令文本：rm 的 flag 组合含 r 与 f（-rf/-fr/-rvf/组合短 flag），目标是根/主目录
  // —— rm -rf /、rm -fr "~"、rm -rf ~/*（目标路径须整体为根/主目录，/tmp 等子路径不命中）
  /\brm\s+-[a-z]*[rf][a-z]*[rf][a-z]*(?:\s+-[a-z]+)*\s+['"`~]?\s*[\/~](?:\*|\s|['"`]|$)/i,
  // Node fs API：删除目标为根/主目录/Windows 盘符根 —— fs.rmSync('/', {recursive:true})、fs.rmdir('~')、fs.rm('/*')、fs.rmSync('C:\\')
  /\.(?:rm|rmdir)(?:Sync)?\(\s*['"`](?:\/|~|[a-z]:[\\/])(?:['"`]|\*)/i,
  // Python API：删除目标为根/主目录/盘符根 —— shutil.rmtree('/')、os.removedirs('~')、rmtree('C:/')
  /(?:rmtree|removedirs)\(\s*['"`](?:\/|~|[a-z]:[\\/])(?:['"`]|\*)/i
]

export function isDangerousCode(code: string): boolean {
  if (!code) return false

  return dangerousCodePatterns.some(pattern => pattern.test(code))
}
