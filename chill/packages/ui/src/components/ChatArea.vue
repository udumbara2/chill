<template>
  <div class="chat-container">
    <div class="chat-messages" ref="messagesContainer" @scroll.passive="handleScroll">
      <!-- 顶部占位：未挂载历史区段的高度（实测缓存优先，未测用已烘焙的估算值） -->
      <div v-if="windowStart > 0" class="window-spacer" :style="{ height: topSum + 'px' }"></div>

      <template v-for="(item, i) in visibleItems" :key="item.key">
        <!-- 压缩分割线（视图化交织：insertionIndex 落在窗口内才渲染；时间戳单调二分定位） -->
        <CompactionMarker
          v-for="cp in markerLayout.at.get(windowStart + i)"
          :key="'cp-' + cp.id"
          :cp="cp"
        />
        <!-- 消息项：块列表已在数据层派生冻结；live 项经响应式追踪按需重渲染，历史项跳过更新 -->
        <MessageItem :item="item" :ref="el => collectItemRef(windowStart + i, el)" />
      </template>

      <!-- 尾随压缩分割线（切点晚于全部消息；窗口含末条时渲染） -->
      <template v-if="windowEnd === items.length">
        <CompactionMarker
          v-for="cp in markerLayout.trailing"
          :key="'cp-t-' + cp.id"
          :cp="cp"
        />
      </template>

      <!-- 底部占位：未挂载尾区段的高度 -->
      <div v-if="windowEnd < items.length" class="window-spacer" :style="{ height: bottomSum + 'px' }"></div>

      <!-- hook 系统提示卡片（core HOOK_MESSAGE 事件 → hookMessageStore；不入模型上下文，可逐条关闭） -->
      <div v-for="notice in hookMessageStore.notices" :key="notice.id" class="synthetic-notice synthetic-landing hook-notice">
        <div class="hook-notice-text">[hook] <MessageMarkdown :content="notice.text" /></div>
        <button class="hook-notice-close" title="关闭" @click="hookMessageStore.dismiss(notice.id)">×</button>
      </div>
    </div>

    <!-- 回到底部（非粘底时出现：向下驱逐后新内容不必然撑高滚动条，此按钮为回看出口） -->
    <Transition name="back-to-bottom-fade">
      <button v-if="showBackToBottom" class="back-to-bottom" title="回到底部" @click="backToBottom">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <polyline points="19 12 12 19 5 12"></polyline>
        </svg>
      </button>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { MessageRole } from '@assistant-ai/core'
import { useChatFeed, type FeedMessageItem, type CompactionCheckpoint } from '../composables/useChatFeed'
import MessageItem from './MessageItem.vue'
import CompactionMarker from './CompactionMarker.vue'
import { useHookMessageStore } from '../stores/hookMessageStore'
import { useTaskListStore } from '../stores/taskListStore'
import { getActiveSessionId } from '../services/chatEngine'
import MessageMarkdown from './MessageMarkdown.vue'

/**
 * 会话消息区瘦壳（渲染架构 L2）—— 锚点原语 + 双向滑动窗口。
 *
 * 公理：首屏代价 ∝ 视口（与 N 无关）；挂载数有与 N、与滚动距离无关的上界；
 * 一切定位/位置保持是 anchorTo/capture 两原语的应用。
 *
 * 状态（四个）：scrollTop（DOM 持有的唯一位置真源）、高度表 heights[i]（实测优先，
 * 估算惰性烘焙；含 GAP 折算）、窗口 [start, end)、每会话记忆 Map。
 * 纯函数：窗口随滚动按滞回几何调整（视口外不足 2 屏扩展、超 3 屏驱逐）。
 * 锚点纪律：凡窗口变更改变视口上方内容（上向扩展），变更前记锚点元素 rect.top，
 * 挂载后按 rect 差值补偿 scrollTop（实测差值同时覆盖估算误差与标记条高度）。
 * overflow-anchor: none——原生滚动锚定与本补偿是竞争机制，叠加会过度补偿。
 */
const hookMessageStore = useHookMessageStore()
const taskListStore = useTaskListStore()

const feed = useChatFeed()
const items = feed.items
const compactions = feed.compactions

/** 滞回几何（单位：屏）；驱逐只发生在曾挂载条目上（高度皆实测，spacer 精确无钳制抖动） */
const OVERSCAN_SCREENS = 2
const EVICT_SCREENS = 3

