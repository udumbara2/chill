/**
 * serveControl.ts — `chill serve` 控制面（实施规划 D14）：on | off | status
 *
 * cli.ts argv 首词门控极早分流调用（先于 CliContext/引擎构造，毫秒级返回）——控制面与
 * 数据面分离（docker CLI↔dockerd 同构）：控制命令不建引擎。
 *
 * - on：预检（已配对设备——devices.json 是配对成功的产物，防"每次登录秒死"的坏自启循环）→
 *       写三工件（serve-task.cmd 批处理=引号/重定向唯一落点；serve-silent.vbs 隐藏启动器=登录无闪窗
 *       且等待式保持任务树完整供 /End 连根终止；serve-task.xml=任务定义）→
 *       schtasks /Create /xml（标准用户注册自身 LogonTrigger 必须 XML 形态——CLI /sc onlogon
 *       注册"任意用户"需管理员，实测 Access denied）→ 立即拉起。幂等（/f 重建）。
 * - off：读 pidfile 杀 serve 进程（含前台遗留——身份锚消除 TUI 歧义）→ /End → /Delete。
 * - status：任务存在性 / pidfile 存活（陈旧自动清理）/ relay.lock 持约者与心跳年龄 / 日志路径。
 * - ensure：看门狗探针（内部；chill-serve-watchdog 任务每 5min 拉起）——serve 死了自动 /Run。
 *   2026-10-04 立：serve 崩溃（readline 行长事故）11 分钟无人拉起；RestartOnFailure 经两轮
 *   探针实证不可依赖（非零退出如实记录但从不自动重启），拉活职责归时间触发的看门狗任务。
 * - 裸 `chill serve` = status + 用法。
 *
 * 另导出 taskExists()/writeServeAlarm()/spawnServeRestartHelper()（版本切换接续规划 M1.3~M1.5）：
 * 换版接续 = serve 收到事件/令牌后优雅自退（退租/SessionEnd/销毁 Worker/删 pidfile），
 * 退出前 spawn 换版小助手（detached 瞬态）等本 pid 消亡后 schtasks /Run 拉起新版本——
 * D9 的 /End+/Run bounce 硬杀机制已整体退役（实测 /End 杀不死旧实例，旧版曾持约服务 80 分钟）。
 *
 * 语义边界（D14）：off 后租约 ≤15s 心跳过期释放，期间开着的交互壳自动接管=
 * serve 停 ≠ 手机断服（谁活着谁服务）。撤设备信任是 /pair revoke 的事，不在本命令职责内。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SERVE_TASK_NAME = 'chill-serve'
/** 看门狗任务（2026-10-04 serve 崩溃 11 分钟无人拉起根治）：每 5min 时间触发探活，
 *  serve 进程死了就 /Run 拉活。不依赖 RestartOnFailure——该机制在本机经两轮探针
 *  （手动 /Run 与触发器启动各一）实证不可依赖：非零退出如实记录（Last Result=1）
 *  但从不自动重启。时间触发是任务计划的本职，语义可靠。武装条件=serve 任务注册态
 *  （off 删任务即自动解除），意图安全零额外状态。 */
export const WATCHDOG_TASK_NAME = 'chill-serve-watchdog'

const USER_DATA = join(homedir(), '.chill')
const PIDFILE = join(USER_DATA, 'serve.pid')
const LOG_PATH = join(USER_DATA, 'serve.log')
const ALARM_PATH = join(USER_DATA, 'serve-alarm.json')
const TASK_CMD = join(USER_DATA, 'serve-task.cmd')
const LAUNCHER_VBS = join(USER_DATA, 'serve-silent.vbs')
const TASK_XML = join(USER_DATA, 'serve-task.xml')
const WATCHDOG_CMD = join(USER_DATA, 'serve-watchdog.cmd')
const WATCHDOG_VBS = join(USER_DATA, 'serve-watchdog.vbs')
const WATCHDOG_XML = join(USER_DATA, 'serve-watchdog.xml')
const DEVICES_PATH = join(USER_DATA, 'relay', 'devices.json')
const LOCK_PATH = join(USER_DATA, 'relay.lock')

