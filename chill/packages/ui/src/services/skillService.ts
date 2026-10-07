import {
  initializeSkillRegistry,
  reloadSkillRegistry,
  type IPathProvider,
  type SkillLoader
} from '@assistant-ai/core'
import { ElectronIPCFileSystemProvider, IPCKeyValueStore } from '@assistant-ai/ui/adapters'

/**
 * UI 侧 Skill 服务（单点持有 loader 与过滤标志）。
 *
 * main.ts 启动时调 initSkills 完成注册表初始化（core 统一编排），
 * 设置页等界面组件通过 reloadSkills 重载（安装/卸载/目录变更后），
 * 避免各处重复构造 SkillLoader。
 */

let skillLoader: SkillLoader | null = null
let filterSelfIterate = false

/** 启动初始化：装载三级技能 + 接共享启用状态（state.json）；返回装载告警 */
export async function initSkills(
  pathProvider: IPathProvider,
  builtinSkillsDir: string | undefined,
  filter: boolean
): Promise<string[]> {
  filterSelfIterate = filter
  const { skillLoader: loader, errors } = await initializeSkillRegistry({
    fsProvider: new ElectronIPCFileSystemProvider(),
    pathProvider,
    workDir: '',
    builtinSkillsDir,
    persistence: new IPCKeyValueStore(),
    filterSelfIterate,
  })
  skillLoader = loader
  return errors
}

/** 重载注册表（过滤规则与初始化同源）；未初始化时静默跳过 */
export async function reloadSkills(): Promise<void> {
  if (!skillLoader) return
  await reloadSkillRegistry(skillLoader, { filterSelfIterate })
}

/** 是否已完成初始化（设置页据此决定是否可用重载） */
export function isSkillsInitialized(): boolean {
  return skillLoader !== null
}
