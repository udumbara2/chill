/**
 * 定时任务核心调度服务
 *
 * 职责边界（本波次只做类，引擎装配接线归后续任务）：
 * - 时钟循环：每分钟对齐检查一次（全仓首个时钟设施，先例突破明示且最小化；
 *   逾期检测走动作触发：detectOverdue 由启动/会话激活时调用，不做高频轮询）
 * - 到期判定：scope 匹配当前活跃上下文（project=workDir、session=sessionId，
 *   由调用方注入 getter）；不匹配记 overdue，不触发
 * - 错过语义 collapse-to-latest：错过 N 次合并为一次触发，coalescedCount 随触发传出
 * - 双端/竞态防线：触发前 reload + lastFireAt 乐观判重（另一端刚触发过则跳过）；
 *   lastFireAt 由调用方在回合落定后经 markFired 写回（at-least-once 语义——
 *   注入即写则执行中崩溃永久丢失该轮，落定后写崩溃最多重复一次）
 * - 防失控：50 个上限、prompt ≤ 8KB、创建参数校验（cron 可解析 / at 未来时刻 /
 *   scope 归属字段齐备）；until 到期与一次性任务触发后转 done
 */

import type { CronRule } from './cronParser'
import {
  parseCron,
  nextFire,
  countOccurrences,
  recurringJitterMs,
  oneShotAdvanceMs,
  parseAt,
  MAX_COALESCE_COUNT,
} from './cronParser'
import type { TaskStore } from './TaskStore'
import type { ClaimGate } from './claimGate'
import type { FireDecision, NewTaskInput, OverdueRecord, ScheduledTask } from './types'

/** 单实例任务数量上限（对齐 Codex/Claude 的防失控配额） */
export const MAX_TASKS = 50
/** prompt 字节数上限（8KB） */
export const MAX_PROMPT_BYTES = 8 * 1024

/** 触发回调：由引擎接线注入（合成消息 → runTurn）；coalescedCount 用于信封标注 */
export type FireCallback = (task: ScheduledTask, coalescedCount: number) => void | Promise<void>

export interface SchedulerServiceDeps {
  store: TaskStore
  /** 触发回调（可选：装配期可后置经 setOnFire 注入——引擎接线路径；缺省为无操作） */
  onFire?: FireCallback
  /** 当前活跃工作目录（project scope 匹配数据源；现读 getter——会话切换后即时生效） */
  getWorkDir?: () => string | undefined
  /** 当前活跃会话 id（session scope 匹配数据源） */
  getSessionId?: () => string | undefined
  /**
   * 触发模式（M1 定向路由）：
   * - active（缺省）：活跃匹配——scope 匹配当前活跃上下文才触发，不匹配记 overdue；
   *   引擎侧 loadSession/startNewSession 的逾期补跑生效（交互 CLI 现状，逐位不变）。
   * - directed：定向——到期即触发（不做活跃匹配、不登记逾期），路由归宿主装配点的
   *   onFire（按任务归属定向解析目标会话）；引擎侧补跑整体退役（宿主 tick 已覆盖——
   *   引擎装载会话时不得把 due 任务 enqueue 到自己身上，防绕过路由器/错会话/双触发）。
   */
  fireMode?: 'active' | 'directed'
  /**
   * 跨进程触发抢占闸（M6，可选注入）：宿主装配 claimGate（需 fs 支持 createFileExclusive）
   * 后，双钟并存（serve 24/7 + 交互 CLI/UI）下同任务双跑窗口从「整轮时长」归零——
   * 触发前独占 claim、markFired 落定时释放、TTL(30min) 仅兜崩溃残留。缺省无闸：
   * 乐观判重现状（单钟场景行为逐位不变）。
   */
  claimGate?: ClaimGate
  /** 时钟源（测试注入；缺省 Date.now） */
  now?: () => number
}

export class SchedulerService {
  private store: TaskStore
  private onFire: FireCallback
  private getWorkDir?: () => string | undefined
  private getSessionId?: () => string | undefined
  private now: () => number
  private fireMode: 'active' | 'directed'
  private claimGate: ClaimGate | null

  /** cron 文本 → 解析结果的进程内缓存（每分钟 tick 复用，不重复解析） */
  private ruleCache = new Map<string, CronRule>()
  /** 逾期记录（taskId → record；scope 不匹配时登记，匹配或完结时清除） */
  private overdue = new Map<string, OverdueRecord>()