// ==================== 压缩分割线（视图化交织；展开态归 CompactionMarker 组件本地） ====================

const msgTime = (m: FeedMessageItem['message']): number => {
  return m.timestamp instanceof Date ? m.timestamp.getTime() : new Date(m.timestamp as unknown as string).getTime()
}

/** 窗口内的分割线布局：锚 = createdAt（压缩发生时刻，事件语义——新压缩落底部 trailing，
 *  重载后二分放回当时的流末；insertionIndex = 首个 t(msg) > 锚 的下标，时间戳单调二分） */
const markerLayout = computed<{ at: Map<number, CompactionCheckpoint[]>; trailing: CompactionCheckpoint[] }>(() => {
  const at = new Map<number, CompactionCheckpoint[]>()
  const trailing: CompactionCheckpoint[] = []
  const N = items.value.length
  const cps = [...compactions.value].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
  if (N === 0) return { at, trailing }
  for (const cp of cps) {
    const anchor = new Date(cp.createdAt).getTime()
    let lo = 0
    let hi = N
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (msgTime(items.value[mid].message) <= anchor) lo = mid + 1
      else hi = mid
    }
    if (lo === N) {
      trailing.push(cp)
      continue
    }
    if (lo >= windowStart.value && lo < windowEnd.value) {
      const arr = at.get(lo)
      if (arr) arr.push(cp)
      else at.set(lo, [cp])
    }
  }
  return { at, trailing }
})

// ==================== 高度表（实测优先，估算惰性烘焙） ====================

/** 条目间 gap（挂载时从 computed style 读一次，折算进每条目槽高） */
let GAP = 12
let heights: (number | undefined)[] = []
let measuredSum = 0
let measuredCount = 0

const estimateContent = (): number => (measuredCount > 0 ? measuredSum / measuredCount : 128)

/** 条目槽高（含 GAP）；未测条目首次被需要时烘焙当时估算（保持区段和一致性） */
const eff = (i: number): number => {
  let h = heights[i]
  if (h === undefined) {
    h = estimateContent()
    heights[i] = h
  }
  return h + GAP
}

const itemsPerScreen = (): number => {
  const vh = messagesContainer.value?.clientHeight ?? 600
  return Math.max(4, Math.round(vh / (estimateContent() + GAP)))
}

// ---- 条目根元素实测（ResizeObserver；ref 回调 + sweep 回收） ----

const messagesContainer = ref<HTMLElement>()
const indexEls = new Map<number, HTMLElement>()
const observedEls = new Map<HTMLElement, number>()
let itemRO: ResizeObserver | null = null

const collectItemRef = (index: number, el: unknown): void => {
  // MessageItem 是组件：ref 收到的是组件实例，取 $el 解到根元素
  let node: unknown = el
  if (node && typeof node === 'object' && '$el' in node) {
    node = (node as { $el: unknown }).$el
  }
  if (!(node instanceof HTMLElement)) return // 卸载（null）经 sweep 回收
  indexEls.set(index, node)
  if (!itemRO) {
    itemRO = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const idx = observedEls.get(entry.target as HTMLElement)
        if (idx === undefined) continue
        const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
        const prev = heights[idx]
        heights[idx] = h
        if (prev === undefined) {
          measuredSum += h
          measuredCount++
        } else {
          measuredSum += h - prev
        }
      }
    })
  }
  if (!observedEls.has(node)) {
    observedEls.set(node, index)
    itemRO.observe(node)
  }
}

/** 回收离窗元素（驱逐循环下防观察表无界增长） */
const sweep = (): void => {
  for (const [el, idx] of observedEls) {
    if (!el.isConnected) {
      itemRO?.unobserve(el)
      observedEls.delete(el)
      if (indexEls.get(idx) === el) indexEls.delete(idx)
    }
  }
}

// ==================== 窗口状态与区段和（增量维护，O(1) 均摊） ====================

const windowStart = ref(0)
const windowEnd = ref(0)
/** 顶/底区段和：topSum = Σ eff([0, start))，bottomSum = Σ eff([end, N)) */
const topSum = ref(0)
const bottomSum = ref(0)

const visibleItems = computed<FeedMessageItem[]>(() => items.value.slice(windowStart.value, windowEnd.value))

