import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import type { HookProcessResult } from '@assistant-ai/core'

/**
 * 桌面 UI 侧 hook 执行通道（core IHookProcessRunner 契约的主进程实现）：
 * 渲染进程无 child_process，UI 的 HookRunner 经 hooks:run IPC 调到这里执行。
 *
 * 语义与 CLI 的 NodeHookProcessRunner（packages/cli/src/adapters/NodeHookProcessRunner.ts）
 * 逐条对齐（包边界原因不能直接 import cli，此为同语义移植）：
 * - command 是整串（如 `node ~/.chill/hooks/scripts/x.mjs`），经系统 shell 执行：
 *   win32 = cmd.exe /d /s /c，其余 = /bin/sh -c——按 shell 语义整条交给 shell，
 *   不自行做引号/分词解析（最简可靠；hook 产物约定为零依赖 .mjs 单文件 Node 脚本）。
 * - stdin 经管道写入 inputJson：Windows 行业踩坑点是某些 spawn 形态下子进程拿不到
 *   stdin 管道；cmd.exe /c 经 libuv 管道继承 stdin 是可靠路径。
 * - `~` 展开为 os.homedir()：cmd.exe 不展开 ~，hooks.json 协议约定由执行方展开。
 * - 环境变量注入 CHILL_PROJECT_DIR / CLAUDE_PROJECT_DIR 生态兼容别名。
 *   与 CLI 的差异仅此一处取值来源：CLI 取进程 cwd（CLI 进程即工作在项目目录），
 *   主进程 cwd 不是项目目录，故由渲染进程随调用传入（引擎会话 workDir，缺省回退主目录）。
 * - 超时：到点杀进程树并标 timedOut（exitCode 此时无意义）。
 */
export function runHookProcess(
  command: string,
  inputJson: string,
  timeoutMs: number,
  cwd?: string
): Promise<HookProcessResult> {
  const expanded = expandHomeCommand(command)
  const isWin = process.platform === 'win32'
  const projectDir = cwd || homedir()
  const env = {
    ...process.env,
    CHILL_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
  }

  return new Promise<HookProcessResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    let child: ChildProcess
    try {
      child = isWin
        ? spawn('cmd.exe', ['/d', '/s', '/c', expanded], { windowsHide: true, env })
        // POSIX：detached 使子进程自成进程组，超时可整组 kill（防 sh 死了孙进程残留）
        : spawn('/bin/sh', ['-c', expanded], { env, detached: true })
    } catch {
      // spawn 同步抛错（极端情况，如 shell 不存在）：进程未能启动，exitCode null
      resolve({ exitCode: null, stdout, stderr, timedOut })
      return
    }

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    // spawn 失败（命令无法启动）走 error；close 的 code 在信号杀死时为 null（符合契约）
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))

    // hook 不读 stdin 直接退出时写入会 EPIPE——属正常时序，不应升级为未捕获异常
    child.stdin?.on('error', () => {})
    child.stdin?.write(inputJson)
    child.stdin?.end()
  })
}

/**
 * command 中的 `~` 按用户主目录展开（cmd.exe 不展开 ~）。
 * 仅展开"词首（行首/空白/引号之后）且后随路径分隔符"的 ~，正文里的波浪号不动。
 * （与 CLI expandHomeCommand 同一实现，同语义移植）
 */
export function expandHomeCommand(command: string): string {
  const home = homedir()
  return command.replace(/(^|[\s"'])~(?=[/\\])/g, (_match, prefix: string) => `${prefix}${home}`)
}

/** 超时杀进程树：win32 下 cmd 壳被杀不连带 node 孙进程，须 taskkill /T 整树终止 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true })
    } catch {
      /* 进程已自行退出则忽略 */
    }
  } else {
    try {
      // detached 进程组整组 kill；失败回退单进程 kill
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch { /* 已退出则忽略 */ }
    }
  }
}
