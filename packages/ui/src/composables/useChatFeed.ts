import { shallowRef, ref, computed, reactive, triggerRef, onUnmounted, type ComputedRef, type ShallowRef } from 'vue'
import {
  MessageRole,
  ToolCallStatus,
  ContentBlockType,
  type Message,
  type ToolCall,
  type ContentBlock,
  type ModelOutput,
  type ChatEngineSessionState,
} from '@assistant-ai/core'
import { eventBus, EVENTS } from '@assistant-ai/core'
import { getToolComponent, isAgentTool } from '../toolUIRegistry'
import { useTaskListStore } from '../stores/taskListStore'
import { useChatResourceStore } from '../stores/chatResourceStore'
import { getChatEngine } from '../services/chatEngine'

/**
 * 会话消息流数据层（渲染架构 L1）。
 *
 * 核心不变量：每个流式 chunk 只携带 O(chunk) 新信息，因此任何一次 flush 的代价
 * 必须与历史轮数 N 无关。实现手段：
 * - history 为冻结的普通对象数组（shallowRef 持有），组件读不到响应式代理 → 永不重渲染；
 * - live 是唯一的可变点（reactive），chunk 只写它 → 每 flush 只有 MessageItem(live) 重渲染；
 * - 块派生（getOrderedBlocks 语义）前移到 append/首渲染时一次完成，不在模板内联调用；
 * - toolOutcomes / showTime 增量维护（O(1)/条，消灭原 O(N²) 扫描）；
 * - StreamBuffer 用 rAF 合并 chunk（chunk 经独立宏任务到达，Vue microtask 批处理无效）。
 *
 * 本模块是消息数据的唯一改写权威：ChatArea 门面方法与 eventBus 三事件全部先进 feed，
 * 冻结历史的改写（updateToolCallStatus 向后搜索 / markConversationComplete）经
 * thaw→改→refreeze 路径，严禁绕过。
 */

/** 一条工具调用的最终结局（由会话中 role:'tool' 的规范消息推导而来） */
export interface ToolOutcome {
  status?: ToolCallStatus
  result?: string
}

/** 渲染块：ContentBlock + 展示装饰字段（组件引用/显示名/任务快照，仅 UI 侧视图模型） */
export interface RenderBlock extends ContentBlock {
  toolCallId?: string
  displayName?: string
  status?: ToolCallStatus
  mcpServerName?: string
  result?: any
  artifacts?: any
  tasks?: any[]
  component?: any
}

/** 压缩 checkpoint 类型（core 未单独导出，从会话状态类型派生） */
export type CompactionCheckpoint = ChatEngineSessionState['compactions'][number]

/** 消息项：live=true 时为响应式可变对象（当前流式轮），否则为冻结历史 */
export interface FeedMessageItem {
  kind: 'message'
  seq: number
  key: string
  live: boolean
  /**
   * 流式已启动标记（仅 live 项有意义）：首个 chunk 写入后置 true。
   * 区分两种 live 态——"占位/回填完整消息"（false：MessageMarkdown 挂载即定稿，
   * 代码块正常高亮、JSON 候选兜底解包）与"正在流式输出"（true：保持开放块）。
   */
  streamActive?: boolean
  message: Message
  blocks: RenderBlock[]
  showTime: boolean
}

/** 消息时间戳统一为毫秒（JSON 往返后可能是字符串） */
const messageTime = (m: Message): number => {
  return m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp as unknown as string).getTime()
}

/** 内置任务清单工具判定（创建任务快照用） */
const isTaskListTool = (toolName: string): boolean =>
  toolName === 'create_task_list' || toolName === 'update_task_status' || toolName === 'delete_task' || toolName === 'add_task'

// ==================== 工具名 → Agent 显示名（吸收自 ChatArea.getAgentDisplayName） ====================

