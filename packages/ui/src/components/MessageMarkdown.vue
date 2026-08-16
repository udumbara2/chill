<template>
  <div class="markdown-content" :class="{ 'is-loading': loading }">
    <!-- 按块渲染：闭合块 props 永不变 → 跳过更新；开放块（流式尾块）随内容增长重渲染 -->
    <template v-for="seg in displaySegments" :key="seg.id">
      <MarkdownSegment v-if="seg.type === 'text'" :content="seg.content" />
      <CodeBlock
        v-else
        :code="seg.content"
        :language="seg.language"
        :is-streaming="seg.open"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { shallowRef, watch, onMounted } from 'vue'
import CodeBlock from './CodeBlock.vue'
import MarkdownSegment from './MarkdownSegment.vue'
import {
  StreamSegmenter,
  filterLinkTags,
  IncrementalReasoningNormalizer,
  tryUnwrapReasoningJson,
  type DisplaySegment,
} from '../utils/streamSegmenter'

/**
 * 流式 markdown 渲染组件（渲染架构 L4 入口）。
 *
 * props 契约不变（content / loading / isStreaming；新增 reasoning 标记思考内容），
 * 共用方（DocumentLightView / ResultPanel / 压缩摘要 / MessageItem）零改动。
 *
 * 内部管线（每拍代价 O(新增 + 尾块)，与全文长度无关）：
 * - 文本：原始内容直接增量分段（行对齐块级；空行+非延续前瞻冻结——CommonMark 宽松列表正确）；
 * - reasoning：JSON 候选整段缓冲一次解包 + 增量转义还原（仅思考内容，正文/代码原文直通）；
 * - `<link>` 过滤作用于全部内容（安全项）：闭合块缓存一次，开放块每拍过滤（有界）。
 *
 * 有意修复的旧管线缺陷（记录为对拍预期差异）：空行被无条件删除导致段落合并 <br>、
 * 代码块内空行丢失、正文里字面 \n 序列被改写、行尾空格（两空格硬换行）被 trimEnd。
 */
interface Props {
  content: string
  loading?: boolean
  isStreaming?: boolean
  /** 思考内容：启用 JSON 解包与转义还原（其原始用途；正文与代码不做规范化） */
  reasoning?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  isStreaming: false,
  reasoning: false,
})

const segmenter = new StreamSegmenter()
const normalizer = new IncrementalReasoningNormalizer()
/** 展示分段快照（每次内容增长后重建；闭合段 props 字符串值相等 → 子组件跳过更新） */
const displaySegments = shallowRef<DisplaySegment[]>([])
/** 已喂入 props.content 的字符数（增量 push 依据） */
let consumed = 0
/** 前一拍内容（前缀校验：内容被整体替换时全量重建） */
let prevContent = ''
/** reasoning JSON 候选缓冲（{ 开头的思考内容整段缓冲，闭合一次解包） */
let jsonHold: string | null = null
/** 是否已喂过任何内容（JSON 候选只在首拍判定） */
let fedAny = false
/** 闭合块的 <link> 过滤缓存（按段 id，只过滤一次） */
const filteredCache = new Map<string, string>()

const refreshView = (): void => {
  displaySegments.value = segmenter.view().map((seg) => {
    if (seg.open) {
      // 开放块每拍过滤（O(尾块)，有界）
      return { ...seg, content: filterLinkTags(seg.content) }
    }
    let cached = filteredCache.get(seg.id)
    if (cached === undefined) {
      cached = filterLinkTags(seg.content)
      filteredCache.set(seg.id, cached)
    }
    return { ...seg, content: cached }
  })
}

/** 规范化后的文本进入分段器 */
const feedSegmenter = (text: string): void => {
  if (!text) return
  segmenter.push(text)
  refreshView()
}

const handleContent = (content: string): void => {
  if (!content) {
    return
  }

  // 内容整体替换（非追加）：全量重建管线
  if (consumed > 0 && !content.startsWith(prevContent)) {
    rebuild()
  }

  const suffix = content.slice(consumed)
  consumed = content.length
  prevContent = content
  if (!suffix) return

  if (!props.reasoning) {
    fedAny = true
    feedSegmenter(suffix)
    return
  }

  // reasoning：JSON 候选整段缓冲（首拍且 { 开头），闭合一次解包；否则增量转义还原
  if (jsonHold !== null) {
    jsonHold += suffix
    const unwrapped = tryUnwrapReasoningJson(jsonHold)
    if (unwrapped) {
      jsonHold = null
      normalizer.reset()
      fedAny = true
      feedSegmenter(normalizer.push(unwrapped.text))
    }
    return
  }
  if (!fedAny && content.trimStart().startsWith('{')) {
    // 首拍且 { 开头：进入 JSON 候选缓冲（中间态不闪现原始 JSON）
    jsonHold = content
    const unwrapped = tryUnwrapReasoningJson(jsonHold)
    if (unwrapped) {
      jsonHold = null
      fedAny = true
      feedSegmenter(normalizer.push(unwrapped.text))
    } else {
      refreshView()
    }
    return
  }
  fedAny = true
  feedSegmenter(normalizer.push(suffix))
}

