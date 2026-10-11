#!/usr/bin/env node
/**
 * mobile-push.js — 手机端远程推送执行器：截图/APK 经中继静态通道发布，回传可点链接
 *
 * 用法:
 *   node mobile-push.js shot <png路径>              # 截图上传 → 打印 URL（48h 过期）
 *   node mobile-push.js apk <chill-mobile路径>      # 校验已固化 → assembleRelease → 上传 app-<快照id>.apk → 打印 URL
 *                                                   #      → 上传 apk/feed-<deskPub指纹>.json 版本清单（手机自动更新发现）
 *   node mobile-push.js apk <路径> --notes "说明"   # 清单带更新说明（默认不带——隐私纪律：goal 文本属敏感面）
 *
 * 配置 ~/.chill/mobile-push.json（Tier1/Tier0 纪律：不进任何 git）:
 *   { "relayBase": "https://<中继地址>:8443", "bearer": "<PUBLISH_TOKEN>", "caPath": "<ca.crt 路径>",
 *     "deskPub": "<本机设备公钥 base64url（chill 内 /pair deskpub 导出一次性配入）>" }
 *
 * 设计（见 weRealize/手机端远程推送实施规划.md v2 + 手机端自动更新发现-实施规划.md）:
 *   - 推送必先固化：apk 命令先调 mobile-freeze.js --status，有未固化残留一律拒绝（铁律的机械执行）
 *   - 交付物 = assembleRelease（嵌 JS 免 Metro；debug 变体不嵌 JS，不可作远程交付物）
 *   - 中文路径纪律：AGP/NDK 对非 ASCII 项目路径有已知缺陷——构建自动经 subst 盘符绕行
 *   - TLS：中继为私有 CA，https.request 显式带 ca（不走 fetch——undici 不接受请求级 ca）
 *   - 原子指针（更新发现）：先传 APK 后传清单——清单永不指向缺失文件；清单 PUT 失败 = 整次推送失败
 *   - feed 派生（与手机侧 src/updater/feed.ts 黄金向量对齐）：base64url 解码 32 字节原始公钥
 *     → sha256 → 小写 hex → 前 24 位；manifest 带 deskPubFp 供手机运行时自证
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const cmd = args[0]
const target = args[1]
/** --notes "..."（可选；仅 apk 清单消费） */
const notesArg = (() => {
  const i = args.indexOf('--notes')
  return i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1].slice(0, 200) : undefined
})()

function fail(msg) { console.error(`✗ ${msg}`); process.exit(1) }

if (cmd !== 'shot' && cmd !== 'apk') {
  console.error('用法: node mobile-push.js shot <png路径> | apk <chill-mobile路径> [--notes "说明"]')
  process.exit(1)
}
if (!target) fail(`缺少参数：${cmd === 'shot' ? 'png 路径' : 'chill-mobile 路径'}`)

// ---------- 配置 ----------
const configPath = path.join(os.homedir(), '.chill', 'mobile-push.json')
let cfg
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
} catch {
  fail(`配置缺失或不可读：${configPath}\n一次性创建（凭据不进 git）：\n  { "relayBase": "https://<中继地址>:8443", "bearer": "<PUBLISH_TOKEN>", "caPath": "<ca.crt 绝对路径>" }`)
}
if (!cfg.relayBase || !cfg.bearer) fail(`配置缺 relayBase/bearer：${configPath}`)
const relayBase = String(cfg.relayBase).replace(/\/+$/, '')
let caPem = null
if (cfg.caPath) {
  try { caPem = fs.readFileSync(cfg.caPath) } catch (e) { fail(`caPath 不可读：${cfg.caPath}（${e.message}）`) }
} else {
  fail(`配置缺 caPath（中继为私有 CA，必须显式信任）：${configPath}`)
}

// ---------- 发布 ----------
function rand6() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}
function timestamp() {
  const d = new Date(), pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** PUT /publish?name=<name>，body 为文件字节；成功返回 { url } */
function publish(name, filePath) {
  const bytes = fs.readFileSync(filePath)
  return publishBytes(name, bytes)
}

/** PUT /publish 的字节形态（清单走同一通道） */
function publishBytes(name, bytes) {
  const u = new URL(relayBase)
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `/publish?name=${encodeURIComponent(name)}`,
        method: 'PUT',
        ca: caPem,
        headers: {
          authorization: `Bearer ${cfg.bearer}`,
          'content-type': 'application/octet-stream',
          'content-length': bytes.length,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode === 201) {
            try { resolve({ ok: true, url: JSON.parse(body).url }) } catch { resolve({ ok: false, status: res.statusCode, body }) }
          } else {
            resolve({ ok: false, status: res.statusCode, body })
          }
        })
      },
    )
    req.on('error', (e) => resolve({ ok: false, error: e.message }))
    req.end(bytes)
  })
}

// ---------- 更新发现：feed 派生 + 清单（与手机侧 src/updater/feed.ts 黄金向量对齐，deskPubFp 运行时自证兜底） ----------
function feedInfo(deskPub) {
  const fp = crypto.createHash('sha256').update(Buffer.from(deskPub, 'base64url')).digest('hex').slice(0, 24)
  return { fp, name: `apk/feed-${fp}.json` }
}

