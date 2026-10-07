<template>
  <div class="context-ring-container">
    <template v-if="ratio !== null">
      <svg class="context-ring" :class="{ 'context-ring-warn': isHighPressure }" viewBox="0 0 24 24">
        <circle class="context-ring-track" cx="12" cy="12" :r="R" />
        <circle
          class="context-ring-progress"
          cx="12"
          cy="12"
          :r="R"
          :stroke-dasharray="`${progressLength} ${CIRCUMFERENCE}`"
        />
      </svg>
      <!-- 悬停详情（含「立即压缩」动作，指示与动作同位）：纯 CSS 实现——
           :hover 即显；visibility 过渡延迟 300ms 才隐藏（行业 hover card 的关闭延时配方），
           鼠标穿过缝隙/抖动到达按钮的窗口期面板不消失；重新进入悬停区延迟取消，不闪 -->
      <div class="context-ring-tooltip">
        <div class="context-ring-tooltip-line">上下文 {{ usedText }}/{{ maxText }}（{{ ratioText }}）</div>
        <div class="context-ring-tooltip-hint">
          {{ isHighPressure ? '已超自动压缩阈值（80%），本轮结束将自动压缩' : '每轮 API 调用后更新' }}
        </div>
        <button class="context-ring-compact-btn" :disabled="isCompacting" @click="runCompact">
          {{ isCompacting ? '正在压缩…' : '立即压缩' }}
        </button>
      </div>
    </template>
    <!-- 压缩结果/输入区瞬态提示：独立于环的显隐（压缩后 lastUsage 重置、环隐藏，结果反馈仍须可见） -->
    <div v-if="compactToast.show" class="context-ring-toast" :class="compactToast.type">
      <span>{{ compactToast.message }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useContextStatusStore } from '../stores/contextStatusStore'
import { isCompacting, compactToast, runCompact } from '../composables/useCompact'

/** 上下文占用环（挂载于模型选择器左侧）：实测占用/窗口上限，数据源引擎 lastUsage。
 *  无实测（新会话/服务未返回 usage/压缩后未回报）或分母缺失时整体隐藏。
 *  占用超 80%（自动压缩阈值）转黄——与 CLI TUI statusline 同一口径。 */
const contextStatusStore = useContextStatusStore()

const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const usedText = computed(() => {
  if (contextStatusStore.usedTokens === null) return ''
  const prefix = contextStatusStore.usedTokensApprox ? '约 ' : ''
  return prefix + fmt(contextStatusStore.usedTokens)
})
const maxText = computed(() => (contextStatusStore.maxContextTokens !== null ? fmt(contextStatusStore.maxContextTokens) : ''))

/** 占用率（null = 无数据，组件隐藏） */
const ratio = computed(() => {
  const used = contextStatusStore.usedTokens
  const max = contextStatusStore.maxContextTokens
  return used !== null && max ? Math.min(1, used / max) : null
})
const ratioText = computed(() => (ratio.value !== null ? `${Math.round(ratio.value * 100)}%` : ''))
const isHighPressure = computed(() => ratio.value !== null && ratio.value > 0.8)

// 环形进度几何：半径 9、周长 ≈ 56.55，dasharray 前段为已占用弧长
const R = 9
const CIRCUMFERENCE = 2 * Math.PI * R
const progressLength = computed(() => (ratio.value !== null ? CIRCUMFERENCE * ratio.value : 0))
</script>

<style scoped>
.context-ring-container {
  position: relative;
  display: flex;
  align-items: center;
}

.context-ring {
  width: 20px;
  height: 20px;
  transform: rotate(-90deg); /* 进度从 12 点方向起 */
}

.context-ring-track {
  fill: none;
  stroke: var(--border-color, #e2e8f0);
  stroke-width: 2.5;
}

.context-ring-progress {
  fill: none;
  stroke: var(--primary-color, #2563eb);
  stroke-width: 2.5;
  stroke-linecap: round;
  transition: stroke-dasharray 0.3s ease;
}

.context-ring-warn .context-ring-progress {
  stroke: #eab308;
}

/* 悬停详情：默认隐藏；visibility 过渡延迟是关闭延时的纯 CSS 形态（见模板注释） */
.context-ring-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  padding: 6px 10px;
  background: var(--background-primary, #fff);
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  white-space: nowrap;
  z-index: 100;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.15s ease, visibility 0s linear 0.3s;
}

.context-ring-container:hover .context-ring-tooltip {
  visibility: visible;
  opacity: 1;
  transition: opacity 0.15s ease, visibility 0s;
}

.context-ring-tooltip-line {
  font-size: 12px;
  color: var(--text-primary);
}

.context-ring-tooltip-hint {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}

/* 「立即压缩」动作（悬停详情内） */
.context-ring-compact-btn {
  margin-top: 6px;
  padding: 3px 10px;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 5px;
  background: transparent;
  color: var(--primary-color, #2563eb);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.context-ring-compact-btn:hover:not(:disabled) {
  background: rgba(37, 99, 235, 0.08);
}

.context-ring-compact-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 结果/提示 toast（独立于环显隐，定位在环上方）；
   width: max-content 防塌缩——容器只有环宽（~24px），absolute + right:0 的 shrink-to-fit
   会被容器宽度压成一列竖排字（实证），max-content 让其按内容自然宽度向左伸展 */
.context-ring-toast {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: max-content;
  max-width: min(360px, 80vw);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  z-index: 101;
  animation: slideUp 0.2s ease-out;
}

.context-ring-toast.success {
  background-color: rgba(34, 197, 94, 0.1);
  color: #166534;
  border: 1px solid rgba(34, 197, 94, 0.35);
}

.context-ring-toast.error {
  background-color: #fef2f2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}

.context-ring-toast.info {
  background-color: rgba(37, 99, 235, 0.08);
  color: #1d4ed8;
  border: 1px solid rgba(37, 99, 235, 0.35);
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