/** 窗口平移：仅对移动的 d 条增减区段和（高度更新只发生在挂载区条目，不触碰区段和） */
const moveWindow = (newStart: number, newEnd: number): void => {
  const N = items.value.length
  newStart = Math.max(0, Math.min(newStart, N))
  newEnd = Math.max(newStart, Math.min(newEnd, N))
  if (newStart < windowStart.value) {
    for (let i = newStart; i < windowStart.value; i++) topSum.value -= eff(i)
  } else if (newStart > windowStart.value) {
    for (let i = windowStart.value; i < newStart; i++) topSum.value += eff(i)
  }
  if (newEnd > windowEnd.value) {
    for (let i = windowEnd.value; i < newEnd; i++) bottomSum.value -= eff(i)
  } else if (newEnd < windowEnd.value) {
    for (let i = newEnd; i < windowEnd.value; i++) bottomSum.value += eff(i)
  }
  windowStart.value = newStart
  windowEnd.value = newEnd
}

/** 追加越窗条目的区段和入账（sync watch：在 onStructural/渲染之前维护基准） */
let lastLen = 0
watch(
  () => items.value.length,
  (newLen) => {
    if (newLen > lastLen) {
      for (let i = lastLen; i < newLen; i++) {
        if (i >= windowEnd.value) bottomSum.value += eff(i)
      }
    }
    lastLen = newLen
  },
  { flush: 'sync' }
)

// ==================== 定位原语：anchorTo / capture ====================

const pinned = ref(true)
/** anchorTo 两阶段期间抑制滚动驱动的窗口重算（防估算-实测间抖动） */
let suppress = false
/** 回填期标志：抑制逐条结构性锚定（回填循环整体结束后由微任务统一恢复） */
let refilling = false
/** 上向扩展的锚点保持（变更前记录，挂载后按 rect 差值补偿） */
let pendingAnchor: { el: HTMLElement; top: number } | null = null

/** 捕获当前位置：挂载条目中找含视口顶者；视口顶暂落 spacer 区时钳制到窗口首条 */
const capture = (): { index: number; ratio: number } | null => {
  const el = messagesContainer.value
  if (!el) return null
  const viewportTop = el.getBoundingClientRect().top
  for (let i = windowStart.value; i < windowEnd.value; i++) {
    const node = indexEls.get(i)
    if (!node) continue
    const r = node.getBoundingClientRect()
    if (r.bottom > viewportTop + 0.5) {
      return { index: i, ratio: Math.max(0, Math.min(1, (viewportTop - r.top) / (r.height || 1))) }
    }
  }
  if (windowStart.value < windowEnd.value) return { index: windowStart.value, ratio: 0 }
  return null
}

/**
 * 粘底意图判定——意图只由真实用户行为改变，流式增长不得误熄。
 * 滚动事件仅三来源：用户操作 / 本组件赋值 / 内容收缩钳制。区分：
 * 我们的赋值与内容增长都不会让 scrollTop 下降；用户上滚必然下降且远离底部；
 * 钳制下降但精确落底（距离≈0 走重燃分支）。曾在 flush 赋值与其事件派发之间
 * 夹进一帧增长（δ≥阈值）导致误熄且永无重评——流式内容从此在视口下增长的死循环即此。
 */
const NEAR_BOTTOM_PX = 40
const AWAY_PX = 40
let lastSeenTop = -1

const onScrollGeometry = (): void => {
  const c = messagesContainer.value
  if (!c) return
  const distance = c.scrollHeight - c.scrollTop - c.clientHeight
  if (lastSeenTop >= 0 && c.scrollTop < lastSeenTop - 4 && distance >= AWAY_PX) {
    pinned.value = false // 真实上滚脱离底部
  } else if (distance < NEAR_BOTTOM_PX) {
    pinned.value = true // 到底（含钳制落底）重燃跟随
  }
  lastSeenTop = c.scrollTop
}

/** 程序定位上下文（anchorTo/anchorToEnd 后）：直接按几何落定意图 */
const setPinnedByGeometry = (): void => {
  const c = messagesContainer.value
  if (!c) return
  pinned.value = c.scrollHeight - c.scrollTop - c.clientHeight < NEAR_BOTTOM_PX
  lastSeenTop = c.scrollTop
}

