/**
 * 版本管理器 — 自迭代后的版本固化与 junction 切换
 * 独立脚本，不依赖项目代码
 *
 * 用法:
 *   node switcher.js <chill路径>                     固化 workcopy 为新版本并切换 junction（不启动新窗口）
 *   node switcher.js --rollback <chill路径> [版本]   回滚到指定版本（缺省为 current.json 记录的上一版本）
 *   node switcher.js --delete <chill路径> <版本>     删除指定历史版本（当前版本与默认回滚目标拒删）
 *   node switcher.js --launch <chill路径>            启动新版本 CLI 窗口（注入 CHILL_HOME）
 *
 * 输出协议: 结束时向 stdout 打印一行 RESULT_JSON:{...} 供调用方解析：
 *   成功: {"success":true,"version":"...","versionDir":"...","previousPath":"..."}
 *   失败: {"success":false,"step":"...","errorCode":"...","reason":"...","guidance":"..."}
 * 失败同时写入 __dirname/switch-failure.json（成功时删除），供 CLI 下次会话向用户/模型提示。
 *
 * 策略: Shadow Copy + junction 切换
 *   - robocopy 复制 workcopy → chill-versions/v<时间戳>/（复制不依赖任何进程状态）
 *   - chill 是 junction，切换 = 删除旧 junction + 重命名新 junction（不受文件句柄影响）
 *   - 旧版本完整保留在 chill-versions/ 中，支持 --rollback
 *   - chill 为真实目录时（首次运行）自动迁移为 junction 布局
 *
 * 测试支持: 环境变量 SWITCHER_NO_LAUNCH=1 时 --launch 模式只写 bat 不开窗
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

// 清空日志文件
fs.writeFileSync(LOG_FILE, '');
log('=== Switcher 调试日志 ===');
log(`Node 版本: ${process.version}`);
log(`进程 PID: ${process.pid}`);
log(`父进程 PID: ${process.ppid}`);
log(`参数: ${JSON.stringify(process.argv)}`);

// === 结果输出协议 ===
function emitResult(obj) {
  process.stdout.write(`RESULT_JSON:${JSON.stringify(obj)}\n`);
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

/** 统一成功出口：清除 switch-failure.json + RESULT_JSON */
function succeed(extra) {
  try {
    if (fs.existsSync(FAILURE_FILE)) fs.unlinkSync(FAILURE_FILE);
  } catch (err) {
    logError('清除 switch-failure.json 失败（不影响）', err);
  }
  emitResult({ success: true, ...extra });
  process.exit(0);
}

// === 参数解析 ===
const cliArgs = process.argv.slice(2);
const rollbackMode = cliArgs[0] === '--rollback';
const launchMode = cliArgs[0] === '--launch';
const deleteMode = cliArgs[0] === '--delete';
const projectPath = (rollbackMode || launchMode || deleteMode) ? cliArgs[1] : cliArgs[0];
// --rollback 可选版本参数：缺省时回滚到 current.json 记录的上一版本
const rollbackVersion = rollbackMode ? (cliArgs[2] || '') : '';
// --delete 必填版本参数（精确匹配，防误删）
const deleteVersionName = deleteMode ? (cliArgs[2] || '') : '';
if (!projectPath) {
  logError('未提供 projectPath 参数');
  fail('参数解析', '', '未提供 projectPath 参数', '用法: node switcher.js [--rollback <chill路径> [版本] | --launch <chill路径>] <chill路径>');
}

const parentDir = path.dirname(projectPath);
const versionsDir = path.join(parentDir, 'chill-versions');
const workcopyPath = path.join(parentDir, 'chill-workcopy');
const chillNewPath = path.join(parentDir, 'chill-new');
const currentJsonPath = path.join(versionsDir, 'current.json');
const NO_LAUNCH = process.env.SWITCHER_NO_LAUNCH === '1';

log(`模式: ${launchMode ? '启动' : rollbackMode ? '回滚' : '切换'}`);
log(`projectPath: ${projectPath}`);
log(`parentDir: ${parentDir}`);
log(`versionsDir: ${versionsDir}`);
log(`workcopyPath: ${workcopyPath}`);
log(`NO_LAUNCH: ${NO_LAUNCH}`);

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
  //    robocopy 默认会遍历 junction 把 1.5GB 缓存实化进快照，必须排除）
  log('--- 步骤3: robocopy 固化 workcopy ---');
  const rob = spawnSync('robocopy', [
    workcopyPath, versionDir, '/E',
    '/XD', 'node_modules', 'target',
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
    log('chill 不存在（异常状态），将直接创建 junction');
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

  // 10. 记录 current.json（回滚依据）
  log('--- 步骤10: 写入 current.json ---');
  fs.writeFileSync(currentJsonPath, JSON.stringify({
    current: versionName,
    currentPath: versionDir,
    previousPath: prevTarget,
    at: new Date().toISOString()
  }, null, 2));
  log(`current.json: current=${versionName}, previous=${prevTarget}`);

  // 11. 清理 workcopy（先删 .ready-for-switch，防止新 CLI 误报待切换状态）
  log('--- 步骤11: 清理 workcopy ---');
  const readyPath = path.join(workcopyPath, '.ready-for-switch');
  try {
    fs.unlinkSync(readyPath);
    log('已删除 workcopy/.ready-for-switch');
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('.ready-for-switch 不存在，跳过');
    } else {
      logError('[警告] .ready-for-switch 删除失败！新 CLI 可能误报待切换状态，请手动删除', err);
    }
  }
  try {
    removeRecursive(workcopyPath);
    log('workcopy 已清理');
  } catch (err) {
    logError('workcopy 清理失败（残留，无 .ready-for-switch，下次迭代第一步会识别处理）', err);
  }
  removeBackupFiles(versionDir);
  log('已清理版本目录中的备份文件');

  log('=== 切换完成 ===');
  succeed({ version: versionName, versionDir, previousPath: prevTarget });
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

  // 互换 current / previous，支持再次回滚（A↔B）
  fs.writeFileSync(currentJsonPath, JSON.stringify({
    current: path.basename(target),
    currentPath: target,
    previousPath: awayPath,
    at: new Date().toISOString()
  }, null, 2));
  log(`回滚完成: current=${path.basename(target)}, previous=${awayPath}`);

  succeed({ version: path.basename(target), versionDir: target, previousPath: awayPath });
}

const entry = launchMode ? launchNewCli : (rollbackMode ? rollback : (deleteMode ? deleteVersion : main));
Promise.resolve(entry()).catch(err => {
  logError('未捕获异常', err);
  fail('未捕获异常', err.code, `switcher 内部错误: ${err.message}`, '查看 chill-guardian/switcher-debug.log 获取堆栈详情。');
});
