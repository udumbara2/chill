/**
 * UI 侧命名工作流资产服务(M2)
 *
 * 渲染进程经 ElectronIPCFileSystemProvider 直接使用 core 的 WorkflowTemplateService
 * (与 agentTemplateService/templateSaver 同款通道,不新造 IPC 机制)。
 * 热生效:主进程 watch 目录 → 'workflows:changed' 事件 → 本服务防抖 reload → eventBus 广播。
 */

import {
  WorkflowTemplateService,
  WorkflowRunStore,
  definitionToCanvas,
  definitionToYaml,
  findProjectAssetDirs,
  setWorkflowRunProviders,
  isBuiltInTool,
  builtInToolExecutor,
  MCPService,
  type WorkflowDefinition,
} from '@assistant-ai/core'
import { ElectronIPCFileSystemProvider } from '../adapters/ElectronIPCFileSystemProvider'
import { eventBus } from '@assistant-ai/core'
import { getEngineWorkDir } from './chatEngine'
import { getHostAPI } from '../host/hostApi'

let service: WorkflowTemplateService | null = null
let runStore: WorkflowRunStore | null = null
let fsProvider: ElectronIPCFileSystemProvider | null = null
let userDirCache: string | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null
let initialized = false

export const WORKFLOWS_RELOADED_EVENT = 'workflows-reloaded'

/** 设置资产中心"编辑画布/新建工作流"事件:暂存指令已就位,WorkflowView 若已挂载则即时消费;
 *  未挂载时由 onMounted 消费(纯事件有时序竞争:dock 未挂载 WorkflowView 时事件无人收) */
export const OPEN_WORKFLOW_CANVAS_EVENT = 'open-workflow-canvas'

/** 待打开画布的暂存指令(设置资产中心 → WorkflowView;kind:new=空白画布/open=加载指定 YAML) */
export type StagedWorkflowCanvas = { kind: 'new' } | { kind: 'open'; sourcePath: string }
let stagedWorkflowCanvas: StagedWorkflowCanvas | null = null

export function stageWorkflowCanvas(cmd: StagedWorkflowCanvas): void {
  stagedWorkflowCanvas = cmd
}

/** 消费暂存指令(一次性;WorkflowView onMounted 与 OPEN_WORKFLOW_CANVAS_EVENT 两处消费点共用) */
export function consumeStagedWorkflowCanvas(): StagedWorkflowCanvas | null {
  const cmd = stagedWorkflowCanvas
  stagedWorkflowCanvas = null
  return cmd
}

/** 用户级工作流目录(~/.chill/workflows/;缓存) */
export async function getUserWorkflowsDir(): Promise<string> {
  if (!userDirCache) {
    // IPC 返回 { success, path } 对象；此前直接插值得到 "[object Object]/workflows"，
    // 导致用户级工作流目录扫描/保存/监听全部落空（列表恒空、run_workflow 报无可用工作流）
    const res: any = await getHostAPI().getUserDataPath()
    const base = typeof res === 'string' ? res : res?.path
    userDirCache = `${base}/workflows`
  }
  return userDirCache
}

function getService(): WorkflowTemplateService {
  if (!service) {
    fsProvider = new ElectronIPCFileSystemProvider()
    service = new WorkflowTemplateService(fsProvider, '')
  }
  return service
}

/** 全量重扫(用户级 + 项目级;项目级按当前 workDir 向上递归) */
export async function reloadWorkflows(): Promise<void> {
  const svc = getService()
  svc.setUserDir(await getUserWorkflowsDir())
  await svc.reload(getEngineWorkDir() ?? undefined)
  eventBus.emit(WORKFLOWS_RELOADED_EVENT, {})
}

/** 启动初始化 + 订阅主进程目录变更事件(幂等) */
export async function initWorkflowAssetService(): Promise<void> {
  if (initialized) return
  initialized = true
  await reloadWorkflows()
  // 运行记录存储(M6 断点续跑;目录由主进程启动时创建)
  if (!fsProvider) getService()
  // IPC 返回 { success, path } 对象；直接插值会得到 "[object Object]/workflow-runs"
  const udRes: any = await getHostAPI().getUserDataPath()
  const udBase = typeof udRes === 'string' ? udRes : udRes?.path
  runStore = new WorkflowRunStore(fsProvider!, `${udBase}/workflow-runs`)
  // run_workflow 工具(M5)提供者:服务本体 + 统一管线工具执行器(Worker 咽喉同款 __origin 注入)
  setWorkflowRunProviders({
    getService: () => getService(),
    getRunStore: () => runStore ?? undefined,
    toolRunner: async (toolName, params, meta) => {
      if (isBuiltInTool(toolName)) {
        const argsWithOrigin = {
          ...params,
          __origin: { source: 'subagent' as const, subagentType: 'workflow', taskId: meta.runId },
        }
        const result = await builtInToolExecutor.executeAsync(toolName, JSON.stringify(argsWithOrigin), meta.runId)
        return { success: result.success, data: result.data, error: result.error }
      }
      // MCP 工具:经 MCP 服务直调(与 Worker 网关 mcp 分支同通道);
      // executeToolCall 带 success 字段——失败如实上抛(此前恒 success:true 吞错)
      const result = await new MCPService().executeToolCall({ function: { name: toolName, arguments: params } }, [])
      if ((result as any)?.success === false) {
        return { success: false, error: (result as any).content ?? `MCP 工具 "${toolName}" 调用失败` }
      }
      return { success: true, data: result }
    },
  })
  // 目录变更 → 防抖 500ms → 重扫(参照模板热重载范式)
  getHostAPI().onWorkflowsChanged?.(() => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadWorkflows().catch((err) => console.warn('【工作流】热重载失败:', err))
    }, 500)
  })
  // 项目级目录监听(当前 workDir 向上各级 .agents/workflows/)
  await syncProjectWorkflowWatchers()
}