/** 定位原语：围绕目标索引建窗（高度表估算）→ nextTick → 以锚点元素真实位置精确定 scrollTop */
const anchorTo = async (index: number, ratio: number): Promise<void> => {
  const el = messagesContainer.value
  const N = items.value.length
  if (!el || N === 0) {
    moveWindow(0, 0)
    return
  }
  suppress = true
  try {
    index = Math.max(0, Math.min(index, N - 1))
    // Phase 1：建窗（锚点上方 ~1 屏、下方 ~2 屏；估算误差只影响内容映射，不影响锚点精度）
    const per = itemsPerScreen()
    moveWindow(Math.max(0, index - per), Math.min(N, index + 2 * per))
    await nextTick()
    // Phase 2：以真实 DOM 位置精确定位（顶 spacer 是真实元素，锚点 offsetTop 精确）
    const target = indexEls.get(index)
    if (target) {
      const containerTop = el.getBoundingClientRect().top
      const r = target.getBoundingClientRect()
      // scrollTop 增加 X → 内容上移 X：先对齐元素顶到视口顶，再下放 ratio*h
      el.scrollTop = r.top - containerTop + el.scrollTop - ratio * r.height
    }
    setPinnedByGeometry()
  } finally {
    suppress = false
  }
  await nextTick()
  sweep()
}

const anchorToEnd = async (): Promise<void> => {
  const N = items.value.length
  if (N === 0) return
  await anchorTo(N - 1, 1)
  const el = messagesContainer.value
  if (el) el.scrollTop = el.scrollHeight
  setPinnedByGeometry()
}

const backToBottom = (): void => {
  void anchorToEnd()
}

const showBackToBottom = computed(() => !pinned.value && feed.hasMessages.value)

// ==================== 滞回窗口（覆盖同步 / 驱逐延迟） ====================

/**
 * 覆盖（同步）：只做扩展，决策全部基于真实 DOM 几何（scrollTop/scrollHeight/spacer）。
 * 不在同一过程做驱逐：扩展对余量的影响此刻只能按估算记账（真实高度要等挂载），
 * 驱逐若信任该估算会与扩展互搏（估高 → 扩了就驱 → 窗口顶不动 → 永远翻不上去）。
 */
const coverViewport = (): void => {
  const el = messagesContainer.value
  if (!el) return
  const N = items.value.length
  const vh = el.clientHeight
  if (N === 0 || vh === 0) return
  const overscan = OVERSCAN_SCREENS * vh
  let changed = false

  // 上向扩展：视口顶距窗口上界的挂载余量不足 2 屏（或落入 spacer——从边沿逐屏扩展，被漂移量所界）
  while (windowStart.value > 0) {
    if (el.scrollTop - topSum.value >= overscan) break
    if (!pendingAnchor) {
      const anchor = indexEls.get(windowStart.value)
      if (anchor) pendingAnchor = { el: anchor, top: anchor.getBoundingClientRect().top }
    }
    moveWindow(Math.max(0, windowStart.value - itemsPerScreen()), windowEnd.value)
    changed = true
  }

  // 下向扩展：窗口下界（真实 scrollHeight - bottomSum）距视口底不足 2 屏
  while (windowEnd.value < N) {
    if (el.scrollHeight - bottomSum.value - (el.scrollTop + vh) >= overscan) break
    moveWindow(windowStart.value, Math.min(N, windowEnd.value + itemsPerScreen()))
    changed = true
  }

  if (changed || pendingAnchor) {
    void nextTick(() => {
      // 锚点保持：上向扩展改变视口上方内容 → 按锚点元素 rect 差值补偿（实测差值覆盖估算误差与标记条高度）
      if (pendingAnchor) {
        const { el: anchorEl, top } = pendingAnchor
        pendingAnchor = null
        const delta = anchorEl.getBoundingClientRect().top - top
        if (delta && messagesContainer.value) messagesContainer.value.scrollTop += delta
      }
      trimWindow()
      sweep()
    })
  }
}

/**
 * 驱逐（延迟至 patch+补偿后）：此刻余量与边界高度皆是真实值——
 * 被逐条目必在挂载区，直接量 rect；spacer 增量 == 移除的真实高度 →
 * 文档总高不变 → 驱逐对视口完全不可见，无需锚点补偿。
 */
