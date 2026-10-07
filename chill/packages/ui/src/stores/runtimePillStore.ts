import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { eventBus, EVENTS, getTaskRegistry, getTeamRuntimeService, buildRuntimeProjection } from '@assistant-ai/core'
import type { RuntimeProcessTask, RuntimeProjection, RuntimeTeamSection, TeamRunState, SubagentToolCallPayload } from '@assistant-ai/core'
import { ElectronIPCFileSystemProvider } from '../adapters/ElectronIPCFileSystemProvider'
import { UI_EVENTS } from '../utils/toolDisplay'
import { tryGetHostAPI } from '../host/hostApi'

export type { RuntimeProcessTask, RuntimeProjection }

/**
 * 跨进程团队快照条目(UI 三层显示统一 · 迭代 2;来源 = 另一进程落盘的 team-runs 运行态,只读)
 */
export interface TeamRunSnapshotEntry {
  runId: string
  state: TeamRunState
  /** snapshot.json 的 mtime(= "更新于"时间戳,也是陈旧判定基准) */
  updatedAt: number
}

/** 执行过程面板时间线条目(SUBAGENT_TOOL_CALL 事件归档;running 入列,success/failed 同行回填) */
export interface ToolCallLogEntry {
  toolCallId: string
  toolName: string
  kind: string
  argsSummary: string
  status: 'running' | 'success' | 'failed'
  resultSummary?: string
  durationMs?: number
  at: number
}

/** 环形缓冲:每任务最多 50 条(防长会话内存膨胀) */
const TOOL_CALL_LOG_MAX = 50

/** 快照陈旧阈值:hostPid 存活探测是死活主判定,30 分钟是 pid 复用/文件定格的兜底;
 *  hostPid/archivedAt 两字段皆无的旧文件(向后兼容)仅按此 mtime 判定 */
const SNAPSHOT_STALE_MS = 30 * 60 * 1000

/**
 * "运行"药丸 store(UI 三层显示统一 · 迭代 1 + 迭代 2)：
 * 进程任务列表自 Home.vue 迁入(语义不变:started 仅登记"后台进行中",委派不阻塞主对话;
 * settled 回填终态与结果,取消以注册表终态为准),另订阅 TeamRuntimeService.onChange。
 * 迭代 2:订阅 team-runs:changed,读另一进程落盘的 roster/board/snapshot.json 拼成 TeamRunState
 * 同形对象(三条件过滤:无 archivedAt ∧ hostPid 存活 ∧ mtime 新鲜),快照区复用同一 buildRuntimeProjection。
 * 视图模型由 core 纯函数 buildRuntimeProjection 供给(壳零判定逻辑)。
 * store 是进程级单例(生命周期 = 渲染进程),订阅随创建建立,不随组件挂载/卸载增删。
 */