  private tickTimer: ReturnType<typeof setInterval> | null = null
  private alignTimer: ReturnType<typeof setTimeout> | null = null
  /** tick 串行化：上一趟未完不叠跑（onFire 可能慢于 1 分钟间隔） */
  private ticking = false

  constructor(deps: SchedulerServiceDeps) {
    this.store = deps.store
    this.onFire = deps.onFire ?? (() => {})
    this.getWorkDir = deps.getWorkDir
    this.getSessionId = deps.getSessionId
    this.now = deps.now ?? (() => Date.now())
    this.fireMode = deps.fireMode ?? 'active'
    this.claimGate = deps.claimGate ?? null
  }

  /** 触发回调后置注入/替换（引擎接线用：构造时只有 store 的装配路径，onFire 由 ChatEngine 接管） */
  setOnFire(cb: FireCallback): void {
    this.onFire = cb
  }

  /** 触发模式后置切换（宿主装配点接管用：serve/UI 定向路由装配；现读生效） */
  setFireMode(mode: 'active' | 'directed'): void {
    this.fireMode = mode
  }

  /** 当前触发模式（引擎侧补跑抑制的判定数据源） */
  getFireMode(): 'active' | 'directed' {
    return this.fireMode
  }

  /** 活跃上下文 getter 后置注入（引擎接线用：project/session scope 匹配的数据源，现读生效） */
  setActiveContext(getters: {
    getWorkDir?: () => string | undefined
    getSessionId?: () => string | undefined
  }): void {
    this.getWorkDir = getters.getWorkDir
    this.getSessionId = getters.getSessionId
  }

  // ---------- 生命周期 ----------

  /** 启动时钟循环：对齐到下一整分钟后每分钟检查一次（unref 不阻碍进程退出） */
  start(): void {
    if (this.tickTimer || this.alignTimer) return
    const delay = 60000 - (this.now() % 60000)
    this.alignTimer = setTimeout(() => {
      this.alignTimer = null
      void this.tick()
      this.tickTimer = setInterval(() => void this.tick(), 60000)
      this.tickTimer.unref?.()
    }, delay)
    this.alignTimer.unref?.()
  }