const trimWindow = (): void => {
  const el = messagesContainer.value
  if (!el) return
  const vh = el.clientHeight
  if (!vh) return
  const evictLine = EVICT_SCREENS * vh

  // 上向驱逐：驱逐后余量仍 ≥3 屏才驱（保护区恒大于视口）
  while (windowEnd.value - windowStart.value > 1) {
    const node = indexEls.get(windowStart.value)
    if (!node) break // 边界元素缺失属异常：宁可暂缓驱逐
    const hReal = node.getBoundingClientRect().height
    heights[windowStart.value] = hReal // 账本对齐（RO 即使未送达也随后写入同值）
    if (el.scrollTop - topSum.value - (hReal + GAP) < evictLine) break
    moveWindow(windowStart.value + 1, windowEnd.value)
  }

  // 下向驱逐
  while (windowEnd.value - windowStart.value > 1) {
    const node = indexEls.get(windowEnd.value - 1)
    if (!node) break
    const hReal = node.getBoundingClientRect().height
    heights[windowEnd.value - 1] = hReal
    if (el.scrollHeight - bottomSum.value - (hReal + GAP) - (el.scrollTop + vh) < evictLine) break
    moveWindow(windowStart.value, windowEnd.value - 1)
  }
}

const handleScroll = (): void => {
  onScrollGeometry()
  if (suppress || refilling) return
  coverViewport()
}

// ==================== 会话位置记忆 + clearMessages 包装 ====================

/** 每会话浏览位置（内存级；索引对只追加流天然稳定，比例容忍重排） */
const sessionMemory = new Map<string, { index: number; ratio: number }>()
/** 上一回填周期的会话 id（clear 时引擎 id 已切到新会话，存键必须用它） */
let lastSessionId: string | null = null

const clearMessages = (): void => {
  // 存旧会话位置（此刻窗口尚未重置，capture 读的是旧内容）
  if (lastSessionId) {
    const pos = capture()
    if (pos) sessionMemory.set(lastSessionId, pos)
  }
  // 同步重置窗口与高度表（防 Vue flush 对新数组渲染垃圾切片）
  windowStart.value = 0
  windowEnd.value = 0
  heights = []
  measuredSum = 0
  measuredCount = 0
  topSum.value = 0
  bottomSum.value = 0
  lastLen = 0
  lastSeenTop = -1
  const el = messagesContainer.value
  if (el) el.scrollTop = 0
  feed.clearMessages()
  refilling = true
  queueMicrotask(() => {
    refilling = false
    const sid = feed.currentSessionId()
    lastSessionId = sid
    const N = items.value.length
    if (N === 0) return
    const mem = sid ? sessionMemory.get(sid) : undefined
    if (mem) {
      void anchorTo(Math.min(mem.index, N - 1), mem.ratio)
    } else {
      void anchorToEnd()
    }
  })
}

// ==================== feed 回调接线 ====================

// 流式 flush：仅粘底时置底（尾窗恒含末条——粘底语义保证）；微任务里 pinned 由意图判定
// 保持稳定（滚动事件是任务，不会插进本微任务链），无需也不应在此重查几何
feed.setOnFlush(() => {
  if (!pinned.value) return
  if (windowEnd.value < items.value.length) {
    moveWindow(windowStart.value, items.value.length)
  }
  void nextTick(() => {
    const c = messagesContainer.value
    if (c) c.scrollTop = c.scrollHeight
  })
})

// 结构性追加：USER 必见最新（无条件锚定末尾）；其余仅在粘底时跟随，未粘底不扰动阅读
feed.setOnStructural(({ role }) => {
  if (refilling) return
  if (role === MessageRole.USER || pinned.value) void anchorToEnd()
})

// ==================== 生命周期 ====================

let containerRO: ResizeObserver | null = null
let lastContainerWidth = 0

onMounted(() => {
  // TaskListStore 事件监听器（保持既有接线；3.3 过滤注入——按 active 会话过滤 TASK_*）
  taskListStore.setupEventListeners(getActiveSessionId)

  const el = messagesContainer.value
  if (!el) return
  GAP = parseFloat(getComputedStyle(el).gap) || 12
  lastContainerWidth = el.getBoundingClientRect().width
  pinned.value = true

  // 容器宽度变化 → 高度表整体失效（capture → 清表 → 按锚点重定位重测；竖向变化不清）
  containerRO = new ResizeObserver((entries) => {
    const e = entries[0]
    const w = e.borderBoxSize?.[0]?.inlineSize ?? e.contentRect.width
    if (!lastContainerWidth) {
      lastContainerWidth = w
      return
    }
    if (Math.abs(w - lastContainerWidth) <= 1) return
    lastContainerWidth = w
    const pos = capture()
    heights = []
    measuredSum = 0
    measuredCount = 0
    // 区段和按新估算重派生（宽度变化罕见，O(N) 一次可接受）
    topSum.value = 0
    for (let i = 0; i < windowStart.value; i++) topSum.value += eff(i)
    bottomSum.value = 0
    for (let i = windowEnd.value; i < items.value.length; i++) bottomSum.value += eff(i)
    if (pos) void anchorTo(pos.index, pos.ratio)
  })
  containerRO.observe(el)

  if (items.value.length > 0) void anchorToEnd()
})

