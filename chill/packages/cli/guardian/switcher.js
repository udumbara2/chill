/**
 * 版本管理器 — 自迭代后的版本固化与 junction 切换
 * 独立脚本，不依赖项目代码
 *
 * 用法:
 *   node switcher.js <chill路径>                     固化 workcopy 为新版本并切换 junction（不启动新窗口）
 *   node switcher.js --rollback <chill路径> [版本]   回滚到指定版本（缺省为 current.json 记录的上一版本）
 *   node switcher.js --delete <chill路径> <版本>     删除指定历史版本（当前版本与默认回滚目标拒删）
 *   node switcher.js --launch <chill路径>            启动新版本 CLI 窗口（注入 CHILL_HOME）
 *   node switcher.js --preview <chill路径>           启动体验窗口（workcopy 预览，CWD 强制为父目录）
 *
 * 输出协议: 结束时向 stdout 打印一行 RESULT_JSON:{...} 供调用方解析：
 *   成功: {"success":true,"version":"...","versionDir":"...","previousPath":"...","warning":"...（可选，切换成功但收尾清理未彻底）"}
 *   失败: {"success":false,"step":"...","errorCode":"...","reason":"...","guidance":"..."}
 * 失败写入 __dirname/switch-failure.json（干净成功时删除）；带 warning 的成功也会写入
 * （severity:'warning'），供 CLI 下次会话向用户/模型提示。
 *
 * 策略: Shadow Copy + junction 切换
 *   - robocopy 复制 workcopy → chill-versions/v<时间戳>/（复制不依赖任何进程状态）
 *   - chill 是 junction，切换 = 删除旧 junction + 重命名新 junction（不受文件句柄影响）
 *   - 旧版本完整保留在 chill-versions/ 中，支持 --rollback
 *   - chill 为真实目录时（首次运行）自动迁移为 junction 布局
 *
 * 测试支持: 环境变量 SWITCHER_NO_LAUNCH=1 时 --launch/--preview 模式只写 bat 不开窗
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn, spawnSync } = require('child_process');

// === 调试日志系统 ===
const LOG_FILE = path.join(__dirname, 'switcher-debug.log');
const FAILURE_FILE = path.join(__dirname, 'switch-failure.json');

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function logError(msg, err) {
  const detail = err ? `: ${err.message} (code: ${err.code || 'N/A'})` : '';
  log(`[ERROR] ${msg}${detail}`);
}

function logRunHeader() {
  log('=== Switcher 调试日志 ===');
  log(`Node 版本: ${process.version}`);
  log(`进程 PID: ${process.pid}`);
  log(`父进程 PID: ${process.ppid}`);
  log(`参数: ${JSON.stringify(process.argv)}`);
}

function logRunContext() {
  log(`模式: ${launchMode ? '启动' : previewMode ? '体验窗口' : rollbackMode ? '回滚' : deleteMode ? '删除' : '切换'}`);
  log(`projectPath: ${projectPath}`);
  log(`parentDir: ${parentDir}`);
  log(`versionsDir: ${versionsDir}`);
  log(`workcopyPath: ${workcopyPath}`);
  log(`NO_LAUNCH: ${NO_LAUNCH}`);
}

// 运行头照旧追加写（截断只在切换模式 main() 开头执行——失败现场不再被后续运行覆盖）
logRunHeader();

// === 结果输出协议 ===
function emitResult(obj) {
  process.stdout.write(`RESULT_JSON:${JSON.stringify(obj)}\n`);
}

// === 换版令牌（版本切换接续规划 M1.2） ===
// 切换/回滚成功后写 ~/.chill/version-switched.json：长驻壳（serve/CLI 旁观窗/Electron/Web）
// 经 core services/versionToken 订阅它自我接续。令牌是建议性信号、junction 是权威真相——
// 本函数零依赖（guardian 脚本不 import core），格式单一事实源在 core versionToken.ts。
// 写失败大声报（半成功切换必须让发起壳知道），但不逆转已成功的切换。
function writeSwitchToken(versionName) {
  const os = require('os');
  const crypto = require('crypto');
  const tokenPath = path.join(os.homedir(), '.chill', 'version-switched.json');
  const token = { version: versionName, at: Date.now(), nonce: crypto.randomUUID() };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tmp = tokenPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(token), 'utf8');
      fs.renameSync(tmp, tokenPath);
      const back = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      if (back && back.version === token.version && back.nonce === token.nonce) {
        log(`换版令牌已写入: ${tokenPath} (v=${versionName})`);
        return true;
      }
      throw new Error('写后校验不符');
    } catch (err) {
      logError(`换版令牌写入第 ${attempt} 次失败`, err);
    }
  }
  process.stderr.write(`[switcher] 换版令牌写入失败（已重试）——常驻壳不会自动换版，请手动重启 serve/窗口\n`);
  return false;
}

/** 统一失败出口：写日志 + switch-failure.json + RESULT_JSON + exit 1 */
function fail(step, errorCode, reason, guidance) {
  const report = {
    success: false,
    time: new Date().toISOString(),
    step,
    errorCode: errorCode || '',
    reason,
    guidance
  };
  logError(`[FAIL] 步骤[${step}] ${reason}（${errorCode || '无错误码'}）→ 指导: ${guidance}`, null);
  try {
    fs.writeFileSync(FAILURE_FILE, JSON.stringify(report, null, 2));
  } catch (err) {
    logError('写入 switch-failure.json 失败', err);
  }
  emitResult(report);
  process.exit(1);
}

/** 统一成功出口：清除 switch-failure.json + RESULT_JSON。
 *  extra.warning 存在时（切换成功但收尾清理未彻底）改为写入 severity:'warning' 报告，
 *  供 CLI 下次启动向用户提示；硬失败报告（fail()）语义不变。 */
