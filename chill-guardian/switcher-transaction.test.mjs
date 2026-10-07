#!/usr/bin/env node
/**
 * switcher-transaction.test.mjs —— 版本切换事务不变量的回归钉
 * （2026-10-05 垃圾 junction 事故根治配套；换版接续约定第 6 条的回归载体）
 *
 * 用法: node chill-guardian/switcher-transaction.test.mjs   （退出码 0=全过）
 *
 * 沙盒自隔离：复制 switcher.js 到临时目录运行（调试日志/失败文件/换版令牌全部落沙盒，
 * USERPROFILE 重定向到沙盒假 HOME——不触碰真实环境与真实事故日志证据）。
 * 覆盖：入口三查（未知旗标/坏路径/workcopy 混淆）、切换事务（junction 断言+current.json
 * 断言+previousPath 保留）、回滚事务（同款断言+A↔B 互换）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, basename } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const guardianDir = resolve(dirname(fileURLToPath(import.meta.url)))
let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✔' : '✖'} ${name}${cond ? '' : ' — ' + detail}`)
  if (!cond) failed++
}

function mkSandbox() {
  const T = mkdtempSync(join(tmpdir(), 'sw-tx-'))
  const fake = join(T, 'fakehome')
  mkdirSync(join(T, 'chill-versions', 'v1', 'packages'), { recursive: true })
  mkdirSync(fake, { recursive: true })
  writeFileSync(join(T, 'chill-versions', 'v1', 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
  mkdirSync(join(T, 'chill-workcopy', 'packages', 'cli', 'dist'), { recursive: true })
  writeFileSync(join(T, 'chill-workcopy', 'package.json'), '{"name":"sb","private":true}')
  writeFileSync(join(T, 'chill-workcopy', 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
  writeFileSync(join(T, 'chill-workcopy', 'packages', 'cli', 'dist', 'cli.js'), '// dummy gate')
  cpSync(join(guardianDir, 'switcher.js'), join(T, 'switcher.js'))
  // 初始布局：chill 是指向 v1 的 junction（switcher 同款 symlinkSync 'junction' 原语）
  symlinkSync(join(T, 'chill-versions', 'v1'), join(T, 'chill'), 'junction')
  return { T, fake }
}

function run(T, fake, args) {
  try {
    const out = execFileSync('node', [join(T, 'switcher.js'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: fake, SWITCHER_NO_LAUNCH: '1' },
      cwd: T,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

const resultJson = (out) => {
  const m = out.match(/RESULT_JSON:(\{.+\})/)
  return m ? JSON.parse(m[1]) : null
}
const junctionOf = (T) => {
  try { return realpathOf(join(T, 'chill')) } catch { return null }
}
const junctionName = (T) => {
  const j = junctionOf(T)
  return j === null ? '(junction 不可解析)' : basename(j)
}
const realpathOf = (p) => execFileSync('node', ['-e', `console.log(require('fs').realpathSync(process.argv[1]))`, p], { encoding: 'utf8' }).trim()

let sandbox
try {
  sandbox = mkSandbox()
  const { T, fake } = sandbox

  // ---- B：事故参数 --switch → 入口硬失败，布局零污染 ----
  {
    const r = run(T, fake, ['--switch'])
    const j = resultJson(r.out)
    check('B1 --switch 拒绝(UNKNOWN_FLAG)', j && j.success === false && j.errorCode === 'UNKNOWN_FLAG', JSON.stringify(j))
    check('B2 junction 仍指 v1', junctionName(T) === 'v1')
    check('B3 无新版本目录', !existsSync(join(T, 'chill-versions', 'v2')))
  }

  // ---- C：不存在的路径 → BAD_CHILL_PATH ----
  {
    const r = run(T, fake, [join(T, 'nope')])
    const j = resultJson(r.out)
    check('C1 坏路径拒绝(BAD_CHILL_PATH)', j && j.success === false && j.errorCode === 'BAD_CHILL_PATH', JSON.stringify(j))
  }

  // ---- W：workcopy 混淆形态（长得像 chill 树的错误目标）→ BAD_CHILL_PATH，workcopy 不被破坏 ----
  {
    const r = run(T, fake, [join(T, 'chill-workcopy')])
    const j = resultJson(r.out)
    check('W1 workcopy 路径拒绝(BAD_CHILL_PATH)', j && j.success === false && j.errorCode === 'BAD_CHILL_PATH', JSON.stringify(j))
    check('W2 workcopy 未被首迁移改名销毁', existsSync(join(T, 'chill-workcopy', 'package.json')))
    check('W3 junction 仍指 v1', junctionName(T) === 'v1')
  }

  // ---- A：正确切换全链路（robocopy+install+门禁+双断言）----
  let newVer = null
  {
    const r = run(T, fake, [join(T, 'chill')])
    const j = resultJson(r.out)
    check('A1 切换成功', j && j.success === true, JSON.stringify(j))
    const cur = junctionName(T)
    newVer = cur
    check('A2 junction 已切到新版本', cur.startsWith('v') && cur !== 'v1', cur)
    const c = JSON.parse(readFileSync(join(T, 'chill-versions', 'current.json'), 'utf8'))
    check('A3 current.json.current==junction', c.current === cur)
    check('A4 previousPath 完整保留(回滚链)', typeof c.previousPath === 'string' && basename(c.previousPath) === 'v1', JSON.stringify(c.previousPath))
    check('A5 workcopy 已清理', !existsSync(join(T, 'chill-workcopy')))
  }

  // ---- R：回滚事务（同款断言 + current/previous 互换）----
  {
    const r = run(T, fake, ['--rollback', join(T, 'chill')])
    const j = resultJson(r.out)
    check('R1 回滚成功', j && j.success === true, JSON.stringify(j))
    check('R2 junction 回到 v1', junctionName(T) === 'v1')
    const c = JSON.parse(readFileSync(join(T, 'chill-versions', 'current.json'), 'utf8'))
    check('R3 current=v1 且 previous=新版本(A↔B 互换)', c.current === 'v1' && c.previousPath && basename(c.previousPath) === newVer, JSON.stringify({ current: c.current, previous: c.previousPath }))
  }

  console.log(failed === 0 ? '\n== 事务回归全绿 ==' : `\n== 失败 ${failed} 项 ==`)
} finally {
  if (sandbox) { try { rmSync(sandbox.T, { recursive: true, force: true }) } catch { /* 残留容忍 */ } }
}
process.exit(failed === 0 ? 0 : 1)