function usage(): string {
  return [
    '用法: chill serve <子命令>',
    '  on       启用常驻宿主：预检 → 注册开机自启任务 → 立即拉起（幂等）',
    '  off      彻底停止：杀 serve 进程（含前台遗留）→ 停止并删除自启任务（幂等）',
    '  status   查看状态：任务 / 进程 / 租约 / 日志路径',
    '',
    '前台调试运行用 chill --serve（Ctrl+C 退出）。三注意：关终端窗口=杀前台 serve（托管形态不受影响）；',
    'serve 停止 ≠ 手机断服（开着的交互终端会自动接管）；撤设备信任用交互壳内 /pair revoke。',
  ].join('\n')
}

/** pid 存活探测（语义同 core probeOwnerAlive：EPERM=进程存在但无权限发信号） */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

interface ServeProcessInfo {
  pid: number
  alive: boolean
}

/** 读 pidfile；陈旧（pid 已死/文件损坏）默认顺带清理——硬杀遗留的唯一救济路径 */
function readServeProcess(cleanStale = true): ServeProcessInfo | null {
  if (!existsSync(PIDFILE)) return null
  let pid = 0
  try {
    pid = Number(readFileSync(PIDFILE, 'utf8').trim())
  } catch {
    pid = 0
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    if (cleanStale) try { unlinkSync(PIDFILE) } catch { /* 忽略 */ }
    return null
  }
  const alive = isPidAlive(pid)
  if (!alive && cleanStale) try { unlinkSync(PIDFILE) } catch { /* 忽略 */ }
  return { pid, alive }
}

/** relay.lock 概要（持约者 + 心跳年龄；供 status 三态与诊断） */
function relayLockSummary(): string {
  try {
    const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8')) as { owner?: string; heartbeatAt?: number }
    if (typeof lock.owner !== 'string' || typeof lock.heartbeatAt !== 'number') return '无'
    const age = Math.max(0, Math.round((Date.now() - lock.heartbeatAt) / 1000))
    return `${lock.owner}（心跳 ${age}s 前）`
  } catch {
    return '无'
  }
}

/** schtasks 调用（stdio ignore：沙箱禁管道子进程，只用退出码） */
function schtasks(args: string[]): number {
  const r = spawnSync('schtasks', args, { windowsHide: true, stdio: 'ignore' })
  return r.status === null ? 1 : r.status
}

export function taskExists(): boolean {
  if (process.platform !== 'win32') return false
  return schtasks(['/Query', '/tn', SERVE_TASK_NAME]) === 0
}

/** serve 告警（M1.4/M1.5）：醒目日志行 + serve-alarm.json（`chill serve status` 呈现；尽力而为不抛） */
export function writeServeAlarm(reason: string): void {
  const at = new Date().toISOString()
  try {
    writeFileSync(ALARM_PATH, JSON.stringify({ at, reason }, null, 2), 'utf8')
  } catch {
    /* 尽力而为 */
  }
  try {
    appendFileSync(LOG_PATH, `[serve-alarm ${at}] ${reason}\n`)
  } catch {
    /* 尽力而为 */
  }
}

/**
 * 换版小助手（M1.4，版本切换接续规划）：serve 优雅自退前 spawn 的 detached 瞬态进程。
 * 职责三拍：① 等旧 serve pid 消亡（≤30s）→ ② `schtasks /Run` 拉起新实例（重试 ≤2 次退避，
 * 避开旧任务实例终结竞态）→ ③ 健康观察 ≤20s（serve.pid 出现新 pid 且存活）；
 * 任一拍失败 → serve.log 醒目告警行 + serve-alarm.json（手机侧断连可见性由既有 M6c 探活承担）。
 * 内联脚本零依赖（纯 node 内建）；Atomics.wait 同步 sleep（无定时器，跑完即退）。
 */