function succeed(extra) {
  try {
    if (extra && extra.warning) {
      fs.writeFileSync(FAILURE_FILE, JSON.stringify({
        success: true,
        severity: 'warning',
        time: new Date().toISOString(),
        step: '清理workcopy',
        errorCode: '',
        reason: extra.warning,
        guidance: '版本切换已成功，仅收尾清理未彻底。手动删除残留的 chill-workcopy 即可（或留待下次自迭代第一步自动识别处理）；若反复出现，检查是否有进程占用 workcopy（体验窗口/终端/编辑器）或杀毒软件拦截。'
      }, null, 2));
    } else if (fs.existsSync(FAILURE_FILE)) fs.unlinkSync(FAILURE_FILE);
  } catch (err) {
    logError('处理 switch-failure.json 失败（不影响）', err);
  }
  emitResult({ success: true, ...extra });
  process.exit(0);
}

// === 参数解析 ===
const cliArgs = process.argv.slice(2);
// M3.2（版本切换接续规划）：--ui electron 可选变体（体验/演示窗的 Electron 形态）——
// 旗标对（--ui electron）从位置参数中剔除后再解析模式与路径
const uiFlagIdx = cliArgs.indexOf('--ui');
const uiElectron = uiFlagIdx !== -1 && cliArgs[uiFlagIdx + 1] === 'electron';
const modeArgs = uiFlagIdx === -1 ? cliArgs : cliArgs.filter((_, i) => i !== uiFlagIdx && i !== uiFlagIdx + 1);
const KNOWN_FLAGS = ['--rollback', '--launch', '--preview', '--delete', '--ui'];
// 事务防线①（2026-10-05 事故根治：`--switch` 被发明出来当参数用，落入切换模式后被当作
// <chill路径> 位置参数消费 → parentDir='.' → 切出垃圾 junction `助手\--switch`、真 chill 未动、
// current.json 指针漂移、回滚依据被抹）——未知旗标一律硬失败，杜绝同类人祸入口
const firstModeArg = modeArgs[0];
if (typeof firstModeArg === 'string' && firstModeArg.startsWith('--') && !KNOWN_FLAGS.includes(firstModeArg)) {
  logRunHeader();
  log(`未知旗标: ${firstModeArg}`);
  fail('参数校验', 'UNKNOWN_FLAG', `未知参数: ${firstModeArg}（本工具没有这个旗标）`,
    '切换模式不需要旗标：node switcher.js <chill路径>；合法旗标仅有 --rollback/--launch/--preview/--delete/--ui electron。');
}
const rollbackMode = modeArgs[0] === '--rollback';
const launchMode = modeArgs[0] === '--launch';
const previewMode = modeArgs[0] === '--preview';
const deleteMode = modeArgs[0] === '--delete';
const projectPath = (rollbackMode || launchMode || previewMode || deleteMode) ? modeArgs[1] : modeArgs[0];
// --rollback 可选版本参数：缺省时回滚到 current.json 记录的上一版本
const rollbackVersion = rollbackMode ? (modeArgs[2] || '') : '';
// --delete 必填版本参数（精确匹配，防误删）
const deleteVersionName = deleteMode ? (modeArgs[2] || '') : '';
if (!projectPath) {
  logRunHeader();
  logError('未提供 projectPath 参数');
  fail('参数解析', '', '未提供 projectPath 参数', '用法: node switcher.js [--rollback <chill路径> [版本] | --launch <chill路径> | --preview <chill路径>] <chill路径>');
}
// 事务防线②（同上事故根治）：projectPath 合法性三查——basename 必须 === 'chill'（布局不变量；
// 连带拒绝把 chill-workcopy 等「长得像 chill 树的错误目标」当切换对象——workcopy 会被首迁移
// 分支改名销毁，是本防线必须堵住的混淆形态）、解析后存在、realpath 下是 chill 树。
// 相对路径按 CWD 解析后必须命中真布局。
{
  const resolved = path.resolve(projectPath);
  let real = '';
  try { real = fs.realpathSync(resolved) } catch { /* 不存在 */ }
  const looksLikeChill = !!real &&
    (fs.existsSync(path.join(real, 'packages')) || fs.existsSync(path.join(real, 'pnpm-workspace.yaml')));
  const namedChill = path.basename(resolved).toLowerCase() === 'chill';
  if (!looksLikeChill || !namedChill) {
    logRunHeader();
    log(`projectPath 校验失败: ${projectPath}（resolve=${resolved}，realpath=${real || '不可解析'}，basename=${path.basename(resolved)}）`);
    fail('参数校验', 'BAD_CHILL_PATH', `chill 路径不合法: ${projectPath}（必须是名为 chill 的 chill 树，不能是 workcopy/其他目录）`,
      '期望指向名为 chill 的 chill 树（junction 或目录，内含 packages/）。请核对路径；切换模式用法: node switcher.js <chill路径>（无旗标）。');
  }
}

const parentDir = path.dirname(projectPath);
const versionsDir = path.join(parentDir, 'chill-versions');
const workcopyPath = path.join(parentDir, 'chill-workcopy');
const chillNewPath = path.join(parentDir, 'chill-new');
const currentJsonPath = path.join(versionsDir, 'current.json');
const NO_LAUNCH = process.env.SWITCHER_NO_LAUNCH === '1';

logRunContext();

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

/**
 * 带 retry 的 renameSync，返回最后一次错误的 code（全部失败时）
 * Windows 上 rename 可能因瞬态文件锁（如杀毒软件扫描）暂时失败
 */
function renameWithRetry(src, dst, label, retries = 3, intervalMs = 1000) {
  let lastCode = '';
  for (let i = 1; i <= retries; i++) {
    try {
      fs.renameSync(src, dst);
      log(`[${label}] rename 成功（第 ${i} 次）: ${src} → ${dst}`);
      return { ok: true };
    } catch (err) {
      lastCode = err.code || '';
      logError(`[${label}] rename 第 ${i} 次失败`, err);
      if (i < retries) {
        log(`[${label}] 等待 ${intervalMs}ms 后重试...`);
        sleepSync(intervalMs);
      }
    }
  }
  return { ok: false, code: lastCode };
}

/** 判断路径是否为 junction/symlink（lstat 不跟随链接） */
function isJunction(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function makeTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 在 versionsDir 下生成不冲突的版本目录路径 */
function uniqueVersionDir(baseName) {
  let candidate = path.join(versionsDir, baseName);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(versionsDir, `${baseName}-${n++}`);
  }
  return candidate;
}

