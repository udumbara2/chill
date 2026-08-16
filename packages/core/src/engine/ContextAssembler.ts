/**
 * ContextAssembler（T2：上下文组装，条件注入器框架 + 规范顺序）
 *
 * 合并 CLI CliChatService.ts:391-549 与 UI Home.vue:2086-2268 两处现状的裁定版：
 * - 公共注入器（纯逻辑，renderer 可导出）：PLAN_MODE_CONTRACT、GOAL_MODE_CONTRACT、工具目录索引、委派指南、
 *   skill 元数据、memory 索引、待确认记忆、AGENTS.md。
 * - 规范顺序：PLAN_MODE_CONTRACT 置首（"最高优先级"语义，UI 现置尾需改），
 *   其余按 CLI 现状顺序（skill → memory → pending → AGENTS.md）。
 * - 条件注入：宿主经 registerInjector 注册额外注入器（CLI 的 selfMd/status/switch/failure、
 *   UI 的写作 prompt 在 T4/T5 注册；order 取 INJECTOR_ORDER.HOST_DEFAULT 或显式指定）。
 * - 媒体处理：历史旧轮次占位符替换 + fileId→base64（engine/media.ts），provider 由宿主注入。
 *
 * 本模块无 Node 依赖，渲染进程可安全导入。
 */

import { MessageRole, type Message } from '../types/models'
import { PLAN_MODE_CONTRACT, GOAL_MODE_CONTRACT, DESKTOP_CAPABILITY_NOTICE } from '../services/builtInTools'
import { buildSkillSystemMessage } from '../skills/skillPromptBuilder'
import { buildDelegationGuide } from './delegationGuide'
import { buildCatalogIndex } from './toolDiscovery'
import { prepareHistoryForSend } from './media'
import { isLocalSubagentTemplate, wrapFrontAgentPrompt } from '../orchestrator/rolePrompt'
import { getWriteBoundary, buildWriteBoundaryPrompt } from '../services/writeBoundary'
import {
  INJECTOR_ORDER,
  type AssembleContext,
  type ContextInjector,
  type AgentInstructionsFacade,
  type AvailableModelsSource,
  type MediaProvider,
  type MemoryStoreFacade,
  type SkillRegistryFacade,
  type SubagentTemplateSource,
  type SubagentsSource,
} from './types'
import type { AvailableModel, AvailableSubagent } from '../orchestrator/types'

/** 公共注入器依赖（全部由引擎/宿主注入门面，缺省的注入器自动跳过） */
export interface CommonInjectorDeps {
  memoryStore?: MemoryStoreFacade
  agentInstructions?: AgentInstructionsFacade
  skillRegistry?: SkillRegistryFacade
  /** 可用 Subagent 数据源（委派指南②） */
  getSubagents?: SubagentsSource
  /** 可用模型数据源（委派指南③） */
  getAvailableModels?: AvailableModelsSource
  /** SubagentTemplate 解析数据源（T3 前台角色包装） */
  getSubagentTemplate?: SubagentTemplateSource
  /** 规划模式契约文本（缺省 PLAN_MODE_CONTRACT 常量） */
  planModeContract?: string
  /** 目标模式契约文本（缺省 GOAL_MODE_CONTRACT 常量） */
  goalModeContract?: string
  /** 非交互模式(chill -p)判定:为 true 时抑制交互型注入(如待确认记忆审批引导——无人可答,只会带偏任务) */
  isNonInteractive?: () => boolean
}

/** 工具目录索引注入的字符预算（超预算时 buildCatalogIndex 按类别聚合降级为「类别(+N)」形态） */
const TOOL_CATALOG_INDEX_BUDGET_CHARS = 4000

function systemMessage(content: string): Message {
  return { role: MessageRole.SYSTEM, content, timestamp: new Date() }
}

/**
 * 构建公共注入器（规范顺序见 INJECTOR_ORDER）。
 * 每个注入器内部 try/catch：单项读取失败返回 null 跳过，不影响对话（现状语义）。
 */