export function spawnServeRestartHelper(oldPid: number): void {
  const script = `
const oldPid = ${oldPid};
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const home = os.homedir();
const logPath = path.join(home, '.chill', 'serve.log');
const alarmPath = path.join(home, '.chill', 'serve-alarm.json');
const pidPath = path.join(home, '.chill', 'serve.pid');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const log = (m) => { try { fs.appendFileSync(logPath, '[serve-helper ' + new Date().toISOString() + '] ' + m + '\\n'); } catch (e) {} };
const alarm = (reason) => {
  const at = new Date().toISOString();
  try { fs.writeFileSync(alarmPath, JSON.stringify({ at, reason }, null, 2), 'utf8'); } catch (e) {}
  try { fs.appendFileSync(logPath, '[serve-alarm ' + at + '] ' + reason + '\\n'); } catch (e) {}
  log('小助手退出（告警）：' + reason);
};
let dead = false;
for (let i = 0; i < 120; i++) {
  try { process.kill(oldPid, 0); } catch (e) { dead = true; break; }
  sleep(250);
}
if (!dead) { alarm('旧 serve(' + oldPid + ') 30s 内未退出，小助手放弃 /Run（旧实例可能仍在服务）'); process.exit(0); }
log('旧 serve(' + oldPid + ') 已退出，执行 schtasks /Run');
// M1.4 竞态根治（实测教训 2026-10-03：pid 死亡与任务实例终结同一毫秒竞态——wscript/cmd 拆场未完时
// 调度器仍标 Running，schtasks /Run 打印 "currently running…Attempted" 且 exit 0=伪成功，重试逻辑不触发）。
// 对策：不信任 /Run 退出码，以健康观察（serve.pid 出现新 pid 且存活）为唯一裁决——未观察到就再 /Run
// 一次（届时拆场必已完成），两轮仍未活才告警。
var healthy = false, newPid = 0;
for (var attempt = 1; attempt <= 2 && !healthy; attempt++) {
  try { execFileSync('schtasks', ['/Run', '/tn', 'chill-serve'], { stdio: 'ignore', windowsHide: true }); log('/Run 已发出（第 ' + attempt + ' 轮）'); }
  catch (e) { log('/Run 第 ' + attempt + ' 轮执行失败：' + (e && e.message)); }
  for (var i = 0; i < 80; i++) {
    sleep(250);
    try {
      var p = Number(String(fs.readFileSync(pidPath, 'utf8')).trim());
      if (Number.isFinite(p) && p > 0 && p !== oldPid) {
        try { process.kill(p, 0); newPid = p; healthy = true; break; } catch (e) {}
      }
    } catch (e) {}
  }
  if (!healthy && attempt === 1) log('第 1 轮健康观察未通过（/Run 伪成功竞态或启动慢），1s 后重试一轮');
  if (!healthy && attempt < 2) sleep(1000);
}
if (healthy) { log('新 serve 已存活 pid=' + newPid + '，换版接续完成'); }
else { alarm('两轮 /Run 后新 serve 实例均未存活（构建损坏/启动崩溃/拆场竞态）——手机此刻应显示桌面离线'); }
`
  try {
    spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    // helper 拉起失败也要大声报（不静默——这正是它存在的意义）
    writeServeAlarm('换版小助手 spawn 失败：serve 将退出且无自动拉起')
  }
}

/**
 * M1.10（版本切换接续规划）：D9 的 bounceServeTask（schtasks /End + /Run 硬杀重启）已退役——
 * 实测 /End 杀不死旧 serve 实例（任务实例追踪与进程树脱节），旧版本曾持约继续服务 ~80 分钟。
 * 替代机制：serve 优雅自退（cli.ts serve 分支 serveShutdown 语义）+ spawnServeRestartHelper 拉起。
 */

