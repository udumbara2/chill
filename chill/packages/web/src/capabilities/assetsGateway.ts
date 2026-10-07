/**
 * 资产与账本网关（M3.9 剩余：draft / goal / skill）
 *
 * 全部 core 现成件直调：DraftPersistence（~/.chill/draft）、goalPersistence 三函数
 * （~/.chill/goals/）、SkillLoader+SkillInstaller（技能安装/更新/卸载）。
 */
import {
  DraftPersistence,
  SkillLoader,
  SkillInstaller,
  getSkillRegistry,
  saveCurrentGoal,
  archiveCurrentGoal,
  clearCurrentGoal,
  NodeFileSystemProvider,
  type NodePathProvider,
} from '@assistant-ai/core'
export class AssetsGateway {
  private drafts: DraftPersistence
  private installer: SkillInstaller | null = null
  private pathProvider: NodePathProvider
  private userDataPath: string

  constructor(userDataPath: string, builtinSkillsDir: string | null, pathProvider: NodePathProvider) {
    this.userDataPath = userDataPath
    this.pathProvider = pathProvider
    this.drafts = new DraftPersistence(pathProvider)
    if (builtinSkillsDir) {
      const loader = new SkillLoader(new NodeFileSystemProvider(), pathProvider, '', builtinSkillsDir)
      this.installer = new SkillInstaller(new NodeFileSystemProvider(), pathProvider, loader, getSkillRegistry())
    }
  }

  // ---------- draft ----------
  saveDraft(draft: unknown): Promise<unknown> {
    return this.drafts.saveDraft(draft)
  }
  loadDraft(): Promise<unknown> {
    return this.drafts.loadDraft()
  }
  existsDraft(): Promise<unknown> {
    return this.drafts.existsDraft()
  }
  clearDraft(): Promise<unknown> {
    return this.drafts.clearDraft()
  }

  // ---------- goal（~/.chill/goals/current-goal.md） ----------
  goalSave(state: unknown): unknown {
    try {
      saveCurrentGoal(state as never)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  goalArchive(state: unknown): unknown {
    try {
      archiveCurrentGoal(state as never)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  goalClear(): unknown {
    try {
      clearCurrentGoal()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // ---------- skill ----------
  skillInstall(source: string, subPath?: string): Promise<unknown> {
    if (!this.installer) return Promise.resolve({ success: false, error: '技能安装器不可用（无内置技能目录）' })
    return this.installer.installSkill(source, subPath)
  }
  skillUninstall(name: string): Promise<unknown> {
    if (!this.installer) return Promise.resolve({ success: false, error: '技能安装器不可用' })
    return this.installer.uninstallSkill(name)
  }
  skillUpdate(name: string): Promise<unknown> {
    if (!this.installer) return Promise.resolve({ success: false, error: '技能安装器不可用' })
    return this.installer.updateSkill(name)
  }

  get dir(): string {
    return this.userDataPath
  }

  get provider(): NodePathProvider {
    return this.pathProvider
  }
}
