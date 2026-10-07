/**
 * chill 实例注册表（多实例互攻防护的数据源）。
 *
 * 背景：AGENTS.md 用户角度明示 CLI 与 UI 可同时运行。桌面原生层的宿主保护集默认只覆盖
 * "本进程树"——没有本注册表时，A 实例的模型可以把 B 实例的窗口当普通应用注入/关闭，
 * 单不变量退化为只对单实例成立。壳层登记本实例、周期读取兄弟实例 PID 并注入原生保护集。
 *
 * 布局：~/.chill/instances/<pid>.json，内容 { pid, mode, at }。
 * 登记：启动时写；注销：进程 exit 时尽力删；读取：逐条存活验证（process.kill(pid, 0)），
 * 死件顺手清理（崩溃残留自愈）。
 * 已知边界：他进程启动时刻无低成本可靠读法，PID 复用窗口内的陈旧条目可能造成对无关窗口的
 * 过度保护（后果仅为注入被拒、模型换目标，不致伤）——接受，不引入原生读表。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR_NAME = 'instances'

function instancesDir(userDataPath: string): string {
  return join(userDataPath, DIR_NAME)
}

/** 登记本实例（返回注销函数；写盘失败静默——防护降级为单实例，不影响主流程）
 *  mode：'cli' | 'ui' | 'web'（WebUI 规划 M1.6——daemon 实例对三壳对称探活） */
export function registerInstance(userDataPath: string, mode: 'cli' | 'ui' | 'web'): () => void {
  const file = join(instancesDir(userDataPath), `${process.pid}.json`)
  try {
    mkdirSync(instancesDir(userDataPath), { recursive: true })
    writeFileSync(file, JSON.stringify({ pid: process.pid, mode, at: new Date().toISOString() }), 'utf-8')
  } catch {
    return () => { /* 未登记成功，注销空操作 */ }
  }
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      rmSync(file, { force: true })
    } catch { /* 注销失败无碍：读取侧存活验证兜底 */ }
  }
}

/**
 * 读取当前存活的兄弟实例 PID（排除调用方自身；死件顺手删除）。
 * 任何单条损坏/不可读都跳过不中断——注册表是防护增强不是关键路径。
 */
export function getLiveInstancePids(userDataPath: string): number[] {
  const dir = instancesDir(userDataPath)
  if (!existsSync(dir)) return []
  const out: number[] = []
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  for (const f of files) {
    const m = f.match(/^(\d+)\.json$/)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === process.pid) continue
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch (e) {
      // EPERM = 进程存在但权限不足（仍算存活）；ESRCH = 已死
      alive = (e as NodeJS.ErrnoException).code === 'EPERM'
    }
    if (alive) {
      out.push(pid)
    } else {
      try {
        rmSync(join(dir, f), { force: true })
      } catch { /* 清理失败下轮再来 */ }
    }
  }
  return out
}
