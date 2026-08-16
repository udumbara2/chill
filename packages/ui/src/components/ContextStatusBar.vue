<template>
  <div v-if="ratioText !== null" class="context-status-container">
    <div class="context-status-bar" :class="{ 'context-status-warn': isHighPressure }">
      <span class="context-status-text" :title="titleText">上下文 {{ usedText }}/{{ maxText }}（{{ ratioText }}）</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useContextStatusStore } from '../stores/contextStatusStore'

/** 上下文余量条（对照 GoalModeBar 挂载模式）：实测占用/窗口上限，数据源引擎 lastUsage。
 *  无实测（新会话/服务未返回 usage/压缩后未回报）或分母缺失时整条隐藏。
 *  占用超 80%（自动压缩阈值）转黄提示——与 CLI TUI statusline 同一口径。 */
const contextStatusStore = useContextStatusStore()

const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const usedText = computed(() => (contextStatusStore.usedTokens !== null ? fmt(contextStatusStore.usedTokens) : ''))
const maxText = computed(() => (contextStatusStore.maxContextTokens !== null ? fmt(contextStatusStore.maxContextTokens) : ''))
const ratioText = computed(() => {
  const used = contextStatusStore.usedTokens
  const max = contextStatusStore.maxContextTokens
  if (used === null || !max) return null
  return `${Math.min(100, Math.round((used / max) * 100))}%`
})
/** 占用率（压力告警色判定；null = 无数据不判定） */
const usedRatio = computed(() => {
  const used = contextStatusStore.usedTokens
  const max = contextStatusStore.maxContextTokens
  return used !== null && max ? used / max : null
})
const isHighPressure = computed(() => usedRatio.value !== null && usedRatio.value > 0.8)
const titleText = computed(() =>
  isHighPressure.value
    ? '上下文占用已超自动压缩阈值（80%），本轮结束将自动压缩（/compact 手动压缩随时可用）'
    : '上下文实测占用（每轮 API 调用后更新；/compact 手动压缩随时可用）'
)
</script>

<style scoped>
.context-status-container {
  margin-bottom: 0.5rem;
}

.context-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 0.75rem;
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
}

.context-status-warn {
  background: #fef9c3;
  border-color: #facc15;
}

.context-status-text {
  font-size: 0.8rem;
  color: #475569;
}

.context-status-warn .context-status-text {
  color: #854d0e;
  font-weight: 600;
}
</style>