function makeSanitizeNameForMatching(chatResourceStore: ReturnType<typeof useChatResourceStore>) {
  const sanitizeNameForMatching = (name: string, id?: string): string => {
    let sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!sanitized) {
      sanitized = id ? 'agent_' + id.slice(-8) : 'agent_' + Math.random().toString(36).substring(2, 10)
    }
    return sanitized
  }
  return (toolName: string): string | undefined => {
    if (!isAgentTool(toolName)) return undefined
    const prefix = toolName.startsWith('execute_remote_agent_') ? 'execute_remote_agent_' : 'execute_local_agent_'
    for (const resource of chatResourceStore.resources) {
      if (resource.type !== 'local_agent' && resource.type !== 'remote_agent') continue
      const resourceToolName = `${prefix}${sanitizeNameForMatching(resource.name, resource.id)}`
      if (resourceToolName === toolName) {
        return resource.name
      }
    }
    return undefined
  }
}

// ==================== StreamBuffer：rAF 合并流式增量 ====================

/** 单次流式增量（chunk 的三要素；字符串增量拼接、toolCalls 末次生效） */
interface PendingDelta {
  content: string
  reasoningContent: string
  toolCalls: ToolCall[] | null
}

class StreamBuffer {
  private delta: PendingDelta | null = null
  private rafId: number | null = null

  constructor(private apply: (d: PendingDelta) => void) {}

  push(content: string, reasoningContent: string, toolCalls?: ToolCall[]): void {
    if (!this.delta) this.delta = { content: '', reasoningContent: '', toolCalls: null }
    this.delta.content += content
    this.delta.reasoningContent += reasoningContent
    if (toolCalls && toolCalls.length > 0) this.delta.toolCalls = toolCalls
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null
        this.flush()
      })
    }
  }

  /** 同步冲刷（结构性操作前必须调用：freeze/clear 前把挂起增量落到当前 live） */
  flush(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    if (this.delta) {
      const d = this.delta
      this.delta = null
      this.apply(d)
    }
  }

  /** 丢弃（clearMessages：孤儿 chunk 落入已废弃缓冲被丢弃） */
  drop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    this.delta = null
  }
}

// ==================== 主 composable ====================

export interface ChatFeed {
  /** 消息项（纯消息流；压缩标记条的交织是视图关注点，由 ChatArea 按窗口局部派生） */
  items: ShallowRef<FeedMessageItem[]>
  /** 压缩 checkpoint 镜像（clear/refreshCompactions 时重取引擎） */
  compactions: ShallowRef<CompactionCheckpoint[]>
  hasMessages: ComputedRef<boolean>
  /** 当前引擎会话 id（位置记忆键来源；ChatArea 不直接依赖引擎服务） */
  currentSessionId: () => string | null
  addMessage: (message: Message) => void
  updateLastMessage: (content: string, reasoningContent?: string, toolCalls?: ToolCall[]) => void
  updateLastOutput: (output: ModelOutput) => void
  updateToolCallStatus: (
    toolCallStatus: ToolCallStatus,
    mcpServerName?: string,
    toolParameters?: Record<string, any>,
    toolResult?: any,
    toolCallId?: string,
    toolCall?: ToolCall
  ) => void
  clearMessages: () => void
  markConversationComplete: () => void
  refreshCompactions: () => void
  /** flush 后回调（ChatArea 据此做置底滚动） */
  setOnFlush: (fn: () => void) => void
  /** 结构性新增后回调（携带 role：ChatArea 据此区分 USER 必见/其余按 pinned 跟随） */
  setOnStructural: (fn: (meta: { role: MessageRole }) => void) => void
}