  stop(): void {
    if (this.alignTimer) {
      clearTimeout(this.alignTimer)
      this.alignTimer = null
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  get running(): boolean {
    return this.tickTimer !== null || this.alignTimer !== null
  }

  // ---------- 创建 / 取消 / 列表 ----------

  /**
   * 校验并创建任务（限额与参数防线全在此处；非法输入抛中文错误）。
   * cron 与 at 二选一且必须与 recurring 一致；at/until 须为未来时刻。
   */
  async validateAndCreate(input: NewTaskInput): Promise<ScheduledTask> {
    await this.validateNewTask(input)

    const hasCron = typeof input.cron === 'string' && input.cron.trim() !== ''
    const task: ScheduledTask = {
      id: generateTaskId(),
      cron: hasCron ? input.cron!.trim() : undefined,
      at: hasCron ? undefined : input.at!.trim(),
      prompt: input.prompt.trim(),
      recurring: input.recurring,
      scope: input.scope,
      workDir: input.workDir?.trim() || undefined,
      sessionId: input.sessionId?.trim() || undefined,
      until: input.until,
      createdAt: new Date(this.now()).toISOString(),
      fireCount: 0,
      status: 'active',
    }
    const tasks = await this.store.checkReload()
    const ok = await this.store.saveAll([...tasks, task])
    if (!ok) throw new Error('定时任务清单写入失败（详见 store 错误明细）')
    return task
  }

  /**
   * 仅校验不创建（schedule_task 工具的审批前校验通道：非法输入在批准前先挡掉，
   * 避免用户批准一个必然失败的任务；非法输入抛中文错误）。创建仍走 validateAndCreate（内部复校）。
   */
  async validateNewTask(input: NewTaskInput): Promise<void> {
    const tasks = await this.store.checkReload()
    const activeCount = tasks.filter((t) => t.status === 'active').length
    if (activeCount >= MAX_TASKS) {
      throw new Error(`定时任务数量已达上限 ${MAX_TASKS} 个，请先取消不再需要的任务`)
    }

    const prompt = input.prompt?.trim() ?? ''
    if (!prompt) throw new Error('定时任务缺少 prompt')
    if (new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) {
      throw new Error(`定时任务 prompt 超过 ${MAX_PROMPT_BYTES} 字节上限`)
    }

    const hasCron = typeof input.cron === 'string' && input.cron.trim() !== ''
    const hasAt = typeof input.at === 'string' && input.at.trim() !== ''
    if (hasCron === hasAt) {
      throw new Error('cron 与 at 必须二选一（cron=周期任务，at=一次性任务）')
    }
    if (hasCron && input.recurring !== true) {
      throw new Error('cron 任务的 recurring 必须为 true')
    }
    if (hasAt && input.recurring !== false) {
      throw new Error('at 一次性任务的 recurring 必须为 false')
    }

    const nowMs = this.now()
    if (hasCron) parseCron(input.cron!.trim()) // 非法即抛错
    if (hasAt) parseAt(input.at!, nowMs) // 含糊/过去即抛错

    if (input.until !== undefined) {
      if (hasAt) {
        throw new Error('一次性 at 任务无需 until（触发后即完结）')
      }
      parseAt(input.until, nowMs) // 须为未来时刻，含糊/过去即抛错
    }

    if (input.scope === 'project' && (!input.workDir || input.workDir.trim() === '')) {
      throw new Error('scope=project 的任务必须提供 workDir')
    }
    if (input.scope === 'session' && (!input.sessionId || input.sessionId.trim() === '')) {
      throw new Error('scope=session 的任务必须提供 sessionId')
    }
  }

  /** 下次应触发时刻预览（ms；非 active / 规则非法返回 null）——schedule_task 审批展示与 list 的数据源 */
  previewNextFireMs(task: ScheduledTask): number | null {
    if (task.status !== 'active') return null
    return this.scheduledNextMs(task)
  }

  /** 取消任务（整表移除；不存在返回 false） */
  async cancel(id: string): Promise<boolean> {
    const tasks = await this.store.checkReload()
    const next = tasks.filter((t) => t.id !== id)
    if (next.length === tasks.length) return false
    const ok = await this.store.saveAll(next)
    if (ok) this.overdue.delete(id)
    return ok
  }

  /** 任务列表（惰性重载后返回缓存） */
  async list(): Promise<ScheduledTask[]> {
    return this.store.checkReload()
  }

  /**
   * 转 orphaned（M2 路由 orphan 分支与 M5 会话删除清账的共用写点）：
   * 仅 active 任务可转（幂等，非 active 返回 false）；不写 lastRun（状态转换不是一次执行，
   * 审计留宿主日志）。orphaned 任务不再触发（tick 只处理 active）。
   */
  async markOrphaned(id: string): Promise<boolean> {
    const tasks = await this.store.checkReload()
    const task = tasks.find((t) => t.id === id)
    if (!task || task.status !== 'active') return false
    task.status = 'orphaned'
    const ok = await this.store.saveAll(tasks)
    if (ok) {
      this.overdue.delete(id)
      if (this.claimGate) await this.claimGate.release(id).catch(() => {})
    }
    return ok
  }

  /**
   * 会话删除清账（M5）：把绑定该会话的 active session 任务批量转 orphaned。
   * 四壳删除路径最终汇聚 SessionPersistence.delete——本方法是其唯一的任务侧清账通道
   * （经注入的清理钩子调用）。返回被清账的任务 id 列表。
   */
  async markSessionDeleted(sessionId: string): Promise<string[]> {
    const tasks = await this.store.checkReload()
    const hit: string[] = []
    for (const t of tasks) {
      if (t.status === 'active' && t.scope === 'session' && t.sessionId === sessionId) {
        t.status = 'orphaned'
        hit.push(t.id)
        this.overdue.delete(t.id)
      }
    }
    if (hit.length > 0) await this.store.saveAll(tasks)
    return hit
  }

  // ---------- 到期判定与触发 ----------

  /**
   * 一趟到期检查（时钟循环与测试直接驱动的公共入口；串行化不叠跑）。
   * 流程：reload → 逐任务判定（until 到期转 done / 未到期跳过 / scope 不匹配记 overdue）
   * → 命中者触发前再 reload 做 lastFireAt 乐观判重 → onFire。
   */
  async tick(): Promise<FireDecision[]> {
    if (this.ticking) return []
    this.ticking = true
    const fired: FireDecision[] = []
    try {
      const tasks = await this.store.checkReload()
      const nowMs = this.now()
      let dirty = false

      for (const seen of tasks) {
        if (seen.status !== 'active') continue
        const scheduledAt = this.scheduledNextMs(seen)
        if (scheduledAt === null) continue // 规则非法（解析错误已在创建时拦截；盘上手改的跳过）
        const untilMs = seen.until ? Date.parse(seen.until) : null
        if (untilMs !== null && scheduledAt > untilMs) {
          seen.status = 'done' // until 到期：已无截止前的应触发时刻
          dirty = true
          continue
        }
        if (scheduledAt > nowMs) continue // 未到期

        // M1 触发模式分治：directed=到期即触发（路由归宿主装配点 onFire，不做活跃匹配、
        // 不登记逾期——逾期等待是活跃匹配模型的语义，定向模型下任务总能触发）；
        // active（缺省）= 活跃匹配，不匹配记 overdue 等归属上下文出现
        if (this.fireMode === 'active' && !this.scopeMatches(seen)) {
          this.overdue.set(seen.id, {
            task: seen,
            missedCount: this.countMissed(seen, nowMs),
            firstMissedAt: scheduledAt,
            scopeMatches: false,
          })
          continue
        }

        // 触发前 reload + lastFireAt 乐观判重：另一端刚 markFired 过则跳过（at-least-once 的竞态压缩）
        const fresh = (await this.store.checkReload()).find((t) => t.id === seen.id)
        if (!fresh || fresh.status !== 'active' || fresh.lastFireAt !== seen.lastFireAt) continue

        // M6 跨进程触发抢占（装配 claimGate 时）：独占创建单胜者——双钟并存（serve+CLI/UI）下
        // 同任务双跑窗口从「整轮时长」归零；未获得（他进程持有未过期 / 创建失败 fail-closed）
        // 跳过本轮，等下一自然触发点。markFired 落定时释放；TTL(30min) 仅兜崩溃残留
        if (this.claimGate && !(await this.claimGate.acquire(fresh.id))) continue

        const coalescedCount = this.countMissed(fresh, nowMs)
        await this.onFire(fresh, coalescedCount)
        fired.push({ task: fresh, coalescedCount, scheduledAt })
        this.overdue.delete(fresh.id)
      }

      if (dirty) await this.store.saveAll(tasks)
    } finally {
      this.ticking = false
    }
    return fired
  }

  /**
   * 触发落定写回（调用方在回合结束后调用）：completed → lastFireAt=now、fireCount+1，
   * 一次性任务转 done，周期任务若下次应触发已越过 until 同样转 done；failed（回合失败/中断）
   * → 只写 lastRun 执行记录，不推进 lastFireAt/fireCount/状态（重试语义不变）。
   * lastRun 与 lastFireAt 同一次 saveAll 落盘——单写点，判重比对仍只看 lastFireAt，无双写竞态。
   */
  async markFired(id: string, outcome: 'completed' | 'failed' = 'completed', coalescedCount?: number): Promise<boolean> {
    const tasks = await this.store.checkReload()
    const task = tasks.find((t) => t.id === id)
    if (!task) return false
    const firedAt = new Date(this.now()).toISOString()
    task.lastRun = { firedAt, ...(coalescedCount !== undefined ? { coalescedCount } : {}), outcome }
    if (outcome === 'completed') {
      task.lastFireAt = firedAt
      task.fireCount += 1
      if (!task.recurring) {
        task.status = 'done'
      } else if (task.until) {
        const next = this.scheduledNextMs(task)
        if (next === null || next > Date.parse(task.until)) task.status = 'done'
      }
    }
    const ok = await this.store.saveAll(tasks)
    // 逾期登记只在落定时清除：failed 的任务仍到期，逾期记录留给下一趟 tick 现算
    if (ok && outcome === 'completed') this.overdue.delete(id)
    // M6：claim 释放（completed/failed 都释放——failed 的任务等下一自然触发点重试，须可重新抢占）
    if (this.claimGate) await this.claimGate.release(id).catch(() => {})
    return ok
  }

  /**
   * 逾期检测（启动 / 会话激活时调用，动作触发非轮询）：
   * 返回全部"应触发时刻已过"的活跃任务及错过次数；scopeMatches 标注当前上下文是否匹配，
   * 匹配者由调用方决定立即 collapse 补跑，不匹配者保持逾期等待归属上下文出现。
   * until 已在错过期间越过的任务直接转 done（与 tick 同口径，不补跑）。
   *
   * M1 定向模式：引擎侧补跑整体退役——返回空记录（宿主 tick 已按归属定向触发，重启后
   * 首轮 tick 对全部 due 任务 collapse 即「关了再开不丢」的兑现）；until 越期转 done 的
   * 清理职责保留（幂等，与 tick 同口径）。
   */
  async detectOverdue(): Promise<OverdueRecord[]> {
    const tasks = await this.store.checkReload()
    const nowMs = this.now()
    const records: OverdueRecord[] = []
    let dirty = false
    for (const task of tasks) {
      if (task.status !== 'active') continue
      const scheduledAt = this.scheduledNextMs(task)
      if (scheduledAt === null) continue
      const untilMs = task.until ? Date.parse(task.until) : null
      if (untilMs !== null && scheduledAt > untilMs) {
        task.status = 'done' // until 已越过：离线期间寿终的任务不补跑
        dirty = true
        continue
      }
      if (scheduledAt > nowMs) continue
      if (this.fireMode === 'directed') continue // 定向模式：不产出补跑记录、不登记逾期
      const record: OverdueRecord = {
        task,
        missedCount: this.countMissed(task, nowMs),
        firstMissedAt: scheduledAt,
        scopeMatches: this.scopeMatches(task),
      }
      records.push(record)
      this.overdue.set(task.id, record)
    }
    if (dirty) await this.store.saveAll(tasks)
    return records
  }

  /** 当前在册逾期记录（不做 IO） */
  getOverdue(): OverdueRecord[] {
    return [...this.overdue.values()]
  }

  // ---------- 内部实现 ----------

  /** 下一次应触发时刻（ms，含 jitter）；规则非法返回 null */
  private scheduledNextMs(task: ScheduledTask): number | null {
    try {
      if (task.recurring) {
        const rule = this.ruleOf(task.cron!)
        const anchor = this.anchorMs(task)
        if (anchor === null) return null
        const slot = nextFire(rule, anchor)
        // 周期 = 相邻两槽间隔（ jitter 上限的数据源）
        const periodMs = nextFire(rule, slot) - slot
        return slot + recurringJitterMs(task.id, periodMs)
      }
      const atMs = Date.parse(task.at!)
      if (Number.isNaN(atMs)) return null
      return atMs - oneShotAdvanceMs(task.id, atMs)
    } catch {
      return null
    }
  }

  /** 错过次数（collapse-to-latest 的 coalescedCount；≥1，上限 MAX_COALESCE_COUNT） */
  private countMissed(task: ScheduledTask, nowMs: number): number {
    try {
      if (!task.recurring) return 1
      const rule = this.ruleOf(task.cron!)
      const anchor = this.anchorMs(task)
      if (anchor === null) return 1
      const { count } = countOccurrences(rule, anchor, nowMs)
      return Math.max(1, Math.min(count, MAX_COALESCE_COUNT))
    } catch {
      return 1
    }
  }

  /**
   * 周期任务的判定锚点（ms，槽位严格大于此点）：
   * lastFireAt 是实际触发时刻（槽位已过，直接用）；createdAt 减 1ms——
   * 创建恰落在槽位分钟内时首个周期即可触发
   */
  private anchorMs(task: ScheduledTask): number | null {
    const parsed = Date.parse(task.lastFireAt ?? task.createdAt)
    if (Number.isNaN(parsed)) return null
    return task.lastFireAt ? parsed : parsed - 1
  }

  private ruleOf(cron: string): CronRule {
    let rule = this.ruleCache.get(cron)
    if (!rule) {
      rule = parseCron(cron)
      this.ruleCache.set(cron, rule)
    }
    return rule
  }

  /** scope 匹配：project=workDir 相同（斜杠归一、大小写不敏感——Windows 优先场景）；session=sessionId 相同 */
  private scopeMatches(task: ScheduledTask): boolean {
    if (task.scope === 'session') {
      const current = this.getSessionId?.()
      return !!task.sessionId && !!current && task.sessionId === current
    }
    const current = this.getWorkDir?.()
    return !!task.workDir && !!current && normalizeDir(task.workDir) === normalizeDir(current)
  }
}

/** 目录归一：反斜杠转正、去尾斜杠、小写（Windows 盘符大小写差异不误判）。
 *  导出供 fireRouting 复用（workDir 匹配语义单源——scopeMatches 与定向路由同款） */
export function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 任务 id：时间序 + 随机段（不引 node:crypto——core 需可被渲染进程打包） */
function generateTaskId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
