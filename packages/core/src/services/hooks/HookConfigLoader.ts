import type { IFileSystemProvider } from '../../interfaces/IFileSystemProvider'
import type { IKeyValueStore } from '../../interfaces/IKeyValueStore'
import type {
  HookEvent,
  HookHandlerConfig,
  HookMatcherGroup,
  HooksConfig,
  IFileMtimeProvider,
} from './types'
import { HOOK_EVENTS } from './types'
import { computeHandlerTrustHash, readTrustRecords, trustKeyOf, TRUSTED_KV_KEY } from './hookTrust'

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS)

const DEFAULT_TIMEOUT_SECONDS = 30

/** 项目级 hooks.json 相对于项目目录的固定位置（与 agent 模板 .agents/agents/ 同层约定） */
const PROJECT_HOOKS_FILE = '.agents/hooks.json'

/** 一个待加载的 hooks.json 来源文件 */
interface HookSourceFile {
  kind: 'user' | 'project'
  path: string
}

/** 加载器可选装配项（第 4 个构造参数；项目级加载与信任模型的接入口） */
export interface HookConfigLoaderOptions {
  /**
   * 会话工作目录：设置后从该目录向上递归发现项目级 .agents/hooks.json
   * （仿 projectTemplateDirs 的向上递归扫描，近者优先）；缺省时仅用户级单文件（阶段 1 行为）。
   * 支持 getter 形式（每次扫描现读）——UI 渲染进程的 workDir 随写作目录动态变化（阶段 3）
   */
  workDir?: string | (() => string | undefined)
  /**
   * KV 存储（信任记录 hooks.trusted 的读写，与 HookRunner 的 kv 同源注入）。
   * 缺省时项目级 handler 恒标记为"首见"且信任批准无法持久化（仅当前缓存内有效，重载后需重新批准）
   */
  kv?: IKeyValueStore
}

/**
 * hooks.json 配置加载器（仿 FileSystemTemplateLoader：IFileSystemProvider 之上，不直接碰 fs）
 *
 * 层级与合并规则（与 agent 模板"项目级 > 个人级 > 内置"的心智一致）：
 * - 来源：项目级 .agents/hooks.json（从 workDir 向上递归，近→远）+ 用户级 ~/.chill/hooks.json
 * - 优先级：项目近 > 项目远 > 用户级；同事件同 matcher（空串与省略同键）的 matcher 组
 *   被高优先级来源**整组覆盖**（不同 matcher 的组并存）；合并后组顺序 = 优先级从高到低
 *
 * mtime 惰性重载（多文件版）：每次 checkReload 重新扫描目录链（一串 fileExists），
 * 再对存在的文件逐个 stat，签名（路径+mtime 列表）不变则零读盘直接返回缓存——
 * 任一文件变化、新增/消失都会改变签名触发重载；动作触发、零轮询。
 *
 * 信任标记：reload 时按 KV 信任记录为每个项目级 handler 标记 trusted/new/changed
 * （用户级默认可信不标记）；信任批准经 markTrusted() 落盘。
 *
 * 容错原则 fail-open：JSON 损坏 / 结构非法一律视为"该文件无配置"，不阻断任何会话流程；
 * 错误明细收集在 errors 中供壳层展示（写错的配置不能无人察觉）。
 */
export class HookConfigLoader {
  private fs: IFileSystemProvider
  /** 用户级 hooks.json 路径；支持 getter（每次扫描现读——UI 渲染进程的路径经异步 IPC 后补注入，阶段 3） */
  private userConfigPath: string | (() => string)
  private mtimeProvider?: IFileMtimeProvider
  private kv?: IKeyValueStore
  /** 项目级目录链的数据源（固定值或现读 getter；扫描时求值为 workDir → 根的链，posix 风格路径） */
  private workDirSource?: string | (() => string | undefined)

  private cachedConfig: HooksConfig = {}
  private lastSignature: string | null = null
  private loaded = false
  private errors: string[] = []

