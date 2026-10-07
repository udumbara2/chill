/**
 * Skill加载器
 * 扫描内置级、个人级和项目级目录，加载所有SKILL.md文件
 * 优先级：内置 < 个人 < 项目（后者覆盖前者）
 */

import { join, dirname, resolve as resolvePath } from 'path'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../interfaces/IPathProvider'
import type { SkillMeta } from '../types/skill'
import { parseSkillMd } from './SkillParser'

/** Skill加载结果 */
export interface SkillLoadResult {
  skills: SkillMeta[]
  errors: string[]
}

/**
 * Skill加载器
 * 扫描内置级（builtinSkillsPath）、个人级（~/.chill/skills/）和项目级（从workDir向上递归的.agents/skills/）目录
 * 同名时项目级覆盖个人级，个人级覆盖内置级
 */
export class SkillLoader {
  constructor(
    private fsProvider: IFileSystemProvider,
    private pathProvider: IPathProvider,
    private workDir: string,
    private builtinSkillsPath?: string,
  ) {}

  /** 加载所有skill */
  async load(): Promise<SkillLoadResult> {
    const errors: string[] = []
    const skillMap = new Map<string, SkillMeta>()

    // 0. 扫描内置级（优先级最低，个人级和项目级可覆盖）
    if (this.builtinSkillsPath) {
      const builtinResults = await this.scanDirectory(this.builtinSkillsPath)
      errors.push(...builtinResults.errors)
      for (const skill of builtinResults.skills) {
        skillMap.set(skill.name, skill)
      }
    }

    // 1. 扫描个人级
    const personalResults = await this.scanDirectory(
      join(this.pathProvider.getUserDataPath(), 'skills'),
    )
    errors.push(...personalResults.errors)
    for (const skill of personalResults.skills) {
      skillMap.set(skill.name, skill)
    }

    // 2. 扫描项目级（从workDir向上递归）
    const projectResults = await this.scanProjectLevels()
    errors.push(...projectResults.errors)
    for (const skill of projectResults.skills) {
      // 项目级覆盖个人级
      skillMap.set(skill.name, skill)
    }

    return {
      skills: Array.from(skillMap.values()),
      errors,
    }
  }

  /** 重新加载所有skill（热重载） */
  async reload(): Promise<SkillLoadResult> {
    return this.load()
  }

  /** 扫描指定目录下的所有skill子目录 */
  private async scanDirectory(baseDir: string): Promise<SkillLoadResult> {
    const skills: SkillMeta[] = []
    const errors: string[] = []

    // 检查目录是否存在
    const dirExists = await this.fsProvider.fileExists(baseDir)
    if (!dirExists?.success || dirExists?.data !== true) {
      return { skills, errors }
    }

    // 列出子目录
    const listResult = await this.fsProvider.listDirectory(baseDir)
    if (!listResult?.success || !listResult?.data?.files) {
      return { skills, errors }
    }

    const files = listResult.data.files as Array<{ name: string; type: string }>
    const subDirs = files.filter((f) => f.type === 'directory')

    for (const dir of subDirs) {
      const skillMdPath = join(baseDir, dir.name, 'SKILL.md')

      const exists = await this.fsProvider.fileExists(skillMdPath)
      if (!exists?.success || exists?.data !== true) continue

      const readResult = await this.fsProvider.readFile(skillMdPath)
      if (!readResult?.success || !readResult?.data?.content) {
        errors.push(`无法读取 ${skillMdPath}`)
        continue
      }

      const absolutePath = resolvePath(skillMdPath)
      const parseResult = parseSkillMd(readResult.data.content, absolutePath)

      if (parseResult.success && parseResult.skill) {
        // 检测资源子目录
        const availableDirs: string[] = []
        for (const dirName of ['scripts', 'references', 'assets']) {
          const checkResult = await this.fsProvider.fileExists(join(parseResult.skill.basePath, dirName))
          if (checkResult?.success && checkResult?.data === true) {
            availableDirs.push(dirName)
          }
        }
        parseResult.skill.availableDirs = availableDirs
        skills.push(parseResult.skill)
      } else if (parseResult.error) {
        errors.push(parseResult.error)
      }
    }

    return { skills, errors }
  }

  /** 从workDir向上递归扫描项目级.agents/skills/ */
  private async scanProjectLevels(): Promise<SkillLoadResult> {
    const allSkills = new Map<string, SkillMeta>()
    const allErrors: string[] = []

    let currentDir = resolvePath(this.workDir)
    const rootPath = resolvePath('/')  // Windows上为盘符根

    while (currentDir.length >= rootPath.length) {
      const skillsDir = join(currentDir, '.agents', 'skills')
      const result = await this.scanDirectory(skillsDir)

      allErrors.push(...result.errors)
      for (const skill of result.skills) {
        if (!allSkills.has(skill.name)) {
          allSkills.set(skill.name, skill)
        }
      }

      // 到达根目录，停止
      const parent = dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }

    return { skills: Array.from(allSkills.values()), errors: allErrors }
  }
}