function cmdOn(): void {
  if (process.platform !== 'win32' || !process.env.APPDATA) {
    process.stderr.write('✗ serve 托管 v1 仅支持 Windows（任务计划 + 全局 chill shim）；其他平台可用前台 chill --serve\n')
    process.exit(2)
  }
  // D14 预检：已配对设备（devices.json 是 /pair 成功的产物，config 先于配对存在）。
  // 在安装期 fail fast，防注册出"每次登录秒退"的坏自启循环。
  let deviceCount = 0
  try {
    const devices = JSON.parse(readFileSync(DEVICES_PATH, 'utf8'))
    deviceCount = Array.isArray(devices) ? devices.length : 0
  } catch {
    /* 无设备文件=未配对 */
  }
  if (deviceCount === 0) {
    process.stderr.write('✗ 尚无已配对设备——先在交互终端运行 chill，经 /pair 完成配置与配对，再 chill serve on\n')
    process.exit(2)
  }
  const shim = join(process.env.APPDATA!, 'npm', 'chill.cmd')
  if (!existsSync(shim)) {
    process.stderr.write(`✗ 找不到全局 chill 启动器：${shim}\n  npm 全局安装的 chill 是任务计划的稳定入口（路径恒定，版本随符号链接切换）\n`)
    process.exit(2)
  }
  const proc = readServeProcess()
  if (proc?.alive) {
    process.stdout.write(`ℹ serve 已在运行（pid=${proc.pid}，前台或既有实例）——仍注册自启任务（并存由租约仲裁，无冲突）\n`)
  }
  // ── 工件一：任务批处理（唯一引号/重定向落点；%APPDATA%/%USERPROFILE% 运行时展开；ASCII 注释防 GBK 乱码）
  writeFileSync(
    TASK_CMD,
    [
      '@echo off',
      'rem Generated by "chill serve on" (serve hosted task entry; overwritten by next on)',
      'cd /d "%USERPROFILE%"',
      // CJK 用户名修复：shim 路径用 %APPDATA% 运行时展开（与同文件 %USERPROFILE% 同款）——
      // 字面嵌入 UTF-8 路径会被 cmd.exe 按系统码页（GBK）误读，中文用户名下 serve 静默失败
      `"%APPDATA%\\npm\\chill.cmd" --serve >> "%USERPROFILE%\\.chill\\serve.log" 2>&1`,
      '',
    ].join('\r\n'),
    'utf8',
  )
  // ── 工件二：隐藏启动器（wscript 窗口风格 0 = 登录无闪窗；bWaitOnReturn=True = wscript
  // 等待批处理退出，任务树保持完整——schtasks /End 才能连根终止 serve，D9 依赖此语义；
  // 退出码透传（2026-10-04 serve 崩溃 11 分钟无人拉起根治）：旧版 vbs 丢弃 Run 的返回码，
  // wscript 永远退 0——serve 崩溃（非零退出）被吞成 0，任务计划的 RestartOnFailure
  // （3×1min，只认非零退出）永远不触发。WScript.Quit rc 让崩溃如实上报，自动拉活；
  // 优雅退出（换版自退 exit 0）仍不触发重启，小助手 /Run 机制互不干扰；
  // `serve off` 先 /End + /Delete 任务再离开，毫秒级窗口不构成复活路径）
  writeFileSync(
    LAUNCHER_VBS,
    [
      "' chill serve hidden launcher (generated by \"chill serve on\")",
      'Dim chillSh, chillRc',
      'Set chillSh = CreateObject("WScript.Shell")',
      'chillRc = chillSh.Run("""" & chillSh.ExpandEnvironmentStrings("%USERPROFILE%") & "\\.chill\\serve-task.cmd" & """", 0, True)',
      "' propagate exit code: a crashed serve (non-zero) must reach Task Scheduler so RestartOnFailure revives it",
      'WScript.Quit chillRc',
      '',
    ].join('\r\n'),
    'utf8',
  )
  // ── 工件三：任务定义 XML。标准用户注册自身 LogonTrigger 必须走 XML 形态——CLI 的 /sc onlogon
  // 注册"任意用户登录"需管理员（实测 Access denied）；XML 指定自身 UserId 即可。ExecutionTimeLimit
  // PT0S=不限时（默认 72h 会杀常驻进程）；IgnoreNew 防重复拉起；电池策略放行（笔记本友好）。
  const userId = process.env.USERNAME || 'me'
  const taskXml =
    '<?xml version="1.0" encoding="UTF-16"?>\n' +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n' +
    '  <Triggers>\n' +
    '    <LogonTrigger>\n' +
    '      <Enabled>true</Enabled>\n' +
    `      <UserId>${userId}</UserId>\n` +
    '    </LogonTrigger>\n' +
    '  </Triggers>\n' +
    '  <Settings>\n' +
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n' +
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n' +
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>\n' +
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n' +
    // 崩溃自动重试（M1.8）：非零退出（崩溃/坏构建）语义上应自动重试 3 次×1min。
    // 序列化形态：Count 在 Interval 前（系统 Register-ScheduledTask 导出形态实测），
    // 顺序颠倒会被 schtasks 静默丢弃成空元素（2026-10-04 注册态实查发现）。
    // 如实记录（2026-10-04 两轮探针实证）：RestartOnFailure 在本机不可依赖——
    // 手动 /Run 与触发器启动的非零退出任务均未被自动重启（退出码已如实记录为
    // Last Result=1，但重启从未发生）。拉活职责由看门狗任务承担（见 WATCHDOG_TASK_NAME）；
    // 此处保留正确形态的 RestartOnFailure 作为纵深（别的机器/未来版本或恢复该语义）。
    '    <RestartOnFailure>\n' +
    '      <Count>3</Count>\n' +
    '      <Interval>PT1M</Interval>\n' +
    '    </RestartOnFailure>\n' +
    '  </Settings>\n' +
    '  <Actions>\n' +
    '    <Exec>\n' +
    '      <Command>wscript.exe</Command>\n' +
    `      <Arguments>"${LAUNCHER_VBS}"</Arguments>\n` +
    '    </Exec>\n' +
    '  </Actions>\n' +
    '</Task>\n'
  // schtasks XML 要求 UTF-16（BOM + LE）
  writeFileSync(TASK_XML, '\uFEFF' + taskXml, 'utf16le')
  const created = schtasks(['/Create', '/tn', SERVE_TASK_NAME, '/xml', TASK_XML, '/f'])
  if (created !== 0) {
    process.stderr.write(`✗ 注册任务计划失败（schtasks /Create /xml，用户 ${userId}）——请重试；管理员级服务化不在 v1 范围\n`)
    process.exit(1)
  }
  schtasks(['/Run', '/tn', SERVE_TASK_NAME])
  // ── 看门狗（崩溃自愈主力，见 WATCHDOG_TASK_NAME 注释）：三工件 + 注册（5min 探活）。
  // 工件形态与主任务同构（vbs 隐藏 + 退出码透传；cmd 重定向唯一落点）。
  writeFileSync(
    WATCHDOG_CMD,
    [
      '@echo off',
      'rem Generated by "chill serve on" (serve watchdog entry; overwritten by next on)',
      'cd /d "%USERPROFILE%"',
      `"%APPDATA%\\npm\\chill.cmd" serve ensure >> "%USERPROFILE%\\.chill\\serve.log" 2>&1`,
      '',
    ].join('\r\n'),
    'utf8',
  )
  writeFileSync(
    WATCHDOG_VBS,
    [
      "' chill serve watchdog launcher (generated by \"chill serve on\")",
      'Dim wSh, wRc',
      'Set wSh = CreateObject("WScript.Shell")',
      'wRc = wSh.Run("""" & wSh.ExpandEnvironmentStrings("%USERPROFILE%") & "\\.chill\\serve-watchdog.cmd" & """", 0, True)',
      'WScript.Quit wRc',
      '',
    ].join('\r\n'),
    'utf8',
  )
  const startBoundary = new Date(Date.now() - 60_000).toISOString().slice(0, 19)
  const watchdogXml =
    '<?xml version="1.0" encoding="UTF-16"?>\n' +
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n' +
    '  <Triggers>\n' +
    '    <TimeTrigger>\n' +
    '      <Repetition>\n' +
    '        <Interval>PT5M</Interval>\n' +
    '        <StopAtDurationEnd>false</StopAtDurationEnd>\n' +
    '      </Repetition>\n' +
    `      <StartBoundary>${startBoundary}</StartBoundary>\n` +
    '      <Enabled>true</Enabled>\n' +
    '    </TimeTrigger>\n' +
    '  </Triggers>\n' +
    '  <Settings>\n' +
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n' +
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n' +
    '    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>\n' +
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n' +
    '  </Settings>\n' +
    '  <Actions>\n' +
    '    <Exec>\n' +
    '      <Command>wscript.exe</Command>\n' +
    `      <Arguments>"${WATCHDOG_VBS}"</Arguments>\n` +
    '    </Exec>\n' +
    '  </Actions>\n' +
    '</Task>\n'
  writeFileSync(WATCHDOG_XML, '\uFEFF' + watchdogXml, 'utf16le')
  const watchdogCreated = schtasks(['/Create', '/tn', WATCHDOG_TASK_NAME, '/xml', WATCHDOG_XML, '/f'])
  if (watchdogCreated !== 0) {
    // 看门狗是自愈增强，不是 serve 本体——失败降级为告警不阻断
    process.stderr.write('⚠ 看门狗任务注册失败（serve 仍已启用；崩溃后需手动 chill serve on）\n')
  }
  process.stdout.write(
    [
      '✓ serve 常驻宿主已启用：',
      `  任务：${SERVE_TASK_NAME}（登录自启·隐藏窗口·不限时，已拉起；lease 仲裁自动避让他端）`,
      `  看门狗：${WATCHDOG_TASK_NAME}（每 5min 探活，serve 崩溃自动拉起${watchdogCreated === 0 ? '' : '——⚠ 注册失败'}）`,
      `  入口：${TASK_CMD}（隐藏启动：${LAUNCHER_VBS}）`,
      `  日志：${LOG_PATH}（追加式，含会话正文——注意盘上保密与轮转）`,
      '  管理：chill serve status / off',
    ].join('\n') + '\n',
  )
  process.exit(0)
}