// ---------- 发布流程 ----------
async function main() {
if (cmd === 'shot') {
  if (!fs.existsSync(target)) fail(`文件不存在：${target}`)
  const name = `shots/${timestamp()}-${rand6()}.png`
  const r = await publish(name, target)
  if (!r.ok) fail(`上传失败：${r.error || `${r.status} ${r.body}`}`)
  const url = `${relayBase}${r.url}`
  console.log(url)
  process.exit(0)
}

// ---------- apk ----------
const mobilePath = path.resolve(target)
const pkgPath = path.join(mobilePath, 'package.json')
if (!fs.existsSync(pkgPath) || !fs.existsSync(path.join(mobilePath, 'App.tsx'))) {
  fail(`目标不像 chill-mobile（缺 package.json 或 App.tsx）: ${mobilePath}`)
}
// 更新发现前置：deskPub 必检（缺则清单无法生成——fail fast 在构建前，不浪费一次 assembleRelease）
if (!cfg.deskPub) {
  fail(`配置缺 deskPub（版本清单必需）：在 chill 交互终端运行 /pair deskpub 导出本机设备公钥，一次性配入 ${configPath} 的 "deskPub" 字段`)
}
// 官方交付物必须正式签名（2026-10-11 规划迭代 D）：debug 键密码是公开常识——公开分发的
// debug 签名 APK = 任何人可签「官方更新」覆盖所有装机（供应链洞）。缺环境变量一律拒绝。
for (const v of ['CHILL_ANDROID_KEYSTORE', 'CHILL_ANDROID_STORE_PASSWORD', 'CHILL_ANDROID_KEY_ALIAS', 'CHILL_ANDROID_KEY_PASSWORD']) {
  if (!process.env[v]) {
    fail(`官方交付物必须正式签名：缺环境变量 ${v}（keystore 栖息地 ~/.chill/keys/；新终端生效——用户级环境变量已配置的话）`)
  }
}
const parentDir = path.dirname(mobilePath)
const guardianDir = __dirname
const freezeScript = path.join(guardianDir, 'mobile-freeze.js')
if (!fs.existsSync(freezeScript)) fail(`mobile-freeze.js 不在同目录：${guardianDir}`)

// 推送必先固化（铁律）——stdio ignore：沙箱禁管道子进程（EPERM 时 status=null 被误判），只用退出码
const st = spawnSync(process.execPath, [freezeScript, '--status', mobilePath], { windowsHide: true, stdio: 'ignore' })
if (st.status !== 0) {
  console.error('推送被拒——推送必先固化（活树有未固化残留）：')
  console.error((st.stdout || '') + (st.stderr || ''))
  fail(`先固化（node mobile-freeze.js "${mobilePath}" "<目标>"）或回退到最新快照，再推送`)
}

// 快照 id（产物溯源锚点）
const pointer = JSON.parse(fs.readFileSync(path.join(parentDir, 'chill-mobile-versions', 'm-current.json'), 'utf-8'))
const snapshotId = pointer.current
if (!snapshotId || !/^[A-Za-z0-9._-]+$/.test(snapshotId)) fail(`m-current.json 的 current 非法：${JSON.stringify(pointer)}`)

// ---------- 构建场 ----------
// 非 ASCII 路径下 AGP/NDK 原生构建有硬缺陷（prefab 批处理编码 + ninja chdir + gradle 路径规范化
// 会击穿 junction/subst——实测三重死路）。出路 = 纯 ASCII 构建场：单向镜像活树 → 构建场，
// 在构建场构建（node_modules/build 缓存留在构建场不参与镜像，保留增量构建速度）。
// 铁律：构建场是纯镜像，禁止在其中改代码——一切改动回到活树。
const XD = ['node_modules', '.git', '.gradle', '.cxx', 'build', 'Pods', 'coverage', '.bundle', '.metro-health-check*']
// 注：不用 *.key/*.pem 通配——robocopy 的 * 按扩展名前缀匹配（*.key 会吞 debug.keystore、
// *.pem 会吞证书固定资源 res/raw/ca_crt.pem，2026-09-28 实测复现 mobile-freeze.js 记录过的坑）；
// 本项目真实私钥就是 ca.key/server.key（chill-relay 证书件，本就不该出现在手机树里），点名排除即可。
const XF = ['local.properties', '.env*', 'ca.key', 'server.key', '.version.json', '.watchmanconfig', '.watchman-cookie*']

function syncBuildRoot() {
  const cfgDir = cfg.buildDir || process.env.CHILL_MOBILE_ASCII || null
  if (!cfgDir && /^[\x20-\x7e]+$/.test(mobilePath)) return mobilePath // 活树本身是纯 ASCII，原地构建
  if (!cfgDir) {
    fail(`路径含非 ASCII 且未配置构建场：在 ${configPath} 加 "buildDir": "C:/dev/chill-mobile"（纯 ASCII 路径的构建副本目录）`)
  }
  if (!fs.existsSync(path.join(cfgDir, 'package.json'))) {
    fail(`构建场不像 chill-mobile（缺 package.json）：${cfgDir}`)
  }
  console.log(`ℹ 同步活树 → 构建场 ${cfgDir}（单向镜像；构建场禁改码）…`)
  const rob = spawnSync('robocopy', [mobilePath, cfgDir, '/MIR', '/XD', ...XD, '/XF', ...XF,
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, stdio: 'ignore' })
  const code = rob.status === null ? 999 : rob.status
  if (code > 7) fail(`同步构建场失败（robocopy 退出码 ${code}）`)
  return cfgDir
}

const buildRoot = syncBuildRoot()
// 构建戳（降级闸数据源）：覆盖**构建场**的 buildStamp.ts——活树占位文件零污染
const stampPath = path.join(buildRoot, 'src', 'updater', 'buildStamp.ts')
try {
  fs.writeFileSync(
    stampPath,
    `// 由 mobile-push.js 生成（快照 ${snapshotId}）——降级闸数据源；活树占位见 src/updater/buildStamp.ts\nexport const BUILD_STAMP = '${snapshotId}';\n`,
  )
  console.log(`ℹ 构建戳已写入构建场：${snapshotId}`)
} catch (e) {
  fail(`写构建戳失败：${e.message}`)
}
const androidDir = path.join(buildRoot, 'android')
if (!fs.existsSync(path.join(androidDir, 'gradlew.bat'))) fail(`缺 android/gradlew.bat：${androidDir}`)

console.log(`ℹ assembleRelease（构建产物嵌 JS，交付专用变体）… 首次构建可能数分钟`)
const gr = spawnSync('cmd', ['/c', 'gradlew.bat', 'app:assembleRelease', '--console=plain'], {
  cwd: androidDir, stdio: 'inherit', windowsHide: true,
})
if (gr.status !== 0) fail('assembleRelease 失败（构建错误，未上传任何内容）')

const apkPath = path.join(buildRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
if (!fs.existsSync(apkPath)) fail(`构建成功但找不到产物：${apkPath}`)

// ---------- 发布前 APK 扫描绊线（发布防泄露四支柱：扫描是绊线不是承重墙） ----------
// 解包后全文件扫：私钥 PEM 标记 + 本机真实凭据值（bearer/中继地址——8 字符以上才参与，
// 防短值误报）。命中即拒传。tar=Windows 自带 bsdtar，可解 zip。
function scanApk(apk) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-apkscan-'))
  try {
    const ex = spawnSync('tar', ['-xf', apk, '-C', tmp], { windowsHide: true, stdio: 'ignore' })
    if (ex.status !== 0) fail(`APK 扫描解包失败（tar 退出码 ${ex.status}）`)
    const pemRe = /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/
    const dyn = [cfg.bearer, cfg.relayBase].filter((v) => typeof v === 'string' && v.length >= 8)
    const hits = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else {
          const text = fs.readFileSync(p).toString('latin1')
          if (pemRe.test(text)) hits.push(`${path.relative(tmp, p)}: 私钥 PEM 标记`)
          for (const v of dyn) if (text.includes(Buffer.from(v, 'utf8').toString('latin1'))) hits.push(`${path.relative(tmp, p)}: 本机凭据值命中`)
        }
      }
    }
    walk(tmp)
    return hits
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
const scanHits = scanApk(apkPath)
if (scanHits.length > 0) {
  fail(`APK 扫描命中（不得上传——排查后再推）:\n  ${scanHits.join('\n  ')}`)
}
console.log('ℹ APK 扫描绊线通过（无私钥标记/本机凭据值）')

const name = `apk/app-${snapshotId}.apk`
console.log(`ℹ 上传（${(fs.statSync(apkPath).size / 1024 / 1024).toFixed(1)} MB，溯源快照 ${snapshotId}）…`)
const r = await publish(name, apkPath)
if (!r.ok) fail(`上传失败：${r.error || `${r.status} ${r.body}`}`)
const apkUrl = `${relayBase}${r.url}`
console.log(apkUrl)

// ---------- 版本清单（原子指针：APK 已就位才写清单；失败=整次推送失败） ----------
const feed = feedInfo(String(cfg.deskPub))
const apkBytes = fs.readFileSync(apkPath)
const sha256 = crypto.createHash('sha256').update(apkBytes).digest('hex')
const manifest = {
  v: 1,
  snapshot: snapshotId,
  apkUrl,
  sha256,
  size: apkBytes.length,
  builtAt: new Date().toISOString(),
  deskPubFp: feed.fp,
  ...(notesArg !== undefined ? { notes: notesArg } : {}),
}
const mr = await publishBytes(feed.name, Buffer.from(JSON.stringify(manifest), 'utf-8'))
if (!mr.ok) fail(`版本清单上传失败（feed=${feed.name}，APK 已传——清单仍指旧版，无害但本次推送判失败）：${mr.error || `${mr.status} ${mr.body}`}`)
console.log(`ℹ 版本清单已发布（手机自动更新发现的 feed）: ${relayBase}/static/${feed.name}`)
}

main().catch((e) => fail(e.message))
