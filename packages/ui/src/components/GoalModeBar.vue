<template>
  <div v-if="goalModeStore.isGoalMode" class="goal-mode-container">
    <div class="goal-mode-bar">
      <span class="goal-mode-text" :title="goalModeStore.objective">
        目标模式 · 第 {{ goalModeStore.roundCount }}/{{ goalModeStore.maxRounds }} 轮{{ goalModeStore.status === 'paused' ? '（已暂停）' : '' }}：{{ truncatedObjective }}
      </span>
      <div class="goal-mode-actions">
        <button
          v-if="goalModeStore.status === 'active'"
          class="goal-mode-btn"
          @click="goalModeStore.pauseGoal()"
          title="暂停目标推进（/goal resume 恢复）"
        >
          暂停
        </button>
        <button
          v-else
          class="goal-mode-btn"
          @click="goalModeStore.resumeGoal()"
          title="恢复目标推进"
        >
          恢复
        </button>
        <button class="goal-mode-btn" @click="goalModeStore.clearGoal()" title="放弃目标并退出目标模式">
          退出
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useGoalModeStore } from '../stores/goalModeStore'

const goalModeStore = useGoalModeStore()

// 栏内单行展示：长目标截断，全文在 title 悬浮可见
const truncatedObjective = computed(() => {
  const text = goalModeStore.objective
  return text.length > 40 ? text.slice(0, 40) + '…' : text
})
</script>

<style scoped>
.goal-mode-container {
  margin-bottom: 0.5rem;
}

.goal-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%);
  border: 1px solid #4ade80;
  border-radius: 6px;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.goal-mode-text {
  font-size: 0.8125rem;
  color: #166534;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-mode-actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}

.goal-mode-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid #4ade80;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  background: transparent;
  color: #166534;
  transition: all 0.2s ease;
}

.goal-mode-btn:hover {
  background: rgba(34, 197, 94, 0.1);
}
</style>