function cmdOff(): void {
  // ① pidfile 杀进程（含前台遗留——serve 专属身份锚，与 TUI 零歧义）
  const proc = readServeProcess(false)
  if (proc?.alive) {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/F'], { windowsHide: true, stdio: 'ignore' })
    process.stdout.write(`✓ 已终止 serve 进程（pid=${proc.pid}）\n`)
  }
  try {
    unlinkSync(PIDFILE)
  } catch {
    /* 已清 */
  }
  // ② 任务停止 + 删除（幂等：未注册优雅提示）；看门狗先删——off 与探针之间不留竞争窗口
  if (taskExists()) {
    schtasks(['/End', '/tn', WATCHDOG_TASK_NAME])
    schtasks(['/Delete', '/tn', WATCHDOG_TASK_NAME, '/f'])
    schtasks(['/End', '/tn', SERVE_TASK_NAME])
    schtasks(['/Delete', '/tn', SERVE_TASK_NAME, '/f'])
    process.stdout.write('✓ 已停止并删除自启任务（含看门狗）\n')
  } else {
    process.stdout.write('（自启任务未注册，跳过）\n')
  }
  try {
    unlinkSync(TASK_CMD)
    unlinkSync(LAUNCHER_VBS)
    unlinkSync(TASK_XML)
    unlinkSync(WATCHDOG_CMD)
    unlinkSync(WATCHDOG_VBS)
    unlinkSync(WATCHDOG_XML)
  } catch {
    /* 无工件文件 */
  }
  process.stdout.write('完成。注意：serve 停止 ≠ 手机断服——开着的交互终端（chill）会自动接管；撤设备信任用 /pair revoke\n')
  process.exit(0)
}

