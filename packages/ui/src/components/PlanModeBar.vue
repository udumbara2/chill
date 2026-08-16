<template>
  <div v-if="planModeStore.isPlanMode" class="plan-mode-container">
    <div class="plan-mode-bar">
      <span class="plan-mode-text">规划模式中：修改性操作已被拦截，打磨规划后由你审阅</span>
      <button class="exit-plan-mode-btn" @click="handleExitPlanMode">
        退出规划模式
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePlanModeStore } from '../stores/planModeStore'

const planModeStore = usePlanModeStore()

// 退出只能由用户决定（与 core 侧约定一致）
const handleExitPlanMode = () => {
  planModeStore.setPlanMode(false)
}
</script>

<style scoped>
.plan-mode-container {
  margin-bottom: 0.5rem;
}

.plan-mode-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%);
  border: 1px solid #818cf8;
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

.plan-mode-text {
  font-size: 0.8125rem;
  color: #4338ca;
}

.exit-plan-mode-btn {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid #818cf8;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  background: transparent;
  color: #4338ca;
  transition: all 0.2s ease;
}

.exit-plan-mode-btn:hover {
  background: rgba(99, 102, 241, 0.1);
}
</style>