/** 全量重建（内容被替换 / 组件复用切换数据源） */
const rebuild = (): void => {
  segmenter.finalize() // 旧实例丢弃前闭合（无副作用，仅为语义完整）
  consumed = 0
  prevContent = ''
  jsonHold = null
  fedAny = false
  normalizer.reset()
  filteredCache.clear()
  displaySegments.value = []
}

/** 流结束：JSON 候选兜底解包（失败按原文走）、转义回持冲刷、半行提交、全部冻结 */
const finalize = (): void => {
  if (jsonHold !== null) {
    const held = jsonHold
    jsonHold = null
    const unwrapped = tryUnwrapReasoningJson(held)
    if (unwrapped) {
      normalizer.reset()
      feedSegmenter(normalizer.push(unwrapped.text))
    } else {
      feedSegmenter(normalizer.push(held))
    }
  }
  feedSegmenter(normalizer.flushTail())
  segmenter.finalize()
  refreshView()
}

// 静态全文（共用方）：挂载即单趟完成（isStreaming=false → finalize）
onMounted(() => {
  handleContent(props.content)
  if (!props.isStreaming) finalize()
})

watch(
  () => props.content,
  (content) => handleContent(content ?? '')
)

watch(
  () => props.isStreaming,
  (streaming) => {
    if (!streaming) finalize()
  }
)
</script>

<style scoped>
.markdown-content {
  line-height: 1.4;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.markdown-content :deep(p) {
  margin: 0.3rem 0;
}

.markdown-content :deep(blockquote) {
  border-left: 4px solid #ddd;
  margin: 1rem 0;
  padding: 0.5rem 1rem;
  color: #666;
  background: rgba(0, 0, 0, 0.02);
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin: 1.5rem 0 1rem 0;
  font-weight: 600;
  line-height: 1.25;
}

.markdown-content :deep(h1) { font-size: 2rem; }
.markdown-content :deep(h2) { font-size: 1.75rem; }
.markdown-content :deep(h3) { font-size: 1.5rem; }
.markdown-content :deep(h4) { font-size: 1.25rem; }
.markdown-content :deep(h5) { font-size: 1.1rem; }
.markdown-content :deep(h6) { font-size: 1rem; }

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.5rem 0;
  padding-left: 1.5rem;
}

.markdown-content :deep(li) {
  margin: 0.25rem 0;
}

.markdown-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0;
  overflow-x: auto;
  display: block;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid #ddd;
  padding: 0.5rem;
  text-align: left;
}

.markdown-content :deep(th) {
  background-color: #f5f5f5;
  font-weight: 600;
}

.markdown-content :deep(a) {
  color: #007acc;
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(hr) {
  border: none;
  border-top: 2px solid #e0e0e0;
  margin: 2rem 0;
}

.markdown-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 0.5rem;
  margin: 0.5rem 0;
}

/* 数学公式样式 */
.markdown-content :deep(.katex) {
  font-size: 1.1em;
}

.markdown-content :deep(.katex-display) {
  margin: 1rem 0;
  text-align: center;
}

/* 任务列表样式 */
.markdown-content :deep(.task-list-item) {
  list-style: none;
  margin-left: -1.5rem;
}

.markdown-content :deep(.task-list-item-checkbox) {
  margin-right: 0.5rem;
}

/* 锚点样式 */
.markdown-content :deep(.header-anchor) {
  opacity: 0;
  text-decoration: none;
  margin-left: 0.5rem;
  color: #999;
}

.markdown-content :deep(h1:hover .header-anchor),
.markdown-content :deep(h2:hover .header-anchor),
.markdown-content :deep(h3:hover .header-anchor),
.markdown-content :deep(h4:hover .header-anchor) {
  opacity: 1;
}

/* 加载状态 */
.markdown-content.is-loading {
  opacity: 0.7;
}

/* 强调样式 */
.markdown-content :deep(strong) {
  font-weight: 600;
}

.markdown-content :deep(em) {
  font-style: italic;
}

.markdown-content :deep(del) {
  text-decoration: line-through;
  color: #999;
}

.markdown-content :deep(u) {
  text-decoration: underline;
}
</style>