onUnmounted(() => {
  taskListStore.teardownEventListeners()
  itemRO?.disconnect()
  itemRO = null
  containerRO?.disconnect()
  containerRO = null
  observedEls.clear()
  indexEls.clear()
})

// ==================== 对 Home 的门面（签名与语义不变） ====================

const hasMessages = computed(() => feed.hasMessages.value)

defineExpose({
  addMessage: feed.addMessage,
  updateLastMessage: feed.updateLastMessage,
  updateLastOutput: feed.updateLastOutput,
  updateToolCallStatus: feed.updateToolCallStatus,
  clearMessages, // 包装版：位置记忆 + 窗口几何随锚点重建（Home 无感知）
  markConversationComplete: feed.markConversationComplete,
  refreshCompactions: feed.refreshCompactions, // 压缩完成后由 Home 显式触发（标记条经 compactions 镜像响应式出现）
  hasMessages, // 空会话判定（响应式，Home 居中输入框布局的开关）
})
</script>

<style scoped>
.chat-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  /* 回到底部按钮的定位基准 */
  position: relative;
  /* 让ChatArea更像父容器的一部分 */
  background-color: transparent;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  /* 设计契约：消息列永不横滚（宽内容各有内部滚动：CodeBlock/table/pre）——
     overflow-y:auto 会把 overflow-x 计算值带成 auto，必须显式 clip，
     否则任何 1px 级子元素溢出都会冒出整列横向滚动条 */
  overflow-x: clip;
  /* 移除内边距，让内容完全占据整个区域 */
  padding: var(--spacing-4) var(--spacing-4);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
  /* 消息列限宽居中（~768px），提升长文可读性 */
  align-items: center;
  /* 原生滚动锚定与锚点纪律的 rect 补偿是竞争机制（叠加会过度补偿），显式关闭 */
  overflow-anchor: none;
}

/* 消息列限宽居中（~768px）；作用于直接子元素（消息项根/标记条） */
.chat-messages > *:not(.back-to-bottom) {
  width: 100%;
  max-width: 768px;
}

/* 占位：仅高度有效（吃到的 width/gap 规则无效能） */
.window-spacer {
  flex-shrink: 0;
}

/* hook 系统提示卡片：提示行样式 + 右侧关闭按钮（HOOK_MESSAGE 事件驱动） */
.synthetic-notice {
  margin-left: var(--spacing-4);
  /* 缩进内扣（width:100% 来自 .chat-messages > *，不扣会使 margin-box 溢出 16px） */
  max-width: calc(100% - var(--spacing-4));
  padding: var(--spacing-1) var(--spacing-3);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  opacity: 0.75;
  user-select: none;
}

.synthetic-landing {
  white-space: pre-wrap;
  user-select: text;
}

.hook-notice {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-2);
  opacity: 0.9;
}

.hook-notice-text {
  flex: 1;
}

.hook-notice-close {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  line-height: 1;
  padding: 0 var(--spacing-1);
}

.hook-notice-close:hover {
  color: var(--text-primary);
}

/* 回到底部：容器右下悬浮（非粘底时出现） */
.back-to-bottom {
  position: absolute;
  right: var(--spacing-4);
  bottom: var(--spacing-4);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--border-color, #e0e0e0);
  background: var(--bg-secondary, #fff);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  transition: color var(--transition-fast), transform var(--transition-fast);
  z-index: 5;
}

.back-to-bottom svg {
  width: 18px;
  height: 18px;
}

.back-to-bottom:hover {
  color: var(--primary-color);
  transform: translateY(-1px);
}

.back-to-bottom-fade-enter-active,
.back-to-bottom-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.back-to-bottom-fade-enter-from,
.back-to-bottom-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

/* 响应式调整 */
@media (max-width: 768px) {
  .chat-messages {
    padding: var(--spacing-3);
    gap: var(--spacing-3);
  }
}

@media (max-width: 480px) {
  .chat-messages {
    padding: var(--spacing-2);
    gap: var(--spacing-2);
  }
}
</style>