  constructor(
    fs: IFileSystemProvider,
    userConfigPath: string | (() => string),
    mtimeProvider?: IFileMtimeProvider,
    options?: HookConfigLoaderOptions
  ) {
    this.fs = fs
    this.userConfigPath = userConfigPath
    this.mtimeProvider = mtimeProvider
    this.kv = options?.kv
    this.workDirSource = options?.workDir
  }

  /**
   * 事件派发前的惰性重载检查。
   * 目录链扫描 + 全部来源文件的 mtime 签名未变 → 直接返回缓存；变化或首次 → 重读重解析。
   * 未注入 mtimeProvider 时无法廉价判变，退化为每次重读（仍是动作触发，无轮询）。
   */
  async checkReload(): Promise<HooksConfig> {
    const files = await this.scanSourceFiles()
    if (!this.mtimeProvider) {
      await this.reload(files, null)
      return this.cachedConfig
    }
    const signature = await this.signatureOf(files)
    if (this.loaded && signature === this.lastSignature) {
      return this.cachedConfig
    }
    await this.reload(files, signature)
    return this.cachedConfig
  }

  /** 最近一次加载/解析收集到的错误明细（供 /hooks 等壳层展示） */
  getErrors(): string[] {
    return [...this.errors]
  }

  /** 当前缓存的配置（不做任何 IO；应经 checkReload 触发刷新后再读） */
  getConfig(): HooksConfig {
    return this.cachedConfig
  }

  /**
   * 信任批准落盘（HookRunner 经 trustApprover 获批后调用）：
   * 写入 KV 信任记录，并把当前缓存中的该 handler 标为可信（本次加载周期内不再重复询问）。
   * 无 KV 时仅内存生效（重载后回到"首见"需重新批准）。
   */
  markTrusted(handler: HookHandlerConfig): void {
    if (!handler.trustKey || !handler.trustHash) return
    handler.trust = 'trusted'
    if (!this.kv) return
    const records = readTrustRecords(this.kv)
    records[handler.trustKey] = handler.trustHash
    this.kv.setItem(TRUSTED_KV_KEY, JSON.stringify(records))
  }

  // ---------- 内部实现 ----------

  /** 扫描当前存在的全部来源文件：项目级（近→远）在前，用户级殿后（顺序即优先级从高到低） */
  private async scanSourceFiles(): Promise<HookSourceFile[]> {
    const files: HookSourceFile[] = []
    const workDir = typeof this.workDirSource === 'function' ? this.workDirSource() : this.workDirSource
    for (const dir of workDir ? projectDirChain(workDir) : []) {
      const path = `${dir}/${PROJECT_HOOKS_FILE}`
      if (await this.exists(path)) files.push({ kind: 'project', path })
    }
    const userPath = typeof this.userConfigPath === 'function' ? this.userConfigPath() : this.userConfigPath
    if (userPath && (await this.exists(userPath))) {
      files.push({ kind: 'user', path: userPath })
    }
    return files
  }