export function useChatFeed(): ChatFeed {
  const taskListStore = useTaskListStore()
  const chatResourceStore = useChatResourceStore()
  const getAgentDisplayName = makeSanitizeNameForMatching(chatResourceStore)

  // ---- 状态 ----
  /** 消息项（shallowRef 只追踪数组身份；push 后由变更路径显式 triggerRef） */
  const items = shallowRef<FeedMessageItem[]>([])
  /** role:tool 消息推导的工具结局（非响应式；仅供冻结派生用） */
  let outcomes = new Map<string, ToolOutcome>()
  /** 已追加消息总数（含 tool/system——hasMessages 语义与原 messages.length 对齐） */
  const rawCount = ref(0)
  /** 单调递增 seq：key 永不从可变字段派生（修掉原 timestamp 派生 key 每轮结束重挂的 bug） */
  let seqCounter = 0
  /** 压缩 checkpoint 镜像（引擎状态非响应式故镜像为 shallowRef） */
  const compactions = shallowRef<CompactionCheckpoint[]>([])
  /** 最近一个非 sub assistant 项（其后无 user 消息）——showTime 增量维护用 */
  let lastNonSubAssistantNoUser: FeedMessageItem | null = null

  const hasMessages = computed(() => rawCount.value > 0)

  let onFlush: (() => void) | null = null
  let onStructural: ((meta: { role: MessageRole }) => void) | null = null

  // ---- 派生（吸收自 messageTransform.getOrderedBlocks，append/首渲染时一次完成） ----

  const deriveBlocks = (message: Message, ownerSeq: number): RenderBlock[] => {
    if (message.contentBlocks) {
      return message.contentBlocks
        .map((block) => {
          if (block.type === ContentBlockType.TOOL_CALL && (block as RenderBlock).toolName) {
            const rb = block as RenderBlock
            return { ...rb, component: rb.component ?? getToolComponent(rb.toolName!) }
          }
          return block as RenderBlock
        })
        .sort((a, b) => a.position - b.position)
    }

    const blocks: RenderBlock[] = []
    let position = 0

    if (message.reasoningContent) {
      blocks.push({
        id: `${ownerSeq}-reasoning`,
        type: ContentBlockType.REASONING,
        position: position++,
        content: message.reasoningContent,
      })
    }

    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        const outcome = outcomes.get(toolCall.id)
        // 状态优先级：消息自带展示态（UI 实时累积）> 规范 tool 消息标记 > 有结果消息回退 SUCCESS > 无结果消息保持 RUNNING
        const status =
          message.toolCallStatuses?.[toolCall.id] ??
          outcome?.status ??
          (outcome ? ToolCallStatus.SUCCESS : ToolCallStatus.RUNNING)
        const result = message.toolCallResults?.[toolCall.id]

        const rawServerName = result?.mcpServerName || message.mcpServerName
        const resolvedServerName = (rawServerName || '').replace(/^mcp-/, '')

        let derivedResult: any = result?.result
        let artifacts = result?.artifacts
        if (derivedResult === undefined && outcome?.result !== undefined) {
          derivedResult = outcome.result
          try {
            const parsed = JSON.parse(outcome.result)
            if (parsed && typeof parsed === 'object') {
              if ('content' in parsed) derivedResult = parsed.content
              if (parsed.artifacts) artifacts = parsed.artifacts
            }
          } catch {
            /* 非 JSON，按原文展示 */
          }
        }

        let parameters: any = {}
        try {
          parameters = JSON.parse(toolCall.function.arguments || '{}')
        } catch {
          /* 参数残缺时按空对象展示 */
        }

        blocks.push({
          id: `tool_call-${toolCall.id}`,
          type: ContentBlockType.TOOL_CALL,
          position: position++,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          parameters,
          status,
          mcpServerName: resolvedServerName,
          result: derivedResult,
          artifacts,
        })
      }
    }

    if (message.content) {
      if (typeof message.content === 'string') {
        blocks.push({
          id: `${ownerSeq}-text-0`,
          type: ContentBlockType.TEXT,
          position: position++,
          content: message.content,
        })
      } else {
        for (const part of message.content as any[]) {
          if (part.type === 'text' && part.text) {
            blocks.push({
              id: `${ownerSeq}-text-${position}`,
              type: ContentBlockType.TEXT,
              position: position++,
              content: part.text,
            })
          } else if (part.type === 'image_url' && part.image_url) {
            blocks.push({
              id: `${ownerSeq}-image-${position}`,
              type: ContentBlockType.IMAGE,
              position: position++,
              url: part.image_url.url,
            })
          } else if (part.type === 'video_url' && part.video_url) {
            let videoUrl: string = part.video_url.url
            if (!videoUrl.startsWith('data:')) {
              videoUrl = `app://-attachments/${videoUrl}`
            }
            blocks.push({
              id: `${ownerSeq}-video-${position}`,
              type: ContentBlockType.VIDEO,
              position: position++,
              url: videoUrl,
            })
          }
        }
      }
    }

    return blocks
  }

  // ---- 项目构造 ----

  /** 冻结历史项：普通对象 + 懒派生 blocks（首渲染访问时一次完成——refill 同步循环结束后 map 已完整） */
  const makeFrozenItem = (message: Message): FeedMessageItem => {
    const seq = ++seqCounter
    const frozenMsg = Object.freeze({ ...message }) as Message
    let cache: RenderBlock[] | null = null
    const item: FeedMessageItem = {
      kind: 'message',
      seq,
      key: `m${seq}`,
      live: false,
      message: frozenMsg,
      get blocks() {
        if (!cache) cache = Object.freeze(deriveBlocks(frozenMsg, seq)) as RenderBlock[]
        return cache
      },
      showTime: message.role === MessageRole.USER ? true : !message.isSubResponse,
    }
    return item
  }

  /** live 项：reactive（全场唯一可变点；chunk 只写它）。非 sub assistant（错误提示/回填终答）时间标签按原语义显示。
   * blocks 懒派生：首次访问时从 message 一次派生——空占位（事件/发送前占位）派生为 []，
   * 由 applyDelta 增量构建；完整消息（历史回填/错误提示/异步任务占位）派生即可渲染。
   * 派生时机在首渲染访问（回填同步循环结束后 outcomes 已完整——两阶段时序成立）；
   * 流式路径 applyDelta 先取 blocks 再改 message，避免派生读到半拍状态重复建块。 */
  const makeLive = (message: Message): FeedMessageItem => {
    const seq = ++seqCounter
    let cache: RenderBlock[] | null = null
    const base = {
      kind: 'message' as const,
      seq,
      key: `m${seq}`,
      live: true,
      streamActive: false,
      message: { ...message },
      showTime: message.role === MessageRole.USER ? true : !message.isSubResponse,
      get blocks(): RenderBlock[] {
        if (!cache) cache = deriveBlocks(base.message, seq)
        return cache
      },
    }
    return reactive(base) as unknown as FeedMessageItem
  }

  /** 冻结一个 live 项（结构变化时：当前值快照为不可变历史；块元素克隆以剥离响应式代理） */
  const freezeLiveItem = (it: FeedMessageItem): FeedMessageItem => {
    const seq = it.seq
    return {
      kind: 'message',
      seq,
      key: it.key,
      live: false,
      message: Object.freeze({ ...it.message }),
      blocks: Object.freeze(it.blocks.map((b) => ({ ...b }))),
      showTime: it.showTime,
    }
  }

  // ---- 内部原语 ----

  /** 尾随 live assistant（updateLastMessage 的"尾随 assistant 才写入，否则早退"面相语义） */
  const trailingLive = (): FeedMessageItem | null => {
    const last = items.value[items.value.length - 1]
    return last && last.live && last.message.role === MessageRole.ASSISTANT ? last : null
  }

  /** 结构性追加一条消息（消息项进入列表；tool/system 只记 outcomes） */
  const appendOne = (message: Message): void => {
    rawCount.value++

    if (message.role === MessageRole.TOOL || message.role === MessageRole.SYSTEM) {
      // tool/system：不创建渲染项（原 v-show 隐藏但完整渲染上百 KB 工具结果）；仅维护 outcomes map
      const tc = message as Message & { toolCallId?: string; toolCallStatus?: ToolCallStatus }
      if (tc.toolCallId) {
        outcomes.set(tc.toolCallId, {
          status: tc.toolCallStatus,
          result: typeof message.content === 'string' ? message.content : undefined,
        })
      }
      return
    }

    // 冻结尾随 live（轮次边界）
    const live = trailingLive()
    if (live) {
      const idx = items.value.indexOf(live)
      const frozen = freezeLiveItem(live)
      items.value[idx] = frozen
      // 冻结替换后，lastNonSubAssistantNoUser 指针可能指向被替换的旧对象
      if (lastNonSubAssistantNoUser === live) lastNonSubAssistantNoUser = frozen
    }

    const isAssistantPlaceholder = message.role === MessageRole.ASSISTANT
    const item = isAssistantPlaceholder ? makeLive(message) : makeFrozenItem(message)

    items.value.push(item)

    // showTime 增量维护
    if (message.role === MessageRole.USER) {
      lastNonSubAssistantNoUser = null
    } else if (message.role === MessageRole.ASSISTANT && !message.isSubResponse) {
      // 新非 sub assistant：前一个"其后无 user"的非 sub assistant 时间标签转隐藏
      if (lastNonSubAssistantNoUser) lastNonSubAssistantNoUser.showTime = false
      lastNonSubAssistantNoUser = item
    }
    // sub assistant 不影响指针

    triggerRef(items)
    onStructural?.({ role: message.role })
  }

  // ---- StreamBuffer 应用（live 更新的唯一入口） ----

  const applyDelta = (d: PendingDelta): void => {
    const it = trailingLive()
    if (!it) return
    const msg = it.message
    // 先解析 blocks（在改动 message 之前——懒派生读的是当刻消息快照，先取避免派生与推送重复建块；
    // 经 reactive 代理取出，后续读写均被追踪）。同时标记流式启动（MessageMarkdown 据此区分占位/回填态）。
    const blocks = it.blocks
    it.streamActive = true

    // reasoning：首块创建 / 增量追加
    if (d.reasoningContent) {
      if (!msg.reasoningContent) {
        msg.reasoningContent = d.reasoningContent
        blocks.push({
          id: `${it.seq}-reasoning`,
          type: ContentBlockType.REASONING,
          position: blocks.length,
          content: msg.reasoningContent,
        })
      } else {
        msg.reasoningContent += d.reasoningContent
        const rb = blocks.find((b) => b.type === ContentBlockType.REASONING)
        if (rb) rb.content = msg.reasoningContent
      }
    }

    // toolCalls：末次生效；缺失块补建
    if (d.toolCalls && d.toolCalls.length > 0) {
      msg.toolCalls = d.toolCalls
      for (const toolCall of d.toolCalls) {
        const existing = blocks.find((b) => b.type === ContentBlockType.TOOL_CALL && b.toolCallId === toolCall.id)
        if (!existing) {
          const toolName = toolCall.function.name
          const toolTasks = isTaskListTool(toolName) ? taskListStore.tasks.map((t) => ({ ...t })) : undefined
          let parameters: any = {}
          try {
            parameters = JSON.parse(toolCall.function.arguments || '{}')
          } catch {
            /* 参数残缺按空对象 */
          }
          blocks.push({
            id: `tool_call-${toolCall.id}`,
            type: ContentBlockType.TOOL_CALL,
            position: blocks.length,
            toolCallId: toolCall.id,
            toolName,
            displayName: getAgentDisplayName(toolName),
            parameters,
            status: ToolCallStatus.RUNNING,
            mcpServerName: msg.mcpServerName,
            result: undefined,
            component: getToolComponent(toolName),
            tasks: toolTasks,
          })
        }
      }
    }

    // content：首块创建（跳过工具调用前后的纯换行）/ 增量追加
    if (d.content) {
      if (!msg.content) {
        const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null
        const isAfterToolCall = lastBlock?.type === ContentBlockType.TOOL_CALL
        const isPureNewline = d.content.trim() === ''
        const hasOtherBlocks = blocks.length > 0
        if (!((isAfterToolCall || hasOtherBlocks) && isPureNewline)) {
          msg.content = d.content
          blocks.push({
            id: `${it.seq}-text-0`,
            type: ContentBlockType.TEXT,
            position: blocks.length,
            content: d.content,
          })
        }
      } else {
        msg.content += d.content
        const tb = blocks.find((b) => b.type === ContentBlockType.TEXT)
        if (tb) tb.content = msg.content
      }
    }

    // reasoning 自动折叠信号由 MessageItem 监听 content 变化实现（等价面相）
    onFlush?.()
  }

  const buffer = new StreamBuffer(applyDelta)

  // ---- 对外门面 ----

  const addMessage = (message: Message): void => {
    buffer.flush() // 结构操作前先落挂起增量（事件与 rAF 之间的时序闭环）
    appendOne(message)
  }

  const updateLastMessage = (content: string, reasoningContent?: string, toolCalls?: ToolCall[]): void => {
    buffer.push(content || '', reasoningContent || '', toolCalls)
  }

  /** 递归将 ModelOutput 转为渲染块（吸收自 ChatArea.convertOutputToBlocks） */
  const convertOutputToBlocks = (output: ModelOutput, basePosition: number): RenderBlock[] => {
    const blocks: RenderBlock[] = []
    if (output.type === 'mixed') {
      let pos = basePosition
      for (const part of output.parts) {
        const childBlocks = convertOutputToBlocks(part, pos)
        blocks.push(...childBlocks)
        pos += childBlocks.length
      }
    } else if (output.type === 'text') {
      blocks.push({
        id: `output-text-${basePosition}`,
        type: ContentBlockType.TEXT,
        position: basePosition,
        content: output.content,
      })
    } else if (output.type === 'image') {
      blocks.push({ id: `output-image-${basePosition}`, type: ContentBlockType.IMAGE, position: basePosition, url: output.url })
    } else if (output.type === 'video') {
      blocks.push({ id: `output-video-${basePosition}`, type: ContentBlockType.VIDEO, position: basePosition, url: output.url })
    } else if (output.type === 'audio') {
      blocks.push({ id: `output-audio-${basePosition}`, type: ContentBlockType.AUDIO, position: basePosition, url: output.url })
    }
    return blocks
  }

  const updateLastOutput = (output: ModelOutput): void => {
    buffer.flush()
    const it = trailingLive()
    if (!it) return

    // 移除已有 output 块（image/video/audio，按 id 前缀识别）后追加新块
    const kept = it.blocks.filter((b) => !b.id.startsWith('output-'))
    it.blocks.length = 0
    it.blocks.push(...kept)
    const newBlocks = convertOutputToBlocks(output, kept.length)
    it.blocks.push(...newBlocks)

    if (output.type === 'text') {
      it.message.content = output.content
    }
    onFlush?.()
  }

  const updateToolCallStatus = (
    toolCallStatus: ToolCallStatus,
    mcpServerName?: string,
    toolParameters?: Record<string, any>,
    toolResult?: any,
    toolCallId?: string,
    toolCall?: ToolCall
  ): void => {
    buffer.flush()

    // 向后搜索包含此 toolCallId 的 assistant 消息项
    let target: FeedMessageItem | undefined
    for (let i = items.value.length - 1; i >= 0; i--) {
      const it = items.value[i]
      if (it.message.role !== MessageRole.ASSISTANT) continue
      if (
        it.message.toolCalls?.some((tc) => tc.id === toolCallId) ||
        it.blocks.some((b) => b.type === ContentBlockType.TOOL_CALL && b.toolCallId === toolCallId) ||
        (toolCallId && it.message.toolCallStatuses && toolCallId in it.message.toolCallStatuses)
      ) {
        target = it
        break
      }
    }
    if (!target) {
      for (let i = items.value.length - 1; i >= 0; i--) {
        if (items.value[i].message.role === MessageRole.ASSISTANT) {
          target = items.value[i]
          break
        }
      }
    }
    if (!target) return

    /** 在指定项上执行状态写入（live 直接写；冻结项经 thaw→改→refreeze） */
    const applyTo = (it: FeedMessageItem): FeedMessageItem => {
      const msg = it.message
      if (toolCallId) {
        if (!msg.toolCallStatuses) msg.toolCallStatuses = {}
        if (!msg.toolCallResults) msg.toolCallResults = {}
        msg.toolCallStatuses[toolCallId] = toolCallStatus
        if (!msg.toolCallResults[toolCallId]) msg.toolCallResults[toolCallId] = {}
        if (mcpServerName) msg.toolCallResults[toolCallId].mcpServerName = mcpServerName
        if (toolParameters) msg.toolCallResults[toolCallId].parameters = toolParameters
        if (toolResult !== undefined) {
          msg.toolCallResults[toolCallId].result = toolResult
          if (typeof toolResult === 'object' && toolResult !== null && 'artifacts' in toolResult) {
            msg.toolCallResults[toolCallId].artifacts = toolResult.artifacts
          }
        }
        if (!msg.toolCalls) msg.toolCalls = []
        if (toolCall && !msg.toolCalls.find((tc) => tc.id === toolCall.id)) {
          msg.toolCalls.push(toolCall)
        }

        // 块级写入：缺失则补建（防御事件先于块创建到达）
        let block = it.blocks.find((b) => b.type === ContentBlockType.TOOL_CALL && b.toolCallId === toolCallId)
        if (!block && toolCall) {
          const toolName = toolCall.function.name
          let parameters: any = toolParameters
          if (parameters === undefined) {
            try {
              parameters = JSON.parse(toolCall.function.arguments || '{}')
            } catch {
              parameters = {}
            }
          }
          block = {
            id: `tool_call-${toolCall.id}`,
            type: ContentBlockType.TOOL_CALL,
            position: it.blocks.length,
            toolCallId: toolCall.id,
            toolName,
            displayName: getAgentDisplayName(toolName),
            parameters,
            status: toolCallStatus,
            mcpServerName: mcpServerName || msg.mcpServerName,
            result: toolResult,
            artifacts: typeof toolResult === 'object' && toolResult !== null ? toolResult.artifacts : undefined,
            component: getToolComponent(toolName),
            tasks: isTaskListTool(toolName) ? taskListStore.tasks.map((t) => ({ ...t })) : undefined,
          }
          it.blocks.push(block)
        }
        if (block) {
          block.status = toolCallStatus
          if (mcpServerName) block.mcpServerName = mcpServerName
          if (toolParameters) block.parameters = toolParameters
          if (toolResult !== undefined) {
            block.result = toolResult
            if (typeof toolResult === 'object' && toolResult !== null && 'artifacts' in toolResult) {
              block.artifacts = toolResult.artifacts
            }
          }
          if (block.toolName && isTaskListTool(block.toolName)) {
            block.tasks = taskListStore.tasks.map((t) => ({ ...t }))
          }
        }
      } else {
        // 向后兼容：无 toolCallId 时写单值字段
        msg.toolCallStatus = toolCallStatus
        if (mcpServerName) msg.mcpServerName = mcpServerName
        if (toolParameters) (msg as any).toolParameters = toolParameters
        if (toolResult !== undefined) (msg as any).toolResult = toolResult
      }
      return it
    }

    if (target.live) {
      applyTo(target)
    } else {
      // thaw → 改 → refreeze（feed 是唯一改写权威，冻结历史的修改必经此路）
      const idx = items.value.indexOf(target)
      const thawed: FeedMessageItem = {
        kind: 'message',
        seq: target.seq,
        key: target.key,
        live: false,
        message: { ...target.message },
        blocks: [...target.blocks],
        showTime: target.showTime,
      }
      applyTo(thawed)
      const refrozen: FeedMessageItem = {
        kind: 'message',
        seq: thawed.seq,
        key: thawed.key,
        live: false,
        message: Object.freeze(thawed.message),
        blocks: Object.freeze(thawed.blocks),
        showTime: thawed.showTime,
      }
      items.value[idx] = refrozen
      if (lastNonSubAssistantNoUser === target) lastNonSubAssistantNoUser = refrozen
      triggerRef(items)
    }
  }

  const clearMessages = (): void => {
    buffer.drop() // 孤儿 chunk 丢弃（中断/切会话时序闭环）
    items.value = []
    outcomes = new Map()
    rawCount.value = 0
    lastNonSubAssistantNoUser = null
    // 切换/新建会话后旧会话的压缩标记条不残留（镜像随引擎当前会话重取）
    compactions.value = getChatEngine().getSessionState().compactions ?? []
    triggerRef(items)
  }

  const markConversationComplete = (): void => {
    buffer.flush()
    // 找最后一个 assistant 消息项
    let target: FeedMessageItem | undefined
    for (let i = items.value.length - 1; i >= 0; i--) {
      if (items.value[i].message.role === MessageRole.ASSISTANT) {
        target = items.value[i]
        break
      }
    }
    if (!target) return

    /** 展示字段重派生（冻结的 showTime 随 isSubResponse 翻转失效——事件驱动失效对账闭环） */
    const complete = (it: FeedMessageItem): FeedMessageItem => {
      it.message.timestamp = new Date()
      it.message.isSubResponse = false
      // 前一个"其后无 user"的非 sub assistant 时间标签转隐藏（增量维护语义）
      if (lastNonSubAssistantNoUser && lastNonSubAssistantNoUser !== it) {
        lastNonSubAssistantNoUser.showTime = false
      }
      it.showTime = true
      lastNonSubAssistantNoUser = it
      return it
    }

    if (target.live) {
      complete(target)
      // 终态冻结：live → 冻结快照（组件 prop 更替带动 MessageMarkdown finalize，
      // 闭合开放代码块/JSON 候选——否则最后一轮的开放块要等下一轮开始才闭合）
      const idx = items.value.indexOf(target)
      const frozen = freezeLiveItem(target)
      items.value[idx] = frozen
      if (lastNonSubAssistantNoUser === target) lastNonSubAssistantNoUser = frozen
      triggerRef(items)
    } else {
      const idx = items.value.indexOf(target)
      const thawed: FeedMessageItem = {
        kind: 'message',
        seq: target.seq,
        key: target.key,
        live: false,
        message: { ...target.message },
        blocks: target.blocks, // 块不变，沿用（含懒派生缓存语义的 getter 会被展开，此处直接取值）
        showTime: target.showTime,
      }
      complete(thawed)
      items.value[idx] = {
        kind: 'message',
        seq: thawed.seq,
        key: thawed.key,
        live: false,
        message: Object.freeze(thawed.message),
        blocks: Object.freeze([...thawed.blocks]),
        showTime: thawed.showTime,
      }
      if (lastNonSubAssistantNoUser === target) lastNonSubAssistantNoUser = items.value[idx]
      triggerRef(items)
    }
  }

  const refreshCompactions = (): void => {
    compactions.value = getChatEngine().getSessionState().compactions ?? []
  }

  const currentSessionId = (): string | null => {
    return getChatEngine().getSessionState().sessionId ?? null
  }

  // ---- eventBus 三事件收敛（唯一事件入口） ----

  const onToolMessageCreated = (data: any): void => {
    if (data.module === 'workflow') return
    buffer.flush()
    const message = data.message as Message
    rawCount.value++
    const tc = message as Message & { toolCallId?: string }
    if (tc.toolCallId) {
      outcomes.set(tc.toolCallId, {
        status: message.toolCallStatus,
        result: typeof message.content === 'string' ? message.content : undefined,
      })
    }
  }

  const onAssistantMessageCreated = (data: any): void => {
    if (data.module === 'workflow') return
    buffer.flush()
    appendOne(data.message as Message)
  }

  const onToolCallStatusChanged = (data: any): void => {
    if (data.module === 'workflow') return
    updateToolCallStatus(
      data.toolCallStatus,
      data.mcpServerName,
      data.toolParameters,
      data.toolResult,
      data.toolCallId,
      data.toolCall
    )
  }

  eventBus.on(EVENTS.TOOL_MESSAGE_CREATED, onToolMessageCreated)
  eventBus.on(EVENTS.ASSISTANT_MESSAGE_CREATED, onAssistantMessageCreated)
  eventBus.on(EVENTS.TOOL_CALL_STATUS_CHANGED, onToolCallStatusChanged)
  onUnmounted(() => {
    eventBus.off(EVENTS.TOOL_MESSAGE_CREATED, onToolMessageCreated)
    eventBus.off(EVENTS.ASSISTANT_MESSAGE_CREATED, onAssistantMessageCreated)
    eventBus.off(EVENTS.TOOL_CALL_STATUS_CHANGED, onToolCallStatusChanged)
    buffer.drop()
  })

  return {
    items,
    compactions,
    hasMessages,
    currentSessionId,
    addMessage,
    updateLastMessage,
    updateLastOutput,
    updateToolCallStatus,
    clearMessages,
    markConversationComplete,
    refreshCompactions,
    setOnFlush: (fn: () => void) => {
      onFlush = fn
    },
    setOnStructural: (fn: (meta: { role: MessageRole }) => void) => {
      onStructural = fn
    },
  }
}