export const useRuntimePillStore = defineStore('runtimePill', () => {
  // Subagent 后台任务信息列表(支持多任务并行;语义:后台进行中 → 终态)
  const processTasks = ref<RuntimeProcessTask[]>([])

  // 活动团队运行态(TeamRuntimeService 内存真相的浅拷贝镜像;onChange 后重取触发响应式)
  const teamState = ref<TeamRunState | null>(null)

  type SubagentTaskEventPayload = {
    taskId: string
    subagentType: string
    description: string
    taskOutput?: RuntimeProcessTask['result']
  }

  const handleSubagentStarted = (p: SubagentTaskEventPayload) => {
    bindTeam() // 惰性兜底:首个任务事件时服务必然已装配(装配竞态的双保险,幂等)
    // 后台任务受理:登记为进行中即可,主对话可立刻继续
    processTasks.value.push({
      taskId: p.taskId,
      subagentType: p.subagentType,
      description: p.description,
      status: 'running',
      output: '',
    })
    // 计时基线(执行过程面板头"进行中 · Ns"徽章;RuntimeProcessTask 无开始时间字段,store 侧补记)
    taskStartedAt.value[p.taskId] = Date.now()
  }

  const handleSubagentSettled = (status: 'completed' | 'failed') => (p: SubagentTaskEventPayload) => {
    const task = processTasks.value.find((t) => t.taskId === p.taskId)
    if (!task) return
    // 取消优先:cancel_task / Ctrl+K 双击 / 取消按钮销毁环境触发的迟到 settle 也走这里——
    // 以注册表终态为准标「已取消」(区别于真失败)
    const registryStatus = getTaskRegistry().getByToolCallId(p.taskId)?.status
    task.status = registryStatus === 'cancelled' ? 'cancelled' : status
    task.output = status === 'completed'
      ? (p.taskOutput?.final_output ?? '')
      : (p.taskOutput?.error_info?.message ?? '')
    task.result = p.taskOutput
  }

  eventBus.on(EVENTS.SUBAGENT_TASK_STARTED, handleSubagentStarted)
  eventBus.on(EVENTS.SUBAGENT_TASK_COMPLETED, handleSubagentSettled('completed'))
  eventBus.on(EVENTS.SUBAGENT_TASK_FAILED, handleSubagentSettled('failed'))

  // ---------- 执行过程面板(迭代 2):工具调用日志 + 选中态 ----------
  /** 任务开始时间(面板头"进行中 · Ns"计时基线;started 事件入列时补记,清理三配套同清) */
  const taskStartedAt = ref<Record<string, number>>({})
  /** 工具调用日志:taskId → 时间线条目(running 入列/success·failed 同行回填;环形 50 条/任务;settle 后保留供回看) */
  const toolCallLog = ref<Record<string, ToolCallLogEntry[]>>({})
  /** 面板选中的任务(点行选中,再点/关闭置 null) */
  const selectedTaskId = ref<string | null>(null)

  /** 共享分钟级 tick(成员行"认领 N 分钟"与看板气泡条目时长同一计时源,防两处计时器各自漂移;
   *  过程面板"进行中 · Ns"的 1s tick 同族先例,此处放宽到 1 分钟;store 进程级单例,定时器随创建建立) */
  const minuteTick = ref(Date.now())
  setInterval(() => {
    minuteTick.value = Date.now()
  }, 60_000)

  const handleSubagentToolCall = (p: SubagentToolCallPayload) => {
    // 无 taskId 归属的事件直接忽略(resolveOrigin 查不到绑定的罕见路径,无归属不显示)
    if (!p.taskId) return
    const list = toolCallLog.value[p.taskId] ?? (toolCallLog.value[p.taskId] = [])
    if (p.status === 'running') {
      // 去重:桥(主进程转发)与本地 eventBus 双源并发时同一次调用只入列一次
      if (list.some((e) => e.toolCallId === p.toolCallId && e.status === 'running')) return
      list.push({
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        kind: p.kind,
        argsSummary: p.argsSummary,
        status: 'running',
        at: p.at,
      })
      if (list.length > TOOL_CALL_LOG_MAX) list.splice(0, list.length - TOOL_CALL_LOG_MAX) // 环形缓冲
      return
    }
    // success/failed:同行回填(倒序找最近一条 running;找不到=环形挤出/迟到事件,不入列防无头尾行)
    const entry = [...list].reverse().find((e) => e.toolCallId === p.toolCallId && e.status === 'running')
    if (!entry) return
    entry.status = p.status
    entry.resultSummary = p.resultSummary
    entry.durationMs = p.durationMs
  }
  eventBus.on(EVENTS.SUBAGENT_TOOL_CALL, handleSubagentToolCall)
  // 主源:委派执行/网关在 electron 主进程,事件经 preload 桥推送到达(渲染进程本地 eventBus 永不会发——
  // electron 下网关不在本进程);eventBus 订阅保留为浏览器开发态/未来本地发射的兜底,去重见上
  tryGetHostAPI()?.onSubagentToolCall?.((p: unknown) => handleSubagentToolCall(p as SubagentToolCallPayload))

  /** 选中/再点关闭(执行过程面板唯一选中入口) */
  const toggleSelectTask = (taskId: string): void => {
    selectedTaskId.value = selectedTaskId.value === taskId ? null : taskId
  }
  const closeProcessPanel = (): void => {
    selectedTaskId.value = null
  }

  // 选中行因 clearFinished/clearAll 消失时自动置 null 关面板
  watch(processTasks, (tasks) => {
    if (selectedTaskId.value && !tasks.some((t) => t.taskId === selectedTaskId.value)) {
      selectedTaskId.value = null
    }
  })

  // 团队状态镜像:浅拷贝换引用(服务原地改 roster/board,直接持有原对象不触发 computed)
  let teamBound = false
  const refreshTeam = () => {
    const t = getTeamRuntimeService()?.getActiveTeam()
    teamState.value = t ? { ...t, roster: [...t.roster], board: [...t.board] } : null
  }
  /** 绑定团队服务(幂等;服务装配晚于 store 创建时由调用方再次触发) */
  const bindTeam = () => {
    const svc = getTeamRuntimeService()
    if (!svc || teamBound) return
    teamBound = true
    svc.onChange(refreshTeam)
    refreshTeam()
  }
  bindTeam()
  // 装配晚于绑定的兜底:teamAssetService 装配完成广播时再绑一次(幂等);
  // 首个任务事件到点时服务必然已装配,再兜底一次(双保险,均幂等)
  eventBus.on(UI_EVENTS.TEAM_RUNTIME_READY, () => bindTeam())

  // ---------- 跨进程快照区(迭代 2;只读,无控制) ----------
  const snapshotTeams = ref<TeamRunSnapshotEntry[]>([])

  let snapshotFs: ElectronIPCFileSystemProvider | null = null
  let snapshotDirCache: string | null = null
  let snapshotRefreshSeq = 0 // 后发先至丢弃令牌:并发刷新只认最新一次结果

  const readSnapshotJson = async (path: string): Promise<any | null> => {
    const res = await snapshotFs!.readFile(path)
    if (!res?.success || !res?.data?.content) return null
    try {
      return JSON.parse(res.data.content)
    } catch {
      return null // 读到 atomicWrite 中间态/损坏文件:跳过,下轮 watcher 再来
    }
  }

  /** 全量重扫 team-runs 目录 → 过滤 → 重建快照列表 */
  const refreshSnapshots = async (): Promise<void> => {
    const api = tryGetHostAPI()
    if (!api?.onTeamRunsChanged || !api?.getLiveInstancePids) return // preload 未桥(浏览器开发态)时快照区不工作
    if (!snapshotFs) snapshotFs = new ElectronIPCFileSystemProvider()
    const seq = ++snapshotRefreshSeq
    try {
      if (!snapshotDirCache) {
        const res: any = await api.getUserDataPath()
        snapshotDirCache = `${typeof res === 'string' ? res : res?.path}/team-runs`
      }
      const listRes = await snapshotFs.listDirectory(snapshotDirCache)
      const dirs = ((listRes?.success ? listRes.data?.files : null) ?? []).filter(
        (f: { type: string }) => f.type === 'directory',
      ) as Array<{ name: string; path: string }>
      // 本进程活动团队走实时区,不进快照区(getLiveInstancePids 排除本进程 pid,须先排除自 runId)
      const selfRunId = getTeamRuntimeService()?.getActiveTeam()?.runId
      const pidsRes: any = await api.getLiveInstancePids()
      const livePids = new Set<number>(pidsRes?.success ? (pidsRes.pids ?? []) : [])
      const now = Date.now()
      const entries: TeamRunSnapshotEntry[] = []
      for (const d of dirs) {
        if (d.name === selfRunId) continue
        const [roster, board, snap, stat] = await Promise.all([
          readSnapshotJson(`${d.path}/roster.json`),
          readSnapshotJson(`${d.path}/board.json`),
          readSnapshotJson(`${d.path}/snapshot.json`),
          snapshotFs!.statFile(`${d.path}/snapshot.json`),
        ])
        if (!roster?.runId || !Array.isArray(roster.roster)) continue
        const mtimeMs = stat?.success ? (stat.data?.mtimeMs ?? 0) : 0
        // 过滤(与式三条件,堵 PID 复用洞):
        // archivedAt 有 → 隐(异名换队);hostPid 有 → 需存活且 mtime 新鲜;两字段皆无的旧文件仅按 mtime 判(向后兼容)
        if (snap?.archivedAt) continue
        if (now - mtimeMs >= SNAPSHOT_STALE_MS) continue
        if (typeof snap?.hostPid === 'number' && !livePids.has(snap.hostPid)) continue
        entries.push({
          runId: roster.runId,
          updatedAt: mtimeMs,
          state: {
            runId: roster.runId,
            name: roster.name,
            createdAt: roster.createdAt,
            roster: roster.roster,
            board: Array.isArray(board?.board) ? board.board : [],
            boardRevision: board?.boardRevision ?? 0,
            snapshot: snap?.snapshot,
            ledger: snap?.ledger,
            hostPid: snap?.hostPid,
            archivedAt: snap?.archivedAt,
          },
        })
      }
      if (seq !== snapshotRefreshSeq) return
      snapshotTeams.value = entries
    } catch {
      // 快照读取失败静默:跨进程观测是增强不是关键路径,下轮 watcher 再来
    }
  }

  tryGetHostAPI()?.onTeamRunsChanged?.(() => { void refreshSnapshots() })
  void refreshSnapshots()

  /** 快照区投影(复用同一 buildRuntimeProjection——快照区不养第二份;任务在另一进程跑,processTasks 恒空) */
  const snapshotProjections = computed<Array<{ runId: string; updatedAt: number; team: RuntimeTeamSection }>>(() =>
    snapshotTeams.value.map((s) => ({
      runId: s.runId,
      updatedAt: s.updatedAt,
      team: buildRuntimeProjection(s.state, []).team!, // state 恒非 null,team 必有
    })),
  )

  const projection = computed<RuntimeProjection>(() => buildRuntimeProjection(teamState.value, processTasks.value))
  const hasRuntime = computed(() => projection.value.hasRuntime || snapshotTeams.value.length > 0)

  /** 清空全部(新建会话同点调用:清空语义自 Home.vue 原样迁移;日志与计时基线同清) */
  const clearAll = () => {
    processTasks.value = []
    toolCallLog.value = {}
    taskStartedAt.value = {}
  }

  /** 清空已结束(药丸头部按钮;进行中保留;已完成任务的日志同清,防长会话膨胀) */
  const clearFinished = () => {
    const runningIds = new Set(processTasks.value.filter((t) => t.status === 'running').map((t) => t.taskId))
    processTasks.value = processTasks.value.filter((t) => t.status === 'running')
    for (const id of Object.keys(toolCallLog.value)) {
      if (!runningIds.has(id)) delete toolCallLog.value[id]
    }
    for (const id of Object.keys(taskStartedAt.value)) {
      if (!runningIds.has(id)) delete taskStartedAt.value[id]
    }
  }

  return {
    processTasks, teamState, snapshotTeams, snapshotProjections, projection, hasRuntime,
    toolCallLog, taskStartedAt, selectedTaskId, toggleSelectTask, closeProcessPanel, minuteTick,
    bindTeam, clearAll, clearFinished, refreshSnapshots,
  }
})
