<template>
  <div class="compaction-marker">
    <!-- 分割线（点击展开/折叠压缩摘要）：左右横线 + 中间文案 -->
    <div class="compaction-divider" @click="expanded = !expanded" title="点击展开/折叠压缩摘要">
      <span class="compaction-line"></span>
      <svg class="compaction-icon" :class="{ expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"></polyline>
      </svg>
      <span class="compaction-text">上下文已压缩{{ statsText }}</span>
      <span class="compaction-time">{{ timeText }}</span>
      <span class="compaction-line"></span>
    </div>
    <div v-show="expanded" class="compaction-summary">
      <MessageMarkdown :content="cp.summary" :loading="false" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import MessageMarkdown from './MessageMarkdown.vue'
import type { CompactionCheckpoint } from '../composables/useChatFeed'

/**
 * 压缩分割线（上下文压缩显示约定）：checkpoint 派生的唯一可见留痕（手动/自动/溢出三触发同面）。
 * 统计数字读 checkpoint 持久化字段（compactCore 唯一计算点），旧 checkpoint 无字段时只显示基础文案。
 */
const props = defineProps<{ cp: CompactionCheckpoint }>()

const expanded = ref(false)

/** token 简写（去尾零，与 CLI fmtTokens 同口径：151k 而非 151.0k） */
const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n))

const statsText = computed(() => {
  const before = props.cp.usageBeforeTokens
  const after = props.cp.usageAfterApproxTokens
  if (before && after) {
    const freed = Math.max(0, Math.round((1 - after / before) * 100))
    return ` · ${fmtTokens(before)} → 约 ${fmtTokens(after)}（已释放 ${freed}%）`
  }
  if (after) return ` · 约 ${fmtTokens(after)}`
  return ''
})

const timeText = computed(() =>
  new Date(props.cp.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
)
</script>

<style scoped>
.compaction-marker {
  margin: 0.25rem 0;
  user-select: none;
}

.compaction-divider {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  padding: 0.125rem 0;
}

.compaction-line {
  flex: 1;
  height: 1px;
  background: var(--border-color, #e5e7eb);
}

.compaction-icon {
  width: 14px;
  height: 14px;
  color: #9ca3af;
  flex-shrink: 0;
  transition: transform 0.2s ease;
}

.compaction-icon.expanded {
  transform: rotate(90deg);
}

.compaction-text {
  font-size: 0.8125rem;
  color: #9ca3af;
  flex-shrink: 0;
}

.compaction-time {
  font-size: 0.75rem;
  color: #c4c9d1;
  flex-shrink: 0;
}

/* 展开的压缩摘要：限高独立滚动，与思考内容区同款 */
.compaction-summary {
  max-height: 300px;
  overflow-y: auto;
  padding: 0.375rem 0.5rem;
  margin: 0.25rem 0;
  border-left: 2px solid rgba(156, 163, 175, 0.35);
  color: #6b7280;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.compaction-summary::-webkit-scrollbar {
  display: none;
}
</style>