function cmdStatus(): void {
  const has = taskExists()
  const watchdog = schtasks(['/Query', '/tn', WATCHDOG_TASK_NAME]) === 0
  const proc = readServeProcess()
  const procLine = proc ? (proc.alive ? `运行中（pid=${proc.pid}）` : '未运行（陈旧 pidfile 已清理）') : '未运行'
  process.stdout.write(
    [
      'serve 常驻宿主状态：',
      `  自启任务：${has ? `已注册（${SERVE_TASK_NAME}）` : '未注册（chill serve on 启用）'}`,
      `  看门狗：${watchdog ? `已注册（${WATCHDOG_TASK_NAME}，每 5min 探活）` : '未注册'}`,
      `  进程：${procLine}`,
      `  租约：${relayLockSummary()}`,
      `  日志：${LOG_PATH}`,
    ].join('\n') + '\n',
  )
}

/**
 * 看门狗探针（WATCHDOG_TASK_NAME 每 5min 拉起；人不直接调用）。
 * 判定链：serve 任务不存在 = off 意图 → 静默退出（看门狗自身武装条件随之消失）；
 * serve 进程活着 → 无事退出；进程死了 → /Run 拉活并留痕（M1.9 时间戳可排序）。
 * 与换版小助手的竞争无害：/Run 对 IgnoreNew 幂等，谁先拉起都走 junction 解析到当前版本。
 */
function cmdEnsure(): void {
  if (process.platform !== 'win32' || !taskExists()) process.exit(0)
  const proc = readServeProcess(false)
  if (proc?.alive) process.exit(0)
  const ts = new Date().toTimeString().slice(0, 8)
  process.stdout.write(`[${ts}] [watchdog] serve 进程不在（崩溃或被杀）——自动拉起\n`)
  schtasks(['/Run', '/tn', SERVE_TASK_NAME])
  process.exit(0)
}

/** cli.ts argv 首词门控入口：各子命令自带退出；未知子命令=用法+退出码 2 */
export function runServeControl(args: string[]): void {
  const sub = args[0] ?? ''
  if (sub === 'on') cmdOn()
  else if (sub === 'off') cmdOff()
  else if (sub === 'ensure') cmdEnsure()
  else if (sub === 'status') {
    cmdStatus()
    process.exit(0)
  } else if (sub === '' || sub === 'help' || sub === '--help') {
    cmdStatus()
    process.stdout.write('\n' + usage() + '\n')
    process.exit(0)
  } else {
    process.stderr.write(`未知子命令：${sub}\n${usage()}\n`)
    process.exit(2)
  }
}