export function createCommonInjectors(deps: CommonInjectorDeps): ContextInjector[] {
  const injectors: ContextInjector[] = []

  // 规划模式行为契约（置首，"最高优先级"约束；仅规划模式开启时注入）
  injectors.push({
    id: 'plan-mode-contract',
    order: INJECTOR_ORDER.PLAN_MODE_CONTRACT,
    inject: (ctx) => (ctx.planMode ? systemMessage(deps.planModeContract ?? PLAN_MODE_CONTRACT) : null),
  })

  // 目标模式行为契约（紧随规划契约；仅目标模式开启时注入，目标/判据/轮次按当前状态现拼）
  injectors.push({
    id: 'goal-mode-contract',
    order: INJECTOR_ORDER.GOAL_MODE_CONTRACT,
    inject: (ctx) => {
      const goal = ctx.goalMode
      if (!goal) return null
      const dynamic =
        `\n\n【当前目标】\n目标：${goal.objective}\n完成判据：${goal.successCriteria}\n` +
        `轮次预算：已推进 ${goal.roundCount} 轮 / 上限 ${goal.maxRounds} 轮`
      return systemMessage((deps.goalModeContract ?? GOAL_MODE_CONTRACT) + dynamic)
    },
  })

  // 桌面能力常设声明（仅开关开启时注入；每轮现组，新会话/跨会话恒可见——
  // 区别于 desktopToggle 合成消息只管切换发生的那一刻）
  injectors.push({
    id: 'desktop-capability',
    order: INJECTOR_ORDER.DESKTOP_CAPABILITY,
    inject: (ctx) => (ctx.desktopEnabled ? systemMessage(DESKTOP_CAPABILITY_NOTICE) : null),
  })

  // 前台 Agent 角色包装（T3：frontAgent 已设置且模板为本地模板时注入；
  // 模板 system_prompt 只作能力描述，角色由本包装提供；每轮现解析，切换前台即生效）
  if (deps.getSubagentTemplate) {
    injectors.push({
      id: 'front-agent-role',
      order: INJECTOR_ORDER.FRONT_AGENT,
      inject: (ctx) => {
        if (!ctx.frontAgent) return null
        try {
          const template = deps.getSubagentTemplate!(ctx.frontAgent)
          // 远程模板没有本地连续对话能力，不作前台包装（候选过滤见 filterFrontAgentCandidates）
          if (!template || !isLocalSubagentTemplate(template)) return null
          // taskAvailable：前台模板 tools 白名单可能滤掉 task，工作方式段按可用性条件化
          return systemMessage(wrapFrontAgentPrompt(template, ctx.taskToolAvailable))
        } catch {
          return null
        }
      },
    })
  }

  // 工具目录索引（工具渐进发现：分层生效时每轮注入按类别分组的纯名字索引 + search_tools 指针；
  // 未分层（开关关闭/未达阈值/无目录）时不注入——全量工具已在 tools 参数里）
  injectors.push({
    id: 'tool-catalog',
    order: INJECTOR_ORDER.TOOL_CATALOG,
    inject: (ctx) => {
      if (!ctx.toolCatalogActive || !ctx.toolCatalog || ctx.toolCatalog.length === 0) return null
      try {
        return systemMessage(buildCatalogIndex(ctx.toolCatalog, TOOL_CATALOG_INDEX_BUDGET_CHARS))
      } catch {
        return null
      }
    },
  })

  // 委派指南 prompt 片段（task 可用时注入；无可用 Subagent 时 buildDelegationGuide 返回 null）
  if (deps.getSubagents) {
    injectors.push({
      id: 'delegation-guide',
      order: INJECTOR_ORDER.DELEGATION_GUIDE,
      inject: async (ctx) => {
        if (!ctx.taskToolAvailable) return null
        try {
          const subagents: AvailableSubagent[] = deps.getSubagents!()
          const models: AvailableModel[] = deps.getAvailableModels ? await deps.getAvailableModels() : []
          const guide = buildDelegationGuide(subagents, models, ctx.toolCatalog)
          return guide ? systemMessage(guide) : null
        } catch {
          return null
        }
      },
    })
  }

  // skill 元数据（渐进式披露阶段1：仅加载元数据；统一为每轮注入——UI chat 现状不注入，是有意的行为对齐）
  if (deps.skillRegistry) {
    injectors.push({
      id: 'skill-metadata',
      order: INJECTOR_ORDER.SKILL_METADATA,
      inject: () => {
        try {
          return buildSkillSystemMessage(deps.skillRegistry!.getEnabled())
        } catch {
          return null
        }
      },
    })
  }

  // 长期记忆索引（软衰减排序；无记忆时为 null 跳过）
  if (deps.memoryStore) {
    injectors.push({
      id: 'memory-index',
      order: INJECTOR_ORDER.MEMORY_INDEX,
      inject: async () => {
        try {
          const injection = await deps.memoryStore!.buildIndexInjection()
          return injection ? systemMessage(injection) : null
        } catch {
          return null
        }
      },
    })

    // 待确认记忆提示（存在自动蒸馏出的候选时；非交互模式下抑制——审批需要人回答,提示只会带偏任务）
    injectors.push({
      id: 'memory-pending',
      order: INJECTOR_ORDER.MEMORY_PENDING,
      inject: async () => {
        if (deps.isNonInteractive?.()) return null
        try {
          const notice = await deps.memoryStore!.buildPendingNotice()
          return notice ? systemMessage(notice) : null
        } catch {
          return null
        }
      },
    })

    // per-agent 记忆索引（前台 agent 模板声明 memory 字段时注入自身空间索引 + 读写指引；
    // 私域紧随全局索引之后——共享底在前、私域在后；每轮现解析，切换前台/编辑模板即生效）
    injectors.push({
      id: 'agent-memory',
      order: INJECTOR_ORDER.AGENT_MEMORY,
      inject: async (ctx) => {
        if (!ctx.frontAgent || !deps.getSubagentTemplate) return null
        try {
          const template = deps.getSubagentTemplate(ctx.frontAgent)
          const scope = template?.memory
          if (!template || !isLocalSubagentTemplate(template) || !scope) return null
          const injection = await deps.memoryStore!.buildAgentIndexInjection?.(scope, ctx.frontAgent, ctx.workDir)
          if (!injection) return null
          return systemMessage(
            '【你的专属记忆空间】以下是你的私域长期记忆索引（跨会话保留，其他 agent 不可见）。' +
              '写入/更新调用 save_memory、删除调用 delete_memory（缺省即写入你的空间）；' +
              '用户偏好、用户纠正等"属于用户"的认知，用 scope: "global" 写入全局共享记忆。\n' +
              injection,
          )
        } catch {
          return null
        }
      },
    })
  }

  // AGENTS.md 用户约束（全局 ~/.chill + 工作目录；每轮现读，改完即生效）
  if (deps.agentInstructions) {
    injectors.push({
      id: 'agents-md',
      order: INJECTOR_ORDER.AGENTS_MD,
      inject: async (ctx) => {
        try {
          const injection = await deps.agentInstructions!.buildInjection(ctx.workDir)
          return injection ? systemMessage(injection) : null
        } catch {
          return null
        }
      },
    })
  }

  // 写边界（圈内直通/圈外审批的规则与当前边界集合；数据源为写边界单例，随 /add-dir 每轮现取现生效。
  // plan 模式与 -p readonly 不注入——写本被拦截，注入会与只读契约冲突；
  // autoApply on（含 -p --auto）注明"全量直接写、无审批"，否则文本谎称圈外会触发审批）
  injectors.push({
    id: 'write-boundary',
    order: INJECTOR_ORDER.WRITE_BOUNDARY,
    inject: (ctx) => {
      if (ctx.planMode) return null
      try {
        const boundary = getWriteBoundary()
        if (boundary.isReadonlyMode()) return null
        return systemMessage(
          buildWriteBoundaryPrompt(boundary.listWritableRoots(), {
            fullAccess: boundary.isFullAccess(),
          }),
        )
      } catch {
        return null
      }
    },
  })

  return injectors
}

