<template>
  <div class="permission-selector">
    <button
      class="permission-trigger"
      :class="`mode-${mode}`"
      @click.stop="toggleDropdown"
      :title="triggerTitle"
    >
      <svg v-if="mode === 'readonly'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      <svg v-else-if="mode === 'fullAccess'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
      <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      <span class="permission-label">{{ currentLabel }}</span>
    </button>

    <div v-if="isOpen" class="permission-dropdown">
      <div
        v-for="item in MODES"
        :key="item.value"
        class="permission-item"
        :class="{ selected: mode === item.value }"
        @click.stop="select(item.value)"
      >
        <div class="permission-item-name">{{ item.label }}</div>
        <div class="permission-item-hint">{{ item.hint }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { usePermissionModeStore } from '../stores/permissionModeStore'
import { usePlanModeStore } from '../stores/planModeStore'
import type { PermissionMode } from '@assistant-ai/core'

/** 权限三态选择器（只读 | 边界 | 直写）：互斥模式（radio 语义），状态源为 core executor 的
 *  permissionMode 单字段，本组件经 permissionModeStore 读写。与规划/目标按钮（工作流/驱动轴）
 *  同排分组，互不正交干扰。 */
const permissionModeStore = usePermissionModeStore()
const planModeStore = usePlanModeStore()

const MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: 'readonly', label: '只读', hint: '只能读取与讨论，修改性操作全部被拦截' },
  { value: 'boundary', label: '边界', hint: '工作区内直接写；越界写入与命令当场请你批准（默认）' },
  { value: 'fullAccess', label: '直写', hint: '任意路径直接写不问；危险命令与桌面操作仍会询问' },
]

const mode = computed(() => permissionModeStore.mode)
const currentLabel = computed(() => MODES.find(m => m.value === mode.value)?.label ?? '边界')

const triggerTitle = computed(() => {
  const base = `执行权限：${currentLabel.value}——${MODES.find(m => m.value === mode.value)?.hint ?? ''}`
  return planModeStore.isPlanMode && mode.value !== 'readonly'
    ? `${base}（规划模式激活中：修改性工具仍被规划闸门拦截，权限档在退出规划后生效）`
    : base
})

const isOpen = ref(false)
const toggleDropdown = () => {
  isOpen.value = !isOpen.value
}
const select = (m: PermissionMode) => {
  permissionModeStore.set(m)
  isOpen.value = false
}
const handleClickOutside = () => {
  isOpen.value = false
}

onMounted(() => {
  permissionModeStore.syncFromEngine()
  void permissionModeStore.syncGateFromHost() // Web 家目录降级对齐（desktop 空转）
  document.addEventListener('click', handleClickOutside)
})
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.permission-selector {
  position: relative;
  display: flex;
  align-items: center;
}

.permission-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.permission-trigger:hover {
  background: var(--background-secondary);
}

/* 非默认档高亮：只读灰蓝、直写紫（沿用既有 auto-apply 色系） */
.permission-trigger.mode-readonly {
  border-color: #94a3b8;
  color: #475569;
  background: rgba(148, 163, 184, 0.12);
}

.permission-trigger.mode-fullAccess {
  border-color: #a78bfa;
  color: #7c3aed;
  background: rgba(139, 92, 246, 0.12);
}

.permission-label {
  white-space: nowrap;
}

.permission-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  /* 左锚定：触发器在聊天列最左缘，右锚定会让下拉向左伸进侧边栏下方被盖住（实证） */
  left: 0;
  min-width: 220px;
  background: var(--background-primary, #fff);
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 100;
  padding: 4px;
}

.permission-item {
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.permission-item:hover {
  background: var(--background-secondary);
}

.permission-item.selected {
  background: rgba(37, 99, 235, 0.08);
}

.permission-item-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}

.permission-item-hint {
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-tertiary, #9ca3af);
}
</style>
