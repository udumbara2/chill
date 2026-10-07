/**
 * UI 侧危险命令黑名单（自 PowerShellCommandDisplay.vue:314 逐字搬迁，规则零变化）。
 * 消费点：PendingOperationsBar（kind:'command' 审批请求命中即自动拒绝）+ ToolLineDisplay 命令详情的危险警告。
 * 观察项：与 core execution/commandSafety.ts 的 isDangerousCommand 是两套不同规则（core 版不从包根导出），统一另行评估。
 */
export function checkDangerousCommand(cmd: string): boolean {
  if (!cmd) return false

  const lowerCmd = cmd.toLowerCase()

  // 危险命令黑名单
  const dangerousPatterns = [
    // 系统破坏类
    'format-volume',
    'clear-disk',
    'remove-item -recurse -force c:\\',
    'remove-item -recurse -force "c:\\',
    'rm -rf /',
    'dismount-diskimage',
    'initialize-disk',

    // 权限提升类
    '-executionpolicy bypass',
    '-verb runas',
    'bypass -windowstyle hidden',

    // 网络攻击类
    'invoke-expression',
    'iex ',
    'downloadstring(',
    'downloadfile(',
    'net.webclient',
    'start-bitstransfer',

    // 敏感信息类
    'get-credential',
    'convertto-securestring',
    'export-clixml',

    // 进程终止类（系统关键进程）
    'stop-process -name svchost',
    'stop-process -name csrss',
    'stop-process -name smss',
    'stop-process -name lsass',

    // 注册表危险操作
    'remove-item -path hklm:\\',
    'remove-item -path hkcu:\\'
  ]

  return dangerousPatterns.some(pattern => lowerCmd.includes(pattern))
}
