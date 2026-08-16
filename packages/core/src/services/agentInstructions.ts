import * as path from 'path'
import type { IFileSystemProvider } from '../interfaces/IFileSystemProvider'
import type { IPathProvider } from '../interfaces/IPathProvider'

/**
 * AGENTS.md 用户约束常设注入（对齐 Codex 层级实践）
 *
 * 两级：全局 ~/.chill/AGENTS.md（每次启动生效）+ 当前工作目录 AGENTS.md（在该目录工作时生效）。
 * 每轮对话现读不缓存；深层（工作目录）排在全局之后（"具体覆盖一般"惯例）。
 * 常设注入：无论文件是否存在都返回文本——存在时附精简机制说明，均不存在时改为机制介绍，
 * 让模型始终知晓该机制并能主动维护。仅注入上下文，是指令而非强制。
 */

/** 单文件注入上限（字符），超出截断并标注，防上下文膨胀 */
const MAX_CHARS_PER_FILE = 4000

export interface AgentInstructionsFile {
  filePath: string
  content: string
  truncated: boolean
}

export class AgentInstructions {
  private static instance: AgentInstructions
  private fsProvider: IFileSystemProvider | null = null
  private pathProvider: IPathProvider | null = null

  private constructor() {}

  static getInstance(): AgentInstructions {
    if (!AgentInstructions.instance) AgentInstructions.instance = new AgentInstructions()
    return AgentInstructions.instance
  }

  /** 注入平台实现：CLI 注 Node provider，UI 注 Electron IPC provider */
  init(fsProvider: IFileSystemProvider, pathProvider: IPathProvider): void {
    this.fsProvider = fsProvider
    this.pathProvider = pathProvider
  }

  isReady(): boolean {
    return this.fsProvider !== null && this.pathProvider !== null
  }

  /** 全局约束文件路径（~/.chill/AGENTS.md） */
  globalFilePath(): string | null {
    if (!this.pathProvider) return null
    return path.join(this.pathProvider.getUserDataPath(), 'AGENTS.md')
  }

  /** 读取单个文件，不存在/失败返回 null */
  private async readOne(filePath: string): Promise<AgentInstructionsFile | null> {
    if (!this.fsProvider) return null
    const read = await this.fsProvider.readFile(filePath)
    if (!read.success) return null
    const raw: string = read.data?.content ?? read.data ?? ''
    const content = (typeof raw === 'string' ? raw : String(raw)).trim()
    if (!content) return null
    if (content.length > MAX_CHARS_PER_FILE) {
      return {
        filePath,
        content: content.slice(0, MAX_CHARS_PER_FILE) + `\n\n…（内容超过 ${MAX_CHARS_PER_FILE} 字符，已截断）`,
        truncated: true
      }
    }
    return { filePath, content, truncated: false }
  }

  /** 列出当前生效的约束文件路径（供启动提示；不含不存在的） */
  async listActiveFiles(workDir?: string): Promise<string[]> {
    if (!this.isReady()) return []
    const paths: string[] = []
    const globalPath = this.globalFilePath()
    if (globalPath && (await this.readOne(globalPath))) paths.push(globalPath)
    if (workDir) {
      const workPath = path.join(workDir, 'AGENTS.md')
      if (workPath !== globalPath && (await this.readOne(workPath))) paths.push(workPath)
    }
    return paths
  }

  /**
   * 构建常设注入文本，恒返回 string（未初始化时降级为空串）：
   * 任一级文件存在时，附精简机制说明 + 全局在前、工作目录在后的内容块（均带来源标注）；
   * 两级文件都不存在时，返回完整机制介绍。
   */
  async buildInjection(workDir?: string): Promise<string> {
    if (!this.isReady()) return ''
    const sections: string[] = []
    const globalPath = this.globalFilePath()
    if (globalPath) {
      const f = await this.readOne(globalPath)
      if (f) sections.push(`[全局 ${f.filePath}]\n${f.content}`)
    }
    if (workDir) {
      const workPath = path.join(workDir, 'AGENTS.md')
      if (workPath !== globalPath) {
        const f = await this.readOne(workPath)
        if (f) sections.push(`[当前工作目录 ${f.filePath}]\n${f.content}`)
      }
    }
    if (sections.length === 0) return this.buildMechanismIntro()
    return `以下约束来自 AGENTS.md 文件，请在工作中遵守（项目级优先于全局、用户当前指令优先）。\n你可用 create_file/replace_content 经用户确认后维护这些文件。\n\n${sections.join('\n\n')}`
  }

  /** 两级文件都不存在时的机制介绍：让模型知晓两级机制并能主动维护 */
  private buildMechanismIntro(): string {
    const globalPath = this.globalFilePath() ?? '~/.chill/AGENTS.md'
    return `以下介绍 AGENTS.md 长期约束机制（当前两级文件均不存在）：

AGENTS.md 是用户给你的长期约束，分两级：
- 全局：${globalPath}（对所有项目生效）
- 项目级：当前工作目录下的 AGENTS.md（在该目录工作时生效）

规则：
- 每轮对话都会现读这两个文件，改完下一轮即生效。
- 项目级与全局冲突时项目级优先；用户当前指令优先于 AGENTS.md。
- 当用户提出长期有效的规矩/约束时，你可用 create_file/replace_content 创建或编辑对应文件（经用户确认后生效）。
- 内容要具体精炼，单文件注入上限 ${MAX_CHARS_PER_FILE} 字符。`
  }
}

/**
 * /init 命令用 prompt：让模型分析当前代码库，生成工作目录 AGENTS.md 初稿；
 * 已存在时不覆盖，改为审阅并提出改进建议。
 */
export const INIT_AGENTS_MD_PROMPT = `请分析当前代码库，为当前工作目录生成 AGENTS.md 初稿（项目级长期约束，供 AI 助手在工作中遵守）。

要求：
- 若当前工作目录已存在 AGENTS.md，不要覆盖它；改为审阅该文件，按下面的标准逐条提出具体改进建议。
- 内容只写这四类：
  1. 猜不到的构建/测试/运行命令；
  2. 与语言或工具链默认不同的代码风格；
  3. 项目特有的架构决策；
  4. 常见坑与非显而易见的行为。
- 不写读代码就能知道的内容，不写放之四海皆准的泛泛实践，不编造不确定的信息。
- 每一行都要通过"删掉它会不会让助手犯错"的测试，通不过就删掉。
- 全文 200-400 词，具体精炼。

完成后用 create_file 把初稿写入当前工作目录的 AGENTS.md（会经用户确认后生效）。`

export const agentInstructions = AgentInstructions.getInstance()
