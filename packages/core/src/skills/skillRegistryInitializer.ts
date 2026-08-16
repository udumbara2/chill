/**
 * Skill 注册表初始化/重载的统一编排（CLI 与 UI 共用入口）。
 *
 * 此前装载编排分散在两处（CliContext 与 ui/main.ts）且规则漂移
 * （npm 模式过滤只有 CLI 有、reload 不过滤）。收口后：
 * 启动初始化走 initializeSkillRegistry，安装/卸载/更新/手动重载走 reloadSkillRegistry，
 * filterSelfIterate 规则单点维护。
 */

import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../interfaces/IPathProvider'
import type { IKeyValueStore } from '../interfaces/IKeyValueStore'
import { SkillLoader } from './SkillLoader'
import { getSkillRegistry } from './SkillRegistry'
import type { SkillMeta } from '../types/skill'

export interface InitializeSkillRegistryOptions {
  fsProvider: IFileSystemProvider
  pathProvider: IPathProvider
  /** 项目级技能扫描起点（.agents/skills 向上递归）；无工作目录传 '' */
  workDir: string
  /** 内置技能目录（self-iterate、skill-creator 等）；不传则不扫描内置级 */
  builtinSkillsDir?: string
  /** 启用状态持久化（CLI 用 FileKeyValueStore，UI 用 IPCKeyValueStore，同落 state.json） */
  persistence?: IKeyValueStore
  /** npm 模式/无源码环境时传 true：从注册表移除 self-iterate，防模型误执行 workcopy 流程 */
  filterSelfIterate?: boolean
}

export interface InitializedSkillRegistry {
  skillLoader: SkillLoader
  errors: string[]
}

function applyFilter(skills: SkillMeta[], filterSelfIterate?: boolean): SkillMeta[] {
  return filterSelfIterate ? skills.filter(s => s.name !== 'self-iterate') : skills
}

/** 启动初始化：接持久化 → 装载（内置/个人/项目三级）→ 按模式过滤 → 写入注册表 */
export async function initializeSkillRegistry(opts: InitializeSkillRegistryOptions): Promise<InitializedSkillRegistry> {
  if (opts.persistence) {
    getSkillRegistry().setPersistence(opts.persistence)
  }
  const skillLoader = new SkillLoader(opts.fsProvider, opts.pathProvider, opts.workDir, opts.builtinSkillsDir)
  const { skills, errors } = await skillLoader.load()
  getSkillRegistry().setSkills(applyFilter(skills, opts.filterSelfIterate))
  return { skillLoader, errors }
}

/** 重载（安装/卸载/更新/手动 reload/目录监听后）：与初始化相同的过滤规则 */
export async function reloadSkillRegistry(skillLoader: SkillLoader, opts?: { filterSelfIterate?: boolean }): Promise<{ skills: SkillMeta[]; errors: string[] }> {
  const { skills, errors } = await skillLoader.reload()
  getSkillRegistry().setSkills(applyFilter(skills, opts?.filterSelfIterate))
  return { skills, errors }
}