/**
 * 上下文组装器：注入器框架（注册/卸载/按规范顺序求值）+ 媒体处理。
 * 引擎每轮工具循环前调用 assemble() 现组（注入项每轮现读，改完即生效）。
 */
export class ContextAssembler {
  private injectors: ContextInjector[] = []
  private mediaProvider?: MediaProvider

  constructor(options?: { mediaProvider?: MediaProvider; injectors?: ContextInjector[] }) {
    this.mediaProvider = options?.mediaProvider
    for (const injector of options?.injectors ?? []) {
      this.registerInjector(injector)
    }
  }

  /** 注册注入器（同 id 覆盖）；按 order 插入保持规范顺序（同级按注册先后） */
  registerInjector(injector: ContextInjector): void {
    this.injectors = this.injectors.filter((i) => i.id !== injector.id)
    let insertAt = this.injectors.findIndex((i) => i.order > injector.order)
    if (insertAt === -1) insertAt = this.injectors.length
    this.injectors.splice(insertAt, 0, injector)
  }

  /** 卸载注入器（宿主卸载专属注入时用） */
  unregisterInjector(id: string): boolean {
    const before = this.injectors.length
    this.injectors = this.injectors.filter((i) => i.id !== id)
    return this.injectors.length !== before
  }

  /** 当前注入器列表（只读，调试/测试用） */
  listInjectors(): readonly ContextInjector[] {
    return this.injectors
  }

  /** 求值全部注入器，产出 system 消息序列（单项异常不阻断其余项） */
  async assemblePrefix(context: AssembleContext): Promise<Message[]> {
    const messages: Message[] = []
    for (const injector of this.injectors) {
      try {
        const msg = await injector.inject(context)
        if (msg) messages.push(msg)
      } catch (error) {
        console.warn(`[ContextAssembler] 注入器 ${injector.id} 执行失败，已跳过:`, error)
      }
    }
    return messages
  }

  /**
   * 组装发给模型的完整消息序列：注入的 system 消息序列（规范顺序）
   * + 媒体处理后的历史（权威历史不被修改）。
   */
  async assemble(history: Message[], context: AssembleContext): Promise<Message[]> {
    const prefix = await this.assemblePrefix(context)
    const prepared = await prepareHistoryForSend(history, context.mediaCapabilities, this.mediaProvider)
    return prefix.length > 0 ? [...prefix, ...prepared] : prepared
  }
}
