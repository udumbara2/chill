#!/usr/bin/env node
/**
 * release.mjs — chill-ai 唯一权威发布入口（隐士发布，四包编排版）。
 *
 * 原理：发布物只可能来自干净克隆，与开发机工作区无关——
 * 工作区里的任何杂散文件（快照/日志/本地配置）在构造上进不了包。
 *
 * 公开仓布局（四件套容器）：chill/（monorepo）+ chill-guardian/ + chill-relay/ + chill-mobile/。
 * 四个发布包与顺序（依赖拓扑）：
 *   ① @assistant-ai/native-desktop（内部依赖包，先行）
 *   ② @assistant-ai/chill-cli（轻档；prepack 内置 core 构建 + verify-native 门）
 *   ③ @assistant-ai/chill-relay（中继，独立 npm 工程）
 *   ④ @assistant-ai/chill（全档壳包；dist 依赖 ②electron bundle 与 ②cli dist 资产，故最后）
 *
 * 流程：git clone 容器仓 → 布局闸 → 源码 tag 闸 → 版本一致性闸 → 构建全链 →
 *       verify-pack 扫描闸（cli/壳包/relay）→ pnpm publish（workspace:* 由 pnpm 改写）。
 *
 * 用法：node scripts/release.mjs [--ref <分支/tag，默认 master>] [--dry-run]
 *                  [--github-only] [--otp <6位码>]
 * 前置纪律：发布前须在 GitHub（及 Gitee，除非 --github-only）打好指向发布提交的 v{version} tag——
 * /fetch-source 按 npm 版本号下载对应 tag 的源码归档，tag 缺失或错位则该版本
 * 用户开启自迭代必败，脚本在 tag 闸 fail-fast 拦截。
 * --github-only：Gitee tag 豁免（显式决策 + 醒目留痕；fetchSource 自动兜底 GitHub 源，
 * Gitee 补齐 tag 后国内用户自动恢复快速源）。默认双仓全查。
 * 禁止绕过本脚本在任何目录手动 npm publish。
 */
import { mkdtempSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = 'https://github.com/udumbara2/chill.git';
// 源码归档双仓（与 packages/cli/src/commands/fetchSource.ts 的 candidateUrls 同源同序）
const SOURCE_REPOS = [
  ['Gitee', 'https://gitee.com/assistant-ai/chill.git'],
  ['GitHub', 'https://github.com/udumbara2/chill.git'],
];
const args = process.argv.slice(2);
const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : 'master';
const dryRun = args.includes('--dry-run');
const githubOnly = args.includes('--github-only');
const otp = args.includes('--otp') ? args[args.indexOf('--otp') + 1] : null;

function run(cmd, cmdArgs, cwd, label) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`❌ ${label} 失败（退出码 ${r.status}）`);
    process.exit(1);
  }
}

/**
 * 源码 tag 闸：npm 版本 vX 的用户经 /fetch-source 下载 vX tag 的归档——
 * 各源仓必须存在指向本次发布提交（克隆 HEAD）的 vX tag，缺一/错位即拒绝发布。
 */
