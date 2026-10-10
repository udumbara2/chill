#!/usr/bin/env node
/**
 * verify-pack.mjs — 发布防泄露扫描闸（隐士发布的绊线，非承重墙）。
 *
 * 对发布物全部文本内容执行 denylist 扫描，命中即非零退出（发布失败）。
 * 并断言 cli 的 files 白名单不变量（恰为 ["dist","guardian","README.md"]）。
 *
 * 用法：node scripts/verify-pack.mjs [包根目录（默认 .）]
 *
 * denylist 维护规则：每新增一个真实秘密，就把它的可识别模式加进 DENYLIST。
 * 注意：本脚本自身含有敏感模式字符串，属正常（它不入 dist）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? '.';
// files 白名单不变量（按包名注册制：各包各守各的白名单，未知包拒绝扫描）
const EXPECTED_FILES_BY_PKG = {
  '@assistant-ai/chill-cli': ['dist', 'guardian', 'README.md'],
  '@assistant-ai/chill': ['bin', 'dist', 'README.md'],
  '@assistant-ai/chill-relay': ['dist', 'README.md'],
  '@assistant-ai/native-desktop': ['index.js', 'index.d.ts', '*.node'],
  '@assistant-ai/electron-win32-x64': ['dist', 'cli.js', 'LICENSE', 'LICENSES.chromium.html', 'README.md'],
};

// 本机用户路径模式：运行时从 homedir() 派生（反斜杠与正斜杠双形态），
// 源码不硬编码用户名——仓库可公开。功能与旧硬编码形态等价并补齐正斜杠盲区。
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const home = homedir();
const homeAlt = home.includes('\\') ? home.replace(/\\/g, '/') : home.replace(/\//g, '\\');
const HOME_PATH_RE = new RegExp(esc(home) + '|' + esc(homeAlt), 'i');

// 本机专属绊线（denylist.local.json，git 永不跟踪）：个别真实秘密（服务器 IP/域名/令牌类）
// 的模式只住在本机这份文件里——仓库源码零真实秘密，哪天转公开也不带走它们。
// 开发机零操作自动加载；干净克隆（release）由 release.mjs 自动拷入；两者皆无时响亮提示。
const LOCAL_DENYLIST_PATH = fileURLToPath(new URL('./denylist.local.json', import.meta.url));
let localEntries = [];
try {
  const raw = readFileSync(LOCAL_DENYLIST_PATH, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('顶层必须是数组');
  localEntries = arr.map((e) => {
    if (!e || typeof e.name !== 'string' || typeof e.pattern !== 'string') {
      throw new Error('每条需 { "name": string, "pattern": string, "flags"?: string }');
    }
    return { name: e.name, re: new RegExp(e.pattern, e.flags ?? '') };
  });
  console.error(`[verify-pack] 已加载本机专属绊线 ${localEntries.length} 条（denylist.local.json）`);
} catch (e) {
  if (e.code === 'ENOENT') {
    console.error('[verify-pack] ⚠️ 未找到 denylist.local.json——本机专属绊线（IP/域名/令牌类）未启用，仅按结构模式扫描。');
    console.error('[verify-pack]    干净克隆环境属正常；开发机上应有此文件（格式见 denylist.local.example.json）。');
  } else {
    console.error(`[verify-pack] ❌ denylist.local.json 解析失败（fail-closed，拒绝带病扫描）: ${e.message}`);
    process.exit(1);
  }
}

/** 敏感模式清单（命中任意一条即拒绝发布）——结构模式在此，秘密模式在本机 local 文件 */
const DENYLIST = [
  // 运营者密钥赋值：排除 ${...} 模板插值（init 向导写 env 文件的合法代码形态）；真泄露必为字面量
  { name: '运营者密钥赋值', re: /OPERATOR_KEY\s*[=:]\s*(?!['"]?\$\{)\S{8}/ },
  { name: 'CA口令赋值', re: /CA_PASS\s*[=:]\s*['"]?\S{4}/ },
  { name: '私钥PEM', re: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { name: '本机用户路径', re: HOME_PATH_RE },
  // 手机号/身份证号：两侧排除字母边界（压缩产物里 hex 哈希的数字游程是高频误报源）；
  // 身份证另排除全同位（UI 全零占位串）。真泄露场景（源码/配置/中文文本）边界是引号/空白/标点，不受影响。
  { name: '手机号', re: /(?<![0-9A-Za-z])1[3-9]\d{9}(?![0-9A-Za-z])/ },
  { name: '身份证号', re: /(?<![0-9A-Za-z])(?!(\d)\1{16}[\dXx])\d{17}[\dXx](?![0-9A-Za-z])/ },
  ...localEntries,
];

const TEXT_EXT = new Set(['.js', '.cjs', '.mjs', '.json', '.md', '.txt', '.ts', '.html', '.yml', '.yaml', '']);

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (TEXT_EXT.has(extname(e)) && s.size < 8 * 1024 * 1024) yield p;
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// 1. files 白名单不变量（按包名注册制；未知包拒绝扫描）
const expectedFiles = EXPECTED_FILES_BY_PKG[pkg.name];
if (!expectedFiles) {
  console.error(`[verify-pack] ❌ 未注册的包 ${pkg.name}——先在 EXPECTED_FILES_BY_PKG 登记其 files 白名单再发布。`);
  process.exit(1);
}
const files = [...(pkg.files ?? [])].sort();
const expected = [...expectedFiles].sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error(`[verify-pack] ❌ files 白名单漂移：实际 ${JSON.stringify(files)}，应为 ${JSON.stringify(expected)}`);
  console.error('[verify-pack] 若确需调整白名单，请同步修改本脚本的 EXPECTED_FILES_BY_PKG 并说明理由。');
  process.exit(1);
}

// 2. 收集发布物（优先 npm pack 实际清单，退化为 files 目录扫描）
let targets = [];
try {
  const out = execSync('npm pack --dry-run --json 2>/dev/null', { cwd: root, encoding: 'utf8' });
  const pack = JSON.parse(out);
  targets = pack[0].files.map(f => join(root, f.path));
} catch {
  for (const f of expected) {
    const p = join(root, f);
    try {
      if (statSync(p).isDirectory()) targets.push(...walk(p));
      else targets.push(p);
    } catch { /* 不存在则跳过 */ }
  }
}
targets.push(join(root, 'package.json'));

// 3. denylist 扫描
let hits = 0;
for (const file of targets) {
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }
  for (const { name, re } of DENYLIST) {
    if (re.test(content)) {
      console.error(`[verify-pack] ❌ 命中敏感信息【${name}】：${file}`);
      hits++;
    }
  }
}

if (hits > 0) {
  console.error(`[verify-pack] 共 ${hits} 处命中，发布已阻止。`);
  process.exit(1);
}
console.log(`[verify-pack] ✅ 扫描通过（${targets.length} 个文件，files 白名单不变量成立）`);