/**
 * 递归删除（文件/目录/不存在均可，替代 fs.rmSync）。
 * 不用 fs.rmSync：本机 Node 24 在含非 ASCII 字符（如"助手"）的路径下，
 * fs.rmSync 无论递归与否、文件或目录都会静默失败（正常返回但不删除）；
 * 经典 unlinkSync/rmdirSync 单层调用正常（rmverify 五场景实测）。
 * junction/符号链接只删链接（rmdirSync），不递归进目标——workcopy 的
 * node_modules 含 pnpm workspace 符号链接，误入会误删真实包目录。
 * 探测必须直接用 lstatSync 而非 existsSync：existsSync 跟随链接，
 * 目标已删的悬空符号链接会被误判"不存在"而跳过，父目录 ENOTEMPTY
 * （pnpm node_modules 场景必现，曾导致 workcopy 清理静默失败）。
 */
function removeRecursive(p) {
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // 路径不存在
  }
  if (stat.isSymbolicLink()) {
    fs.rmdirSync(p);
    return;
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(p);
    return;
  }
  for (const name of fs.readdirSync(p)) {
    removeRecursive(path.join(p, name));
  }
  fs.rmdirSync(p);
}

/** 递归清理 .backup-* 文件 */
function removeBackupFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.name.includes('.backup-')) {
      removeRecursive(fullPath);
      log(`已删除备份文件: ${entry.name}`);
    } else if (entry.isDirectory() && entry.name !== 'node_modules') {
      removeBackupFiles(fullPath);
    }
  }
}

/** 清理 chill-new 临时 junction（上次失败残留） */
function cleanupChillNew() {
  if (!fs.existsSync(chillNewPath)) return;
  try {
    fs.rmdirSync(chillNewPath);
    log('已清理残留的 chill-new junction');
  } catch (err) {
    logError('清理 chill-new 失败（非 junction？继续执行可能被 rename 覆盖失败）', err);
  }
}

/**
 * 切换 junction：chill-new → projectPath
 * 失败时用 restoreTarget 恢复旧 junction，返回是否成功
 */
function switchJunction(restoreTarget) {
  try {
    if (isJunction(projectPath)) {
      fs.rmdirSync(projectPath);
      log(`已删除旧 junction: ${projectPath}`);
    }
    fs.renameSync(chillNewPath, projectPath);
    log(`junction 切换完成: ${projectPath} → ${fs.realpathSync(projectPath)}`);
    return true;
  } catch (err) {
    logError('junction 切换失败，尝试恢复旧 junction', err);
    if (!fs.existsSync(projectPath) && restoreTarget) {
      try {
        fs.symlinkSync(restoreTarget, projectPath, 'junction');
        log(`已恢复旧 junction: ${projectPath} → ${restoreTarget}`);
      } catch (e2) {
        logError('恢复旧 junction 失败！请手动重建 junction', e2);
      }
    }
    return false;
  }
}