  /** 全部来源文件的 mtime 签名（文件集合变化 = 新增/消失，天然改变签名） */
  private async signatureOf(files: HookSourceFile[]): Promise<string> {
    const parts: Array<[string, number | null]> = []
    for (const f of files) {
      parts.push([f.path, await this.safeGetMtime(f.path)])
    }
    return JSON.stringify(parts)
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const result = await this.fs.fileExists(path)
      return result?.success === true && result.data === true
    } catch {
      return false
    }
  }

  private async safeGetMtime(path: string): Promise<number | null> {
    try {
      return (await this.mtimeProvider!.getMtimeMs(path)) ?? null
    } catch {
      return null
    }
  }

  private async reload(files: HookSourceFile[], signature: string | null): Promise<void> {
    this.errors = []
    const parsed: Array<{ file: HookSourceFile; config: HooksConfig }> = []
    for (const file of files) {
      parsed.push({ file, config: await this.readAndParse(file) })
    }
    this.markTrust(parsed)
    this.cachedConfig = this.merge(parsed)
    this.lastSignature = signature
    this.loaded = true
  }

  /** 读取并解析单个来源文件；任何意外异常都不允许逸出到会话主流程 */
  private async readAndParse(file: HookSourceFile): Promise<HooksConfig> {
    try {
      const readResult = await this.fs.readFile(file.path)
      if (!readResult.success || !readResult.data) {
        this.errors.push(`hooks 配置读取失败: ${file.path}${readResult.error ? `（${readResult.error}）` : ''}`)
        return {}
      }
      return this.parse(readResult.data.content, file)
    } catch (err) {
      this.errors.push(`hooks 配置加载异常: ${file.path}（${err instanceof Error ? err.message : String(err)}）`)
      return {}
    }
  }

  /** 按 KV 信任记录为项目级 handler 标记 trusted/new/changed（用户级不标记，默认可信） */
  private markTrust(parsed: Array<{ file: HookSourceFile; config: HooksConfig }>): void {
    const records = this.kv ? readTrustRecords(this.kv) : {}
    for (const { file, config } of parsed) {
      if (file.kind !== 'project') continue
      for (const groups of Object.values(config)) {
        for (const group of groups ?? []) {
          for (const handler of group.hooks) {
            if (!handler.trustKey) continue
            const trustedHash = records[handler.trustKey]
            handler.trust =
              trustedHash === undefined ? 'new' : trustedHash === handler.trustHash ? 'trusted' : 'changed'
          }
        }
      }
    }
  }

  /**
   * 合并各来源配置（parsed 顺序即优先级从高到低）：
   * 同事件同 matcher（空串与省略同键）的组，被更高优先级**来源**整组覆盖；
   * 同一来源文件内的重复 matcher 组不去重（各自独立执行，与 Claude 语义一致）；
   * 不同 matcher 的组并存；合并后组顺序 = 优先级从高到低（决策链按此顺序串行执行）。
   */
  private merge(parsed: Array<{ file: HookSourceFile; config: HooksConfig }>): HooksConfig {
    const merged: HooksConfig = {}
    const seenByEvent = new Map<HookEvent, Set<string>>()
    for (const { config } of parsed) {
      // 本来源自有的键先收集、处理完该来源再并入 seen——覆盖只发生在来源之间
      const ownByEvent = new Map<HookEvent, Set<string>>()
      for (const [eventName, groups] of Object.entries(config)) {
        const event = eventName as HookEvent
        const seen = seenByEvent.get(event)
        let own = ownByEvent.get(event)
        if (!own) {
          own = new Set()
          ownByEvent.set(event, own)
        }
        for (const group of groups ?? []) {
          const key = group.matcher ?? ''
          if (seen?.has(key)) continue
          own.add(key)
          const list = merged[event] ?? (merged[event] = [])
          list.push(group)
        }
      }
      for (const [event, keys] of ownByEvent) {
        const seen = seenByEvent.get(event)
        if (seen) {
          for (const k of keys) seen.add(k)
        } else {
          seenByEvent.set(event, keys)
        }
      }
    }
    return merged
  }

  /**
   * 解析并清洗单个来源文件的配置：未知事件 / 非法结构逐项跳过并记录错误，
   * 合法项补齐默认值（timeout=30s、failClosed=false、type 缺省 command），
   * 并为每个 handler 标注来源与（项目级）信任哈希/信任键
   */
  private parse(content: string, file: HookSourceFile): HooksConfig {
    const errors = this.errors
    let raw: unknown
    try {
      raw = JSON.parse(content)
    } catch (err) {
      errors.push(`hooks 配置 JSON 解析失败: ${file.path}（${err instanceof Error ? err.message : String(err)}）`)
      return {}
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`hooks 配置根节点必须是对象: ${file.path}`)
      return {}
    }
    const hooks = (raw as Record<string, unknown>).hooks
    if (hooks === undefined) return {}
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
      errors.push(`hooks 配置的 "hooks" 字段必须是对象: ${file.path}`)
      return {}
    }

    const config: HooksConfig = {}
    for (const [eventName, groupsValue] of Object.entries(hooks as Record<string, unknown>)) {
      if (!HOOK_EVENT_SET.has(eventName)) {
        errors.push(`未知 hook 事件 "${eventName}"，已跳过（合法事件: ${HOOK_EVENTS.join('/')}）`)
        continue
      }
      if (!Array.isArray(groupsValue)) {
        errors.push(`事件 "${eventName}" 的值必须是 matcher 组数组，已跳过`)
        continue
      }
      const groups: HookMatcherGroup[] = []
      for (let i = 0; i < groupsValue.length; i++) {
        const group = groupsValue[i]
        if (!group || typeof group !== 'object' || Array.isArray(group)) {
          errors.push(`事件 "${eventName}" 第 ${i + 1} 个 matcher 组不是对象，已跳过`)
          continue
        }
        const g = group as Record<string, unknown>
        if (g.matcher !== undefined && typeof g.matcher !== 'string') {
          errors.push(`事件 "${eventName}" 第 ${i + 1} 个 matcher 组的 matcher 必须是字符串，已跳过`)
          continue
        }
        if (!Array.isArray(g.hooks)) {
          errors.push(`事件 "${eventName}" 第 ${i + 1} 个 matcher 组缺少 hooks 数组，已跳过`)
          continue
        }
        const handlers: HookHandlerConfig[] = []
        for (let j = 0; j < g.hooks.length; j++) {
          const handler = this.normalizeHandler(g.hooks[j], eventName as HookEvent, i, j, file)
          if (handler) handlers.push(handler)
        }
        if (handlers.length > 0) {
          groups.push({ matcher: g.matcher as string | undefined, hooks: handlers })
        }
      }
      if (groups.length > 0) {
        config[eventName as HookEvent] = groups
      }
    }
    return config
  }

  private normalizeHandler(
    value: unknown,
    event: HookEvent,
    groupIndex: number,
    handlerIndex: number,
    file: HookSourceFile
  ): HookHandlerConfig | null {
    const where = `事件 "${event}" 第 ${groupIndex + 1} 组第 ${handlerIndex + 1} 个 handler`
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.errors.push(`${where} 不是对象，已跳过`)
      return null
    }
    const h = value as Record<string, unknown>
    const type = h.type === undefined ? 'command' : h.type
    if (type !== 'command' && type !== 'prompt' && type !== 'agent') {
      this.errors.push(`${where} 的 type "${String(h.type)}" 非法（command/prompt/agent），已跳过`)
      return null
    }
    if (typeof h.command !== 'string' || h.command.trim() === '') {
      this.errors.push(`${where} 缺少 command 字符串，已跳过`)
      return null
    }
    const timeout =
      typeof h.timeout === 'number' && Number.isFinite(h.timeout) && h.timeout > 0
        ? h.timeout
        : DEFAULT_TIMEOUT_SECONDS
    const handler: HookHandlerConfig = {
      name: typeof h.name === 'string' && h.name !== '' ? h.name : undefined,
      type,
      command: h.command,
      timeout,
      failClosed: h.failClosed === true,
    }
    // 运行时元数据：来源标注（/hooks list 展示与信任判定）；项目级补信任哈希与信任键
    handler.source = { kind: file.kind, path: file.path }
    if (file.kind === 'project') {
      handler.trustHash = computeHandlerTrustHash(handler)
      handler.trustKey = trustKeyOf(file.path, `${event}:${handler.name ?? handler.command}`)
      handler.trust = 'new' // 初值；markTrust 阶段按信任记录修正为 trusted/changed
    }
    return handler
  }
}

/**
 * workDir → 根的目录链（近→远，posix 风格正斜杠路径）。
 * Node fs 在 Windows 同样接受正斜杠，统一后跨平台行为确定；Windows 盘符根（'C:'）即止。
 */
function projectDirChain(workDir: string): string[] {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalized) return []
  const dirs: string[] = []
  let current = normalized
  for (;;) {
    dirs.push(current)
    const idx = current.lastIndexOf('/')
    if (idx <= 0) break // POSIX 根（'/' 上级为空）与盘符根（'C:' 无 '/'）不再向上
    current = current.slice(0, idx)
  }
  return dirs
}
