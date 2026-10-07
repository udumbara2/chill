/**
 * 固定团队模板服务
 *
 * 职责:从用户级(~/.chill/teams/)与项目级(.agents/teams/,向上递归)目录
 * 加载 YAML 团队定义,按"项目 > 用户"优先级合并,同名项目级覆盖用户级。
 * 非法文件不静默跳过——错误带路径与原因对外可见(getErrors)。
 * 热生效由壳层 watcher 调用 reload() 完成(core 不含 watcher,与工作流/模板系统同构)。
 */

import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import { scanAssetFiles, findProjectAssetDirs, mergeAssetLayers } from '../assets/assetDirectory'
import { parseTeamDefinition } from '../../team/teamSerializer'
import type { TeamDefinition } from '../../team/types'

export const TEAM_FILE_EXTENSION = '.yaml'
export const TEAM_PROJECT_DIR_SEGMENTS = ['.agents', 'teams']

export class TeamTemplateService {
  private fs: IFileSystemProvider
  private userDir: string
  private teams: Map<string, TeamDefinition> = new Map()
  private errors: string[] = []
  private initialized = false

  constructor(fs: IFileSystemProvider, userDir: string) {
    this.fs = fs
    this.userDir = userDir
  }

  /** 更新用户级目录(异步获取目录路径的场景,如 Electron 渲染进程) */
  setUserDir(dir: string): void {
    this.userDir = dir
  }

  async initialize(workDir?: string): Promise<void> {
    await this.reload(workDir)
    this.initialized = true
  }

  /** 全量重扫(watcher 热生效入口) */
  async reload(workDir?: string): Promise<void> {
    const errors: string[] = []

    const userResult = await scanAssetFiles(this.fs, this.userDir, TEAM_FILE_EXTENSION, '团队文件')
    errors.push(...userResult.errors)
    const userTeams = this.parseAll(userResult.files, 'user', errors)

    let projectTeams: TeamDefinition[] = []
    if (workDir) {
      const projectDirs = await findProjectAssetDirs(this.fs, workDir, TEAM_PROJECT_DIR_SEGMENTS)
      // 近者优先:远→近依次放入,近者覆盖远者
      for (const dir of [...projectDirs].reverse()) {
        const result = await scanAssetFiles(this.fs, dir, TEAM_FILE_EXTENSION, '团队文件')
        errors.push(...result.errors)
        projectTeams.push(...this.parseAll(result.files, 'project', errors))
      }
    }

    const merged = mergeAssetLayers([userTeams, projectTeams], (t) => t.name)
    this.teams = new Map(merged.map((t) => [t.name, t]))
    this.errors = errors
  }

  private parseAll(
    files: Array<{ content: string; path: string }>,
    scope: 'user' | 'project',
    errors: string[],
  ): TeamDefinition[] {
    const definitions: TeamDefinition[] = []
    for (const file of files) {
      const result = parseTeamDefinition(file.content, file.path)
      if (result.success && result.definition) {
        definitions.push({ ...result.definition, sourcePath: file.path, scope })
      } else {
        errors.push(result.error ?? `未知解析错误: ${file.path}`)
      }
    }
    return definitions
  }

  getAllTeams(): TeamDefinition[] {
    return Array.from(this.teams.values())
  }

  getTeamByName(name: string): TeamDefinition | undefined {
    return this.teams.get(name)
  }

  /** 加载/解析错误(非法文件"带原因可见") */
  getErrors(): string[] {
    return [...this.errors]
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

// ---------- 进程级单例访问器(ContextAssembler/工具执行用;壳层装配) ----------

let serviceForIndex: TeamTemplateService | undefined

export function setTeamServiceForIndex(svc: TeamTemplateService): void {
  serviceForIndex = svc
}

/** 团队索引注入与 use_team 用访问器(未装配时返回 undefined) */
export function getTeamServiceForIndex(): TeamTemplateService | undefined {
  return serviceForIndex
}
