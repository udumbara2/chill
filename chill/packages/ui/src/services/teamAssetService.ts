/**
 * UI 侧团队资产服务(单点装配与访问)
 *
 * 装配:ElectronIPCFileSystemProvider + TeamTemplateService(用户级 ~/.chill/teams/,
 * 项目级经 workDir 向上递归 .agents/teams/);setTeamServiceForIndex 供
 * ContextAssembler 团队索引与 use_team 工具(渲染进程同源)。
 * 热生效:保存/删除后手动 reload + 壳层 teams watcher(onTeamsChanged)防抖重扫。
 */

import { TeamTemplateService, setTeamServiceForIndex, eventBus } from '@assistant-ai/core'
import { TeamRuntimeService, setTeamRuntimeService, startTeamWatchdog } from '@assistant-ai/core'
import { UI_EVENTS } from '../utils/toolDisplay'
import { ElectronIPCFileSystemProvider } from '../adapters/ElectronIPCFileSystemProvider'
import { getEngineWorkDir } from './chatEngine'
import { getHostAPI, tryGetHostAPI } from '../host/hostApi'

/** 打开组队编辑器事件(UI 壳内事件,仿 core EVENTS.OPEN_AGENT_EDITOR;载荷 { slug? }——带 slug 编辑该团队,否则新建。
 *  归 UI 层而非 core EVENTS:本迭代红线 core 零改动,先例 = workflowAssetService.WORKFLOWS_RELOADED_EVENT) */
export const OPEN_TEAM_EDITOR_EVENT = 'open-team-editor'
/** 团队资产重扫完成广播(设置资产中心/侧栏刷新订阅;先例 = WORKFLOWS_RELOADED_EVENT) */
export const TEAMS_RELOADED_EVENT = 'teams-reloaded'

/** 本实例主进程 PID(hostPid 注入源;渲染进程 process 是 vite polyfill 无 pid,桥不可用时退化为 undefined) */
async function getMainPid(): Promise<number | undefined> {
  try {
    const res: any = await tryGetHostAPI()?.getMainPid?.()
    return typeof res?.pid === 'number' ? res.pid : undefined
  } catch {
    return undefined
  }
}

let service: TeamTemplateService | null = null
let userDataBaseCache: string | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null

/** 用户数据根目录(`~/.chill`;缓存;IPC 返回 { success, path } 同款解包) */
async function getUserDataBase(): Promise<string> {
  if (!userDataBaseCache) {
    const res: any = await getHostAPI().getUserDataPath()
    userDataBaseCache = typeof res === 'string' ? res : (res?.path ?? '')
  }
  // 赋值后必有值（缓存命中分支同为真值）——模块级 let 类型收窄不过分支，断言收口
  return userDataBaseCache as string
}

/** 用户级团队目录(`~/.chill/teams/`) */
export async function getUserTeamsDir(): Promise<string> {
  return `${await getUserDataBase()}/teams`
}

/** 装配(幂等;main.ts 启动时调用) */
export async function initTeamAssetService(): Promise<TeamTemplateService> {
  if (service) return service
  service = new TeamTemplateService(new ElectronIPCFileSystemProvider(), await getUserTeamsDir())
  setTeamServiceForIndex(service)
  // 团队运行时(迭代 1:花名册+共享看板;进程内单例——运行时非资产,无 watcher)
  // hostPid 注入主进程 pid(渲染进程 process 是 polyfill;跨进程快照存活锚点,与 instanceRegistry 同口径)
  setTeamRuntimeService(new TeamRuntimeService(new ElectronIPCFileSystemProvider(), `${await getUserDataBase()}/team-runs`, { hostPid: await getMainPid() }))
  eventBus.emit(UI_EVENTS.TEAM_RUNTIME_READY) // 装配完成广播(runtimePillStore 绑定 onChange 的确定性时机)
  startTeamWatchdog() // 团队探测器(迭代 4:停滞/冲突/预算异常 → 解冻唤醒 lead)
  await service.initialize(getEngineWorkDir() ?? undefined)
  // 目录变更 → 防抖 500ms → 重扫(与工作流/模板热重载同范式)
  getHostAPI().onTeamsChanged?.(() => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTeamAssets().catch((err) => console.warn('【团队】热重载失败:', err))
    }, 500)
  })
  await syncTeamWatchers()
  return service
}

/** 让主进程监听用户级 + 项目级团队目录(workDir 变更时重调) */
export async function syncTeamWatchers(): Promise<void> {
  const host = getHostAPI()
  if (!host.watchTeamDirs) return
  const workDir = getEngineWorkDir()
  const dirs = [await getUserTeamsDir()]
  if (workDir) dirs.push(`${workDir}/.agents/teams`)
  await host.watchTeamDirs(dirs)
}

/** 全量重扫(保存/删除/watcher/workDir 变更入口) */
export async function reloadTeamAssets(): Promise<void> {
  if (!service) return
  await service.reload(getEngineWorkDir() ?? undefined)
  eventBus.emit(TEAMS_RELOADED_EVENT, {})
}

export function listTeamAssets() {
  return service?.getAllTeams() ?? []
}

export function getTeamAssetErrors(): string[] {
  return service?.getErrors() ?? []
}