/** 让主进程监听当前项目各级 .agents/workflows/ 目录(workDir 变更时重调) */
export async function syncProjectWorkflowWatchers(): Promise<void> {
  const workDir = getEngineWorkDir()
  const host = getHostAPI()
  if (!host.watchWorkflowDirs) return
  if (!fsProvider) getService()
  const dirs = workDir
    ? await findProjectAssetDirs(fsProvider!, workDir, ['.agents', 'workflows'])
    : []
  await host.watchWorkflowDirs([await getUserWorkflowsDir(), ...dirs])
}

export function getWorkflowAssetService(): WorkflowTemplateService {
  return getService()
}

/** 运行记录列表(M6 执行历史;run_workflow/侧栏运行同源) */
export async function listWorkflowRuns() {
  if (!runStore) return []
  return runStore.list()
}

export function listWorkflowAssets(): WorkflowDefinition[] {
  return getService().getAllWorkflows()
}

export function getWorkflowAssetErrors(): string[] {
  return getService().getErrors()
}

/** 归一化警告(如空数组按未声明处理;不阻断加载但可见) */
export function getWorkflowAssetWarnings(): string[] {
  return getService().getWarnings()
}

/** 保存 YAML 到用户级目录(项目级写回 sourcePath);name 即文件名与调用键 */
export async function saveWorkflowAsset(def: WorkflowDefinition): Promise<string> {
  const dir = def.scope === 'project' && def.sourcePath ? def.sourcePath : `${await getUserWorkflowsDir()}/${def.name}.yaml`
  const content = definitionToYaml(def)
  if (!fsProvider) getService()
  const result = await fsProvider!.writeFile(dir, content)
  if (!result.success) throw new Error(result.error ?? '工作流保存失败')
  await reloadWorkflows()
  return dir
}

/** 删除工作流文件(仅允许删自定义文件;sourcePath 驱动) */
export async function deleteWorkflowAsset(def: WorkflowDefinition): Promise<void> {
  if (!def.sourcePath) throw new Error('工作流缺少 sourcePath,无法删除')
  if (!fsProvider) getService()
  const result = await fsProvider!.deleteFile(def.sourcePath)
  if (!result.success) throw new Error(result.error ?? '工作流删除失败')
  await reloadWorkflows()
}

/**
 * 画布自动布局:position 全为 (0,0)(YAML 无坐标)时按层布局
 * BFS 分层:start 在第 0 层,每层 x 递推,层内纵向排列
 */
export function autoLayoutIfNeeded(nodes: any[], edges: any[]): void {
  const hasRealPosition = nodes.some((n) => n.position && (n.position.x !== 0 || n.position.y !== 0))
  if (hasRealPosition) return

  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    const list = incoming.get(e.target) ?? []
    list.push(e.source)
    incoming.set(e.target, list)
  }
  const depth = new Map<string, number>()
  const queue: string[] = ['start']
  depth.set('start', 0)
  while (queue.length > 0) {
    const current = queue.shift()!
    const d = depth.get(current)!
    for (const e of edges.filter((e) => e.source === current)) {
      const existing = depth.get(e.target)
      if (existing === undefined || existing < d + 1) {
        depth.set(e.target, d + 1)
        queue.push(e.target)
      }
    }
  }
  const layers = new Map<number, number>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    const index = layers.get(d) ?? 0
    layers.set(d, index + 1)
    n.position = { x: d * 280, y: index * 160 }
  }
}

/** Definition → 画布图(含自动布局) */
export function definitionToCanvasWithLayout(def: WorkflowDefinition) {
  const { nodes, edges } = definitionToCanvas(def)
  autoLayoutIfNeeded(nodes, edges)
  return { nodes, edges }
}