/** 启动新版本 CLI（bat 注入 CHILL_HOME 锚点）——仅 --launch 模式使用 */
function launchNewCli() {
  // M3.2：--launch --ui electron = junction 演示窗（模型展示窗原语；路径在 spawn 时刻解析必穿新 junction）
  if (uiElectron) return spawnElectronWindow(projectPath, '启动Electron演示窗');
  const cliPath = path.join(projectPath, 'packages', 'cli', 'dist', 'cli.js');
  log(`CLI 路径: ${cliPath}`);
  log(`CLI 文件是否存在: ${fs.existsSync(cliPath)}`);

  if (!fs.existsSync(cliPath)) {
    fail('启动新版本', '', `CLI 文件不存在: ${cliPath}`, '该版本目录不完整。若是回滚场景，请换其他版本；若是切换场景，请检查 workcopy 是否执行过 pnpm build:cli。');
  }

  const batPath = path.join(__dirname, '_launch.bat');
  try {
    fs.writeFileSync(batPath, `@chcp 65001 >nul\r\n@set "CHILL_HOME=${projectPath}"\r\n@node "${cliPath}"\r\n@pause\r\n`);
    log(`bat 文件已写入: ${batPath}（CHILL_HOME=${projectPath}）`);
  } catch (err) {
    fail('启动新版本', err.code, `写入启动脚本失败: ${err.message}`, '检查 chill-guardian 目录是否可写，或被杀毒软件拦截。');
  }

  if (NO_LAUNCH) {
    log('SWITCHER_NO_LAUNCH=1，跳过启动新窗口');
    succeed({ launched: false, batPath });
  }

  const child = spawn('cmd', ['/c', 'start', '""', batPath], {
    cwd: parentDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  log(`spawn 子进程 PID: ${child.pid}`);
  child.on('error', (err) => {
    logError('spawn error 事件触发', err);
  });
  succeed({ launched: true, pid: child.pid });
}

/** M3.2（版本切换接续规划）：Electron 窗启动——/ui 形态 1 同款 spawn 链
 *  （node electron-cli <root>；cwd=root、NODE_ENV=production）。
 *  root=workcopyPath（--preview 体验验收窗，体验识别走目录探测与 M2.1 同源）或
 *  projectPath（--launch junction 演示窗——路径在 spawn 时刻解析，必穿当前 junction）。 */
function spawnElectronWindow(root, label) {
  const electronMain = path.join(root, 'packages', 'electron', 'dist', 'electron-main.js');
  const electronCli = path.join(root, 'packages', 'electron', 'node_modules', 'electron', 'cli.js');
  log(`Electron main 是否存在: ${fs.existsSync(electronMain)}；electron cli 是否存在: ${fs.existsSync(electronCli)}`);
  if (!fs.existsSync(electronMain) || !fs.existsSync(electronCli)) {
    fail(label, '', `Electron 未就绪（缺 dist 或 node_modules）: ${root}`, '请先在自迭代流程完成 pnpm install 与构建（electron dist），再开 Electron 窗。');
  }
  if (NO_LAUNCH) {
    log('SWITCHER_NO_LAUNCH=1，跳过 Electron 窗启动');
    succeed({ launched: false });
  }
  const child = spawn(process.execPath, [electronCli, root], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production' }
  });
  child.unref();
  log(`Electron 窗已 spawn（root=${root}, pid=${child.pid}）`);
  succeed({ launched: true, pid: child.pid });
}

/** 启动体验窗口（workcopy 预览）——仅 --preview 模式使用。
 *  bat 仿 _launch.bat 全形态（chcp 65001 防乱码、pause 兜底），但不注入 CHILL_HOME：
 *  模式判定只依赖模块物理位置、不读环境变量（projectPaths.ts 头部："曾是事故根因"），
 *  体验版识别走 __dirname 含 'chill-workcopy' 段，与 CHILL_HOME 无关（_launch.bat 里的是历史残留）。
 *  CWD=父目录由 spawn 选项代码强制（CWD 落在 workcopy 内会锁定目录阻碍切换后清理）——
 *  从"模型遵守约定"升级为"代码供给"。 */
function launchPreviewCli() {
  log(`workcopy 是否存在: ${fs.existsSync(workcopyPath)}`);
  if (!fs.existsSync(workcopyPath)) {
    fail('启动体验窗口', '', `workcopy 不存在: ${workcopyPath}`, '尚无进行中的自迭代 workcopy（先完成一次自迭代，或 workcopy 已被清理）。');
  }
  // M3.2：--preview --ui electron = workcopy 验收窗的 Electron 形态（改了桌面 UI 时的验收台）
  if (uiElectron) return spawnElectronWindow(workcopyPath, '启动Electron体验窗');
  const cliPath = path.join(workcopyPath, 'packages', 'cli', 'dist', 'cli.js');
  log(`CLI 路径: ${cliPath}`);
  log(`CLI 文件是否存在: ${fs.existsSync(cliPath)}`);
  if (!fs.existsSync(cliPath)) {
    fail('启动体验窗口', '', `CLI 文件不存在: ${cliPath}`, 'workcopy 未完成编译。请先让模型在自迭代流程中执行 pnpm build:cli 后再打开体验窗口。');
  }

  const batPath = path.join(__dirname, '_preview.bat');
  try {
    fs.writeFileSync(batPath, `@chcp 65001 >nul\r\n@node "${cliPath}"\r\n@pause\r\n`);
    log(`bat 文件已写入: ${batPath}`);
  } catch (err) {
    fail('启动体验窗口', err.code, `写入启动脚本失败: ${err.message}`, '检查 chill-guardian 目录是否可写，或被杀毒软件拦截。');
  }

  if (NO_LAUNCH) {
    log('SWITCHER_NO_LAUNCH=1，跳过启动体验窗口');
    succeed({ launched: false, batPath });
  }

  const child = spawn('cmd', ['/c', 'start', '""', batPath], {
    cwd: parentDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  log(`spawn 子进程 PID: ${child.pid}（CWD=${parentDir}）`);
  child.on('error', (err) => {
    logError('spawn error 事件触发', err);
  });
  succeed({ launched: true, pid: child.pid });
}

/**
 * rename 失败的鉴别诊断（探针均为只读/瞬时还原）
 * 返回 { reason, guidance }
 */
function diagnoseRenameFailure(errCode) {
  log(`开始鉴别诊断，错误码: ${errCode}`);
  if (errCode === 'EBUSY') {
    return {
      reason: '占用锁：有进程的工作目录在 chill 内，或持有 chill 的文件句柄（如终端 cd 进了 chill、以 chill 为根目录打开的编辑器）',
      guidance: '关闭 cd 进 chill 目录的终端、以 chill 为根目录打开的编辑器/IDE，然后重新执行 /switch-version。'
    };
  }
  if (errCode === 'EPERM') {
    // 探针A：删除是否被允许（非空目录应报 ENOTEMPTY；报 EPERM/EBUSY 说明删除也被拒）
    let deleteAllowed = false;
    try {
      fs.rmdirSync(projectPath);
    } catch (e) {
      deleteAllowed = e.code === 'ENOTEMPTY';
      log(`探针A（rmdir）: ${e.code} → 删除${deleteAllowed ? '被允许' : '被拒绝'}`);
    }
    // 探针B：子目录是否可改名（瞬时改名并还原）
    let childRenamable = false;
    const probeChild = path.join(projectPath, 'packages');
    if (fs.existsSync(probeChild)) {
      try {
        fs.renameSync(probeChild, probeChild + '-probe');
        fs.renameSync(probeChild + '-probe', probeChild);
        childRenamable = true;
      } catch (e) {
        log(`探针B（rename chill/packages）: ${e.code} → 子目录${childRenamable ? '可' : '不可'}改名`);
      }
      log(`探针B: 子目录${childRenamable ? '可改名' : '不可改名'}`);
    }
    if (deleteAllowed && childRenamable) {
      return {
        reason: '策略锁：chill 目录被安全软件（企业 DLP/数据防泄漏）或 OneDrive"始终保留"钉住，策略性拒绝其重命名（删除、复制、内部操作均被允许，仅 rename 被拒）',
        guidance: '按优先级尝试：① 重启电脑后立即重新 /switch-version；② 在安全软件/DLP 中将 chill 目录加白名单；③ 解除 OneDrive 对该目录的"始终保留在此设备上"标记。'
      };
    }
    return {
      reason: '混合占用/权限问题：chill 目录的删除或子目录改名也被拒绝',
      guidance: '关闭可能占用 chill 的程序（终端、编辑器、资源管理器窗口），重启电脑后重新 /switch-version。'
    };
  }
  return {
    reason: `未知错误（${errCode || '无错误码'}）`,
    guidance: '查看 chill-guardian/switcher-debug.log 与 switch-failure.json 获取详情，必要时重启后重试。'
  };
}

/**
 * 主流程：固化 workcopy 为新版本并切换 junction
 */
async function main() {
  // 切换模式独占日志：截断后重写运行头与运行上下文（其余模式追加写——失败现场不再自毁）
  fs.writeFileSync(LOG_FILE, '');
  logRunHeader();
  logRunContext();
  log('=== main() 开始（切换模式）===');

  // 1. 检查 workcopy 是否存在
  log('--- 步骤1: 检查 workcopy ---');
  if (!fs.existsSync(workcopyPath)) {
    fail('检查workcopy', '', 'workcopy 目录不存在，没有待切换的版本', '请先完成一次自迭代（或 workcopy 已被清理）。');
  }

  // 2. 准备版本目录
  log('--- 步骤2: 生成版本目录名 ---');
  fs.mkdirSync(versionsDir, { recursive: true });
  const versionDir = uniqueVersionDir(`v${makeTimestamp()}`);
  const versionName = path.basename(versionDir);
  log(`版本目录: ${versionDir}`);

  // 3. robocopy 固化 workcopy → 版本目录（排除 node_modules，依赖在步骤4重建；排除 .ready-for-switch；
  //    排除 target——Rust 构建缓存由父目录 chill-rust-target 共享，workcopy 内是 junction，
  //    robocopy 默认会遍历 junction 把 1.5GB 缓存实化进快照，必须排除；
  //    排除 .git——快照不需要版本历史，且 .git/config 可能含 remote 凭据，复制即扩散）
  log('--- 步骤3: robocopy 固化 workcopy ---');
  const rob = spawnSync('robocopy', [
    workcopyPath, versionDir, '/E',
    '/XD', 'node_modules', 'target', '.git',
    '/XF', '.ready-for-switch',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP'
  ], { encoding: 'utf8', windowsHide: true });
  const robCode = rob.status === null ? 999 : rob.status;
  log(`robocopy 退出码: ${robCode}`);
  if (rob.error) logError('robocopy spawn 异常', rob.error);
  if (robCode >= 8) {
    const tail = `${(rob.stdout || '').slice(-500)} ${(rob.stderr || '').slice(-500)}`.trim();
    removeRecursive(versionDir);
    fail('robocopy固化', `ROBOCOPY_${robCode}`, `复制 workcopy 失败（robocopy 退出码 ${robCode}）${tail ? ': ' + tail : ''}`, '检查磁盘剩余空间，以及杀毒软件是否拦截了文件复制；workcopy 未受影响，处理后重新 /switch-version。');
  }

  // 3b. 防漂移守卫：Rust 构建缓存不应进入版本快照（正常永不存在——上游 skill/robocopy 均排除 target）。
  //     若存在，说明排除清单发生漂移（robocopy 已遍历 junction 实化出 1.5GB 缓存），显式告警，快照照常可用。
  const versionTargetDir = path.join(versionDir, 'packages', 'native-desktop', 'target');
  if (fs.existsSync(versionTargetDir)) {
    logError(`[防漂移守卫] 版本快照中出现了不该存在的 ${versionTargetDir}（Rust 构建缓存被复制进来了）。` +
      `请检查 self-iterate skill 第四步与本脚本步骤3的 /XD 排除清单是否发生漂移。快照继续，但体积异常偏大。`);
  }

  // 4. pnpm install 重建依赖（利用全局 store 硬链接，秒级完成）
  log('--- 步骤4: pnpm install ---');
  try {
    execSync('pnpm install', {
      cwd: versionDir, stdio: 'pipe', windowsHide: true, timeout: 300000,
      env: { ...process.env, CI: 'true' }
    });
    log('依赖安装完成');
  } catch (err) {
    logError('pnpm install 失败', err);
    removeRecursive(versionDir);
    fail('安装依赖', err.code, `新版本依赖安装失败: ${(err.message || '').slice(0, 300)}`, '检查网络与代理设置；可手动在新版本目录执行 pnpm install 查看真实报错；workcopy 未受影响。');
  }

  // 5. 门禁检查：CLI 产物必须存在
  log('--- 步骤5: 门禁检查 cli.js ---');
  const versionCliPath = path.join(versionDir, 'packages', 'cli', 'dist', 'cli.js');
  if (!fs.existsSync(versionCliPath)) {
    removeRecursive(versionDir);
    fail('门禁检查', '', 'workcopy 中缺少编译产物 packages/cli/dist/cli.js', 'workcopy 未完成编译。请让模型在自迭代流程中执行 pnpm build:cli 后再切换。');
  }

  // 6. 写入 .version.json，并把最新 iteration 记录改名为与版本目录同名（一一对应）
  log('--- 步骤6: 写入 .version.json + 关联 iteration 记录 ---');
  let goal = '';
  let archiveRecord = '';
  try {
    goal = (fs.readFileSync(path.join(workcopyPath, '.ready-for-switch'), 'utf-8').split('\n')[0] || '').trim();
  } catch { /* 无 ready 文件时留空 */ }
  try {
    const archiveDir = path.join(parentDir, 'chill-archive');
    const records = fs.readdirSync(archiveDir)
      .filter(f => /^iteration-v\d{8}-\d{6}\.json$/.test(f))
      .sort((a, b) => b.localeCompare(a));
    if (records.length > 0) {
      // 三件套（json / verify.md / verify.ps1）统一改名为版本目录同名
      const recordTs = records[0].match(/^iteration-v(\d{8}-\d{6})\.json$/)[1];
      const trio = [
        `iteration-v${recordTs}.json`,
        `iteration-v${recordTs}.verify.md`,
        `iteration-v${recordTs}.verify.ps1`,
      ];
      for (const name of trio) {
        const srcPath = path.join(archiveDir, name);
        if (!fs.existsSync(srcPath)) continue;
        const ext = name.slice(`iteration-v${recordTs}`.length);
        const dstName = `iteration-${versionName}${ext}`;
        const dstPath = path.join(archiveDir, dstName);
        if (name === dstName) {
          if (ext === '.json') archiveRecord = name;
          continue;
        }
        if (fs.existsSync(dstPath)) {
          log(`目标文件名已存在（同名秒冲突），保留原名: ${name}`);
          if (ext === '.json') archiveRecord = name;
          continue;
        }
        fs.renameSync(srcPath, dstPath);
        log(`已改名: ${name} → ${dstName}`);
        if (ext === '.json') archiveRecord = dstName;
      }
    } else {
      log('chill-archive 中无 iteration-v* 记录，archiveRecord 留空');
    }
  } catch (err) {
    logError('关联 iteration 记录失败（不影响切换）', err);
  }
  fs.writeFileSync(path.join(versionDir, '.version.json'), JSON.stringify({
    version: versionName,
    createdAt: new Date().toISOString(),
    source: 'workcopy',
    goal,
    archiveRecord
  }, null, 2));
  log(`.version.json 已写入（goal: ${goal}，archiveRecord: ${archiveRecord}）`);

  // 7. 记录 prevTarget（junction → realpath；真实目录 → 首次迁移改名）
  log('--- 步骤7: 处理现有 chill ---');
  let prevTarget = null;
  if (isJunction(projectPath)) {
    prevTarget = fs.realpathSync(projectPath);
    log(`chill 是 junction，当前指向: ${prevTarget}`);
  } else if (fs.existsSync(projectPath)) {
    const legacyDir = uniqueVersionDir(`v-legacy-${makeTimestamp()}`);
    log(`chill 是真实目录，首次迁移: ${projectPath} → ${legacyDir}`);
    const mig = renameWithRetry(projectPath, legacyDir, '首次迁移', 15, 1000);
    if (!mig.ok) {
      const diag = diagnoseRenameFailure(mig.code);
      removeRecursive(versionDir);
      fail('首次迁移', mig.code, diag.reason, diag.guidance);
    }
    prevTarget = legacyDir;
  } else {
    // 事务防线③（2026-10-05 事故根治）：到达此处=入口校验后路径又消失（竞态/被并发清理）。
    // 旧语义「chill 不存在（异常状态），将直接创建 junction」会把调用方的错误静默吞掉继续跑——
    // 本次改为硬失败（真需要重建布局走 freeze.js --repair）
    fail('前置检查', 'CHILL_MISSING', `chill 路径不存在: ${projectPath}`,
      '布局异常（入口校验时存在、执行时消失——可能被并发操作清理）。若 junction 丢失，用 node chill-guardian/freeze.js --repair --build 修复后再切换。');
  }

  // 8. 创建临时 junction chill-new → 新版本
  log('--- 步骤8: 创建 chill-new junction ---');
  cleanupChillNew();
  try {
    fs.symlinkSync(versionDir, chillNewPath, 'junction');
    log(`chill-new junction 已创建: ${chillNewPath} → ${versionDir}`);
  } catch (err) {
    logError('创建 chill-new junction 失败', err);
    // 恢复首次迁移（若发生过）
    if (prevTarget && path.basename(prevTarget).startsWith('v-legacy') && !fs.existsSync(projectPath)) {
      renameWithRetry(prevTarget, projectPath, '迁移回滚');
    }
    fail('创建junction', err.code, `创建临时 junction 失败: ${err.message}`, '检查杀毒软件是否拦截了 junction 创建；chill 目录已尝试恢复原状。');
  }

  // 9. 原子切换 junction
  log('--- 步骤9: 切换 junction ---');
  if (!switchJunction(prevTarget)) {
    fail('切换junction', '', 'junction 切换失败（已尝试恢复旧版本）', '查看 switcher-debug.log。若 chill 入口丢失，将 chill-versions 中对应版本目录改名回 chill 即可恢复。');
  }

  // 9.5 结果断言（事务核心，2026-10-05 事故根治）：成功的唯一定义 = junction 真指向新版本目录。
  //     「流程走完」不等于「切换成功」——断言不过即回滚（恢复旧 junction + 删新版本目录），
  //     绝不带假成功出门（旧实现 RESULT_JSON success 但真 chill 从未被碰的事故形态）
  log('--- 步骤9.5: 结果断言（junction → 新版本）---');
  {
    let switchedReal = null;
    try { switchedReal = fs.realpathSync(projectPath) } catch { /* 不可解析 */ }
    const ok = switchedReal !== null &&
      path.normalize(switchedReal).toLowerCase() === path.normalize(versionDir).toLowerCase();
    log(`断言: realpath(${projectPath}) = ${switchedReal ?? '不可解析'}，期望 ${versionDir} → ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
      if (prevTarget && !fs.existsSync(projectPath)) {
        try {
          fs.symlinkSync(prevTarget, projectPath, 'junction');
          log(`[断言回滚] 已恢复旧 junction: ${projectPath} → ${prevTarget}`);
        } catch (e2) {
          logError('[断言回滚] 恢复旧 junction 失败！请手动重建', e2);
        }
      }
      removeRecursive(versionDir);
      fail('结果断言', 'ASSERTION_FAILED',
        `切换后 junction 未指向新版本（realpath=${switchedReal ?? '不可解析'}，期望 ${versionDir}）——已回滚`,
        '查看 switcher-debug.log 步骤8/9/9.5；常见原因：projectPath 计算被相对路径/并发操作干扰。');
    }
  }

  // 10. 记录 current.json（回滚依据）
  //     事务保证：到达此处时 prevTarget 必非空（步骤7 的「不存在」分支已改为硬失败，
  //     junction/真实目录两分支均赋值）——previousPath=null 的回滚链断裂形态（2026-10-05 事故
  //     第四层伤害）从根上不可能再出现
  log('--- 步骤10: 写入 current.json ---');
  fs.writeFileSync(currentJsonPath, JSON.stringify({
    current: versionName,
    currentPath: versionDir,
    previousPath: prevTarget,
    at: new Date().toISOString()
  }, null, 2));
  log(`current.json: current=${versionName}, previous=${prevTarget}`);

  // 10.5 current.json 回读断言（不变量组第二成员：junction ↔ current.json ↔ 版本目录 三方一致）
  log('--- 步骤10.5: current.json 回读断言 ---');
  {
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(currentJsonPath, 'utf-8')) } catch { /* 损坏 */ }
    const curOk = cur && cur.current === versionName &&
      typeof cur.previousPath === 'string' && cur.previousPath.length > 0;
    log(`断言: current=${cur?.current}（期望 ${versionName}），previousPath=${cur?.previousPath ?? '缺失'} → ${curOk ? 'PASS' : 'FAIL'}`);
    if (!curOk) {
      fail('结果断言', 'CURRENT_JSON_ASSERTION',
        `current.json 回读不符（current=${cur?.current}，previousPath=${cur?.previousPath}）`,
        '切换已生效但回滚依据记录异常——请勿删除旧版本目录，并检查 current.json 写入是否被占用/只读属性干扰。');
    }
  }

  // 11. 清理 workcopy（先删 .ready-for-switch，防止新 CLI 误报待切换状态）
  log('--- 步骤11: 清理 workcopy ---');
  const readyPath = path.join(workcopyPath, '.ready-for-switch');
  const cleanupWarnings = [];
  try {
    fs.unlinkSync(readyPath);
    log('已删除 workcopy/.ready-for-switch');
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('.ready-for-switch 不存在，跳过');
    } else {
      logError('[警告] .ready-for-switch 删除失败！新 CLI 可能误报待切换状态，请手动删除', err);
      cleanupWarnings.push(`.ready-for-switch 删除失败（${err.code || err.message}），新 CLI 可能误报待切换状态`);
    }
  }
  // workcopy 删除带重试：EPERM/EBUSY/ENOTEMPTY（杀毒软件/索引器瞬时占用）sleep 1s 后整树重试，
  // 至多 15 次（复用 sleepSync，对齐 renameWithRetry 先例）；其他错误立即放弃。
  // 仅包裹本调用点，removeRecursive 函数本体不动（其余调用点语义不变）。
  const RETRYABLE_DELETE_CODES = ['EPERM', 'EBUSY', 'ENOTEMPTY'];
  let cleaned = false;
  let lastCleanupErr = null;
  for (let i = 1; i <= 15; i++) {
    try {
      removeRecursive(workcopyPath);
      cleaned = true;
      log(i === 1 ? 'workcopy 已清理' : `workcopy 已清理（第 ${i} 次尝试）`);
      break;
    } catch (err) {
      lastCleanupErr = err;
      if (!RETRYABLE_DELETE_CODES.includes(err.code)) break;
      logError(`workcopy 清理第 ${i} 次失败（${err.code}）${i < 15 ? '，等待 1s 重试' : '，已达重试上限'}`, err);
      if (i < 15) sleepSync(1000);
    }
  }
  if (!cleaned) {
    logError('workcopy 清理失败（残留，无 .ready-for-switch，下次迭代第一步会识别处理）', lastCleanupErr);
    cleanupWarnings.push(`workcopy 清理失败、存在残留（${lastCleanupErr.code || '无错误码'}：${lastCleanupErr.message}）`);
  }
  removeBackupFiles(versionDir);
  log('已清理版本目录中的备份文件');

  log('=== 切换完成 ===');
  // 换版令牌（M1.2）：junction 已重指（步骤9）→ 令牌随后（真相先于信号）；失败大声报但不逆转切换
  writeSwitchToken(versionName);
  succeed({
    version: versionName,
    versionDir,
    previousPath: prevTarget,
    ...(cleanupWarnings.length > 0 ? { warning: cleanupWarnings.join('；') } : {})
  });
}

/**
 * 删除历史版本：--delete <chill路径> <版本名（精确匹配）>
 * 安全检查：当前运行版本、current.json previousPath（默认回滚目标）均拒删；
 * 删除走 removeRecursive（fs.rmSync 在本机中文路径下静默失败，详见函数注释）；
 * 删后复查目录确实消失，防止任何"静默失败"被误报成功。
 */
async function deleteVersion() {
  log('=== deleteVersion() 开始 ===');
  log(`指定版本参数: ${deleteVersionName || '(缺失)'}`);
  if (!deleteVersionName) {
    fail('删除参数校验', '', '未提供版本名', '用法: node switcher.js --delete <chill路径> <版本名>。');
  }
  if (path.basename(deleteVersionName) !== deleteVersionName) {
    fail('删除参数校验', '', `非法版本名: ${deleteVersionName}`, '版本名只能是 chill-versions 下的目录名，不能包含路径分隔符。');
  }
  const target = path.join(versionsDir, deleteVersionName);
  if (!fs.existsSync(target)) {
    fail('删除版本校验', '', `版本不存在: ${deleteVersionName}`, '输入 /rollback 或 /delete-version 查看可用版本列表。');
  }
  // 当前运行版本拒删（junction 指向谁，谁就是当前版本；真实目录则自身是当前）
  let currentReal = '';
  try {
    if (isJunction(projectPath)) currentReal = fs.realpathSync(projectPath);
    else if (fs.existsSync(projectPath)) currentReal = projectPath;
  } catch { /* 判定失败按非当前处理 */ }
  const targetReal = fs.realpathSync(target);
  if (currentReal && path.normalize(currentReal).toLowerCase() === path.normalize(targetReal).toLowerCase()) {
    fail('删除版本校验', '', `${deleteVersionName} 是当前正在运行的版本，不能删除`, '请先 /rollback 切换到其他版本后再删除。');
  }
  // 默认回滚目标（current.json previousPath）拒删
  if (fs.existsSync(currentJsonPath)) {
    try {
      const cur = JSON.parse(fs.readFileSync(currentJsonPath, 'utf-8'));
      if (cur.previousPath && fs.existsSync(cur.previousPath) &&
          path.normalize(cur.previousPath).toLowerCase() === path.normalize(targetReal).toLowerCase()) {
        fail('删除版本校验', '', `${deleteVersionName} 是默认回滚目标（current.json 的 previousPath），不能删除`, '先做一次版本切换或回滚改变 previousPath 指向，再删除该版本。');
      }
    } catch { /* current.json 损坏不阻塞删除 */ }
  }
  removeRecursive(target);
  if (fs.existsSync(target)) {
    fail('删除版本', '', `删除后目录仍存在: ${target}`, '检查文件占用（资源管理器、编辑器、终端 CWD、杀毒软件）后重试，或手动删除。');
  }
  log(`版本已删除: ${deleteVersionName}`);
  succeed({ version: deleteVersionName });
}

/**
 * 回滚：junction 拨回指定版本（或 current.json 记录的上一版本）
 */
async function rollback() {
  log('=== rollback() 开始 ===');
  log(`指定版本参数: ${rollbackVersion || '(缺省，用 current.json)'}`);

  // 当前指向（回滚后成为新的 previous）
  let awayPath = null;
  if (isJunction(projectPath)) {
    awayPath = fs.realpathSync(projectPath);
  } else if (fs.existsSync(projectPath)) {
    awayPath = projectPath;
  }
  log(`当前指向: ${awayPath}`);

  let target = null;

  if (rollbackVersion) {
    // === 指定版本模式 ===
    if (path.basename(rollbackVersion) !== rollbackVersion) {
      fail('回滚参数校验', '', `非法版本名: ${rollbackVersion}`, '版本名只能是 chill-versions 下的目录名，不能包含路径分隔符。输入 /rollback 查看可用版本。');
    }
    let candidates = [];
    try {
      candidates = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch { /* versionsDir 不存在 → candidates 为空 */ }
    const exact = candidates.filter(n => n === rollbackVersion);
    const matched = exact.length > 0 ? exact : candidates.filter(n => n.startsWith(rollbackVersion));
    if (matched.length === 0) {
      fail('回滚版本校验', '', `版本不存在: ${rollbackVersion}`, '输入 /rollback 查看可用版本列表。');
    }
    if (matched.length > 1) {
      fail('回滚版本校验', '', `版本前缀不唯一: ${rollbackVersion} 匹配到 ${matched.join(', ')}`, '请输入更完整的版本名，或输入 /rollback 交互选择。');
    }
    target = path.join(versionsDir, matched[0]);
    if (awayPath && path.normalize(target).toLowerCase() === path.normalize(awayPath).toLowerCase()) {
      fail('回滚版本校验', '', `${matched[0]} 已是当前版本，无需回滚`, '输入 /rollback 查看其他可用版本。');
    }
    log(`指定版本回滚目标: ${matched[0]}`);
  } else {
    // === 上一版本模式（current.json） ===
    if (!fs.existsSync(currentJsonPath)) {
      fail('回滚', '', '从未切换过版本，没有可回滚的记录', '完成一次版本切换后才可回滚。');
    }
    let cur;
    try {
      cur = JSON.parse(fs.readFileSync(currentJsonPath, 'utf-8'));
    } catch (err) {
      fail('回滚', err.code, '版本记录（current.json）损坏', `可手动查看 ${currentJsonPath} 修复，或选择其他版本目录回滚。`);
    }
    log(`current.json: ${JSON.stringify(cur)}`);
    target = cur.previousPath;
    if (!target || !fs.existsSync(target)) {
      fail('回滚', '', `上一版本目录已被删除: ${target}`, '输入 /rollback 查看其他可用版本。');
    }
    if (!awayPath && cur.currentPath && fs.existsSync(cur.currentPath)) {
      awayPath = cur.currentPath;
    }
  }

  cleanupChillNew();
  try {
    fs.symlinkSync(target, chillNewPath, 'junction');
    log(`chill-new junction 已创建: ${chillNewPath} → ${target}`);
  } catch (err) {
    fail('创建junction', err.code, `创建临时 junction 失败: ${err.message}`, '检查杀毒软件是否拦截了 junction 创建。');
  }

  if (!switchJunction(awayPath)) {
    fail('切换junction', '', '回滚切换失败（已尝试恢复原版本）', '查看 switcher-debug.log。若 chill 入口丢失，将 chill-versions 中对应版本目录改名回 chill 即可恢复。');
  }

  // 9.5 结果断言（事务核心，与 main 同款——2026-10-05 事故根治）：回滚成功的唯一定义 =
  // junction 真指向回滚目标；「流程走完」不等于「回滚成功」，断言不过即恢复并失败
  {
    let switchedReal = null;
    try { switchedReal = fs.realpathSync(projectPath) } catch { /* 不可解析 */ }
    const ok = switchedReal !== null &&
      path.normalize(switchedReal).toLowerCase() === path.normalize(target).toLowerCase();
    log(`[回滚断言] realpath(${projectPath}) = ${switchedReal ?? '不可解析'}，期望 ${target} → ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
      if (awayPath && !fs.existsSync(projectPath)) {
        try {
          fs.symlinkSync(awayPath, projectPath, 'junction');
          log(`[断言回滚] 已恢复 junction: ${projectPath} → ${awayPath}`);
        } catch (e2) {
          logError('[断言回滚] 恢复 junction 失败！请手动重建', e2);
        }
      }
      fail('结果断言', 'ASSERTION_FAILED',
        `回滚后 junction 未指向目标（realpath=${switchedReal ?? '不可解析'}，期望 ${target}）——已尝试恢复`,
        '查看 switcher-debug.log 的回滚段。');
    }
  }

  // 互换 current / previous，支持再次回滚（A↔B）
  fs.writeFileSync(currentJsonPath, JSON.stringify({
    current: path.basename(target),
    currentPath: target,
    previousPath: awayPath,
    at: new Date().toISOString()
  }, null, 2));
  log(`回滚完成: current=${path.basename(target)}, previous=${awayPath}`);

  // 换版令牌（M1.2）：回滚同款——长驻壳对回滚与切换一视同仁地自我接续
  writeSwitchToken(path.basename(target));
  succeed({ version: path.basename(target), versionDir: target, previousPath: awayPath });
}

const entry = launchMode ? launchNewCli : (previewMode ? launchPreviewCli : (rollbackMode ? rollback : (deleteMode ? deleteVersion : main)));
Promise.resolve(entry()).catch(err => {
  logError('未捕获异常', err);
  fail('未捕获异常', err.code, `switcher 内部错误: ${err.message}`, '查看 chill-guardian/switcher-debug.log 获取堆栈详情。');
});