function verifySourceTag(version, headSha) {
  const tag = `v${version}`;
  const repos = githubOnly ? SOURCE_REPOS.filter(([, url]) => url === REPO) : SOURCE_REPOS;
  if (githubOnly) {
    console.log('⚠️  --github-only：Gitee tag 本版豁免（显式决策留痕）。fetchSource 自动兜底 GitHub 源；');
    console.log('    Gitee 补齐 tag 后国内用户自动恢复快速源——补齐后请移除该旗标恢复双仓闸。');
  }
  const problems = [];
  for (const [name, url] of repos) {
    const r = spawnSync('git', ['ls-remote', url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf-8' });
    if (r.status !== 0) {
      problems.push(`${name}：tag 查询失败（${(r.stderr || '').trim() || `退出码 ${r.status}`}）`);
      continue;
    }
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    // 附注 tag 取 ^{} 剥离行，轻量 tag 取唯一行
    const peeled = (lines.find((l) => l.endsWith('^{}')) ?? lines[0])?.split('\t')[0] ?? null;
    if (!peeled) {
      problems.push(`${name}：缺少 tag ${tag}`);
    } else if (peeled !== headSha) {
      problems.push(`${name}：tag ${tag} 指向 ${peeled.slice(0, 8)}，与本次发布提交 ${headSha.slice(0, 8)} 不一致`);
    }
  }
  if (problems.length > 0) {
    console.error(`❌ 源码 tag 闸未通过（/fetch-source 按 v${version} 下载源码归档，tag 必须先就位）：`);
    for (const p of problems) console.error(`   - ${p}`);
    console.error('   处理：在发布提交上打 tag（git tag v${version} && git push origin v${version}）后重跑本脚本。');
    process.exit(1);
  }
  console.log(`源码 tag 闸通过：v${version} 均指向 ${headSha.slice(0, 8)}（${repos.map(([n]) => n).join(' + ')}）`);
}

function publish(pkgDir, label) {
  const publishArgs = ['publish', '--access', 'public', '--no-git-checks'];
  if (dryRun) publishArgs.push('--dry-run');
  if (otp) publishArgs.push('--otp', otp);
  run('pnpm', publishArgs, pkgDir, label);
}

const work = mkdtempSync(join(tmpdir(), 'chill-release-'));
console.log(`隐士发布工作区：${work}（ref=${ref}${dryRun ? '，dry-run' : ''}${githubOnly ? '，github-only' : ''}）`);

try {
  run('git', ['clone', '--depth', '1', '--branch', ref, REPO, 'repo'], work, '1/8 干净克隆');
  const repoRoot = join(work, 'repo');
  const mono = join(repoRoot, 'chill');
  const relayDir = join(repoRoot, 'chill-relay');

  // 布局闸：四件套容器仓（guardian 是 cli 构建的输入、relay 是发布包③、mobile 是 fetch-source 自迭代对象）
  console.log('\n=== 2/8 布局闸（四件套容器仓） ===');
  for (const [piece, why] of [
    ['chill/packages/cli/package.json', 'monorepo 本体'],
    ['chill-guardian/switcher.js', 'cli 包 guardian/ 的构建来源'],
    ['chill-relay/package.json', '发布包 ③ @assistant-ai/chill-relay'],
  ]) {
    if (!existsSync(join(repoRoot, piece))) {
      console.error(`❌ 公开仓缺件：${piece}（${why}）。四件套布局就位后才能四包齐发。`);
      process.exit(1);
    }
  }
  console.log('布局闸通过：chill/ + chill-guardian/ + chill-relay/ 在位');

  // tag 闸 fail-fast：在耗时安装/构建之前拦截（克隆 HEAD 即发布提交）
  console.log('\n=== 3/8 源码 tag 闸 ===');
  const cliPkg = JSON.parse(readFileSync(join(mono, 'packages', 'cli', 'package.json'), 'utf-8'));
  const version = cliPkg.version;
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).stdout.trim();
  verifySourceTag(version, headSha);

  // 版本一致性闸：四包同版本（依赖拓扑 ①→②→④ 与 tag 归档版本必须一票对齐）
  console.log(`\n=== 4/8 版本一致性闸（期望 ${version}） ===`);
  const versionProbes = [
    ['packages/native-desktop', join(mono, 'packages', 'native-desktop', 'package.json')],
    ['packages/chill（壳包）', join(mono, 'packages', 'chill', 'package.json')],
    ['chill-relay', join(relayDir, 'package.json')],
  ];
  for (const [name, p] of versionProbes) {
    const v = JSON.parse(readFileSync(p, 'utf-8')).version;
    if (v !== version) {
      console.error(`❌ 版本不一致：${name}=${v}，cli=${version}。四包必须同版发布。`);
      process.exit(1);
    }
  }
  console.log('版本一致：native-desktop / chill-cli / chill-relay / chill 均 ' + version);

  // 本地版本管理产物不得随源码分发（.gitignore 已列，须上游解除追踪；内容含迭代元数据，属无扫描通道）
  if (existsSync(join(mono, '.version.json'))) {
    console.error('❌ 仓库仍追踪 .version.json（本地版本管理产物，已在 .gitignore 中但从未解除追踪）。');
    console.error('   处理：git rm --cached .version.json && git commit && push 后重跑本脚本。');
    process.exit(1);
  }
  // .self.md 必须保持追踪：fetch-source 的自锚定识别（isChillProjectRoot）依赖它存在于源码树

  run('pnpm', ['install', '--frozen-lockfile'], mono, '5/8 安装依赖（monorepo）');
  run('npm', ['install', '--no-audit', '--no-fund'], relayDir, '5/8 安装依赖（chill-relay）');

  // 构建全链：root build（native→core→web→渲染器→electron）→ cli（含 core 构建）→ 壳包装配
  run('pnpm', ['run', 'build'], mono, '6/8 构建（monorepo root：native/core/web/渲染器/electron）');
  run('pnpm', ['run', 'build'], join(mono, 'packages', 'cli'), '6/8 构建（chill-cli dist）');
  run('pnpm', ['run', 'build'], join(mono, 'packages', 'chill'), '6/8 构建（全档壳包 dist 装配）');
  run('npm', ['run', 'build'], relayDir, '6/8 构建（chill-relay dist）');

  // 本机绊线注入：denylist.local.json 不入仓库（含真实秘密模式），发布机上有则拷入克隆，
  // 使 verify-pack 在干净克隆里也按全量绊线扫描（拷贝只存在于临时目录，永不发布）。
  const cliDir = join(mono, 'packages', 'cli');
  const localDenySrc = fileURLToPath(new URL('./denylist.local.json', import.meta.url));
  if (existsSync(localDenySrc)) {
    copyFileSync(localDenySrc, join(cliDir, 'scripts', 'denylist.local.json'));
    console.log('已注入本机绊线 denylist.local.json → 克隆');
  } else {
    console.log('⚠️ 本机无 denylist.local.json——verify-pack 将仅按结构模式扫描（IP/域名/令牌类绊线缺席）');
  }
  run('node', ['scripts/verify-pack.mjs', '.'], cliDir, '7/8 泄露扫描闸（chill-cli）');
  run('node', ['scripts/verify-pack.mjs', join(mono, 'packages', 'chill')], cliDir, '7/8 泄露扫描闸（壳包）');
  run('node', ['scripts/verify-pack.mjs', relayDir], cliDir, '7/8 泄露扫描闸（chill-relay）');

  // 发布（依赖拓扑序；prepack 各自把门：cli=verify-native --require dist，shell=装配断言）
  publish(join(mono, 'packages', 'native-desktop'), `8/8 发布 ① @assistant-ai/native-desktop@${version}`);
  publish(cliDir, `8/8 发布 ② @assistant-ai/chill-cli@${version}`);
  publish(relayDir, `8/8 发布 ③ @assistant-ai/chill-relay@${version}`);
  publish(join(mono, 'packages', 'chill'), `8/8 发布 ④ @assistant-ai/chill@${version}`);

  console.log('\n✅ 隐士发布完成（四包齐发）');
} finally {
  rmSync(work, { recursive: true, force: true });
}
