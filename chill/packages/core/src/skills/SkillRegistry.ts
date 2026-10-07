/**
 * Skill注册中心
 * 全局单例，存储已加载的skill列表
 */

import type { SkillMeta } from '../types/skill'
import type { IKeyValueStore } from '../interfaces/IKeyValueStore'

/** 持久化存储key */
const DISABLED_KEY = 'skills.disabled'

export class SkillRegistry {
  private skills: SkillMeta[] = []
  private disabledSkills: Set<string> = new Set()
  private store?: IKeyValueStore

  /** 批量设置skill列表（保留已有的disabled状态，清理不存在的条目） */
  setSkills(skills: SkillMeta[]): void {
    this.skills = [...skills]
    // 清理已被删除的skill的禁用记录
    const currentNames = new Set(skills.map(s => s.name))
    for (const name of this.disabledSkills) {
      if (!currentNames.has(name)) {
        this.disabledSkills.delete(name)
      }
    }
    this.persist()
  }

  /** 获取所有skill */
  getAll(): SkillMeta[] {
    return [...this.skills]
  }

  /** 获取未被禁用的skill列表 */
  getEnabled(): SkillMeta[] {
    return this.skills.filter(s => !this.disabledSkills.has(s.name))
  }

  /** 按名称获取skill */
  getByName(name: string): SkillMeta | undefined {
    return this.skills.find((s) => s.name === name)
  }

  /** 禁用指定skill */
  disable(name: string): void {
    this.disabledSkills.add(name)
    this.persist()
  }

  /** 启用指定skill */
  enable(name: string): void {
    this.disabledSkills.delete(name)
    this.persist()
  }

  /** 检查skill是否处于启用状态 */
  isEnabled(name: string): boolean {
    return !this.disabledSkills.has(name)
  }

  /** 获取所有被禁用的skill名称 */
  getDisabledNames(): string[] {
    return [...this.disabledSkills]
  }

  /** 设置持久化存储，并从store加载已有禁用状态 */
  setPersistence(store: IKeyValueStore): void {
    this.store = store
    const raw = store.getItem(DISABLED_KEY)
    if (raw) {
      try {
        const names: string[] = JSON.parse(raw)
        if (Array.isArray(names)) {
          this.disabledSkills = new Set(names.filter(n => typeof n === 'string'))
        }
      } catch { /* 解析失败则忽略，保持空Set */ }
    }
  }

  /** 将当前禁用状态写入持久化存储 */
  private persist(): void {
    if (!this.store) return
    this.store.setItem(DISABLED_KEY, JSON.stringify([...this.disabledSkills]))
  }
}

let globalSkillRegistry: SkillRegistry | null = null

/** 获取全局SkillRegistry实例 */
export function getSkillRegistry(): SkillRegistry {
  if (!globalSkillRegistry) {
    globalSkillRegistry = new SkillRegistry()
  }
  return globalSkillRegistry
}

/** 重置全局SkillRegistry（用于测试/清理） */
export function resetSkillRegistry(): void {
  globalSkillRegistry = null
}
