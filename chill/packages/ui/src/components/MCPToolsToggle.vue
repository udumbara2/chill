<template>
  <div class="mcp-tools-toggle" :class="{ 'enabled': isEnabled }">
    <div class="toggle-switch" @click="toggle">
      <div class="toggle-slider" :class="{ 'enabled': isEnabled }"></div>
    </div>
    <div class="toggle-label" :class="{ 'enabled': isEnabled }">
      {{ isEnabled ? 'MCP服务器' : 'MCP服务器' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMCPStore } from '../stores/mcpStore'

const mcpStore = useMCPStore()

const isEnabled = computed(() => mcpStore.isMCPToolsEnabled)

const toggle = () => {
  mcpStore.toggleMCPTools()
}
</script>

<style scoped>
.mcp-tools-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.mcp-tools-toggle:hover {
  background-color: var(--background-secondary, rgba(0,0,0,0.05));
}

.toggle-switch {
  width: 40px;
  height: 20px;
  background-color: var(--vscode-button-secondaryBackground, #e0e0e0);
  border-radius: 10px;
  position: relative;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

.mcp-tools-toggle.enabled .toggle-switch {
  background-color: #007acc;
}

.toggle-slider {
  width: 16px;
  height: 16px;
  background-color: white;
  border-radius: 50%;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.3s ease;
  box-shadow: 0 1px 3px rgba(0,0,0,0.3);
}

.mcp-tools-toggle.enabled .toggle-slider {
  transform: translateX(20px);
}

.toggle-label {
  font-size: 12px;
  color: var(--text-secondary, #666);
  font-weight: 500;
  transition: color 0.3s ease;
  min-width: 50px;
}

.mcp-tools-toggle.enabled .toggle-label {
  color: #007acc;
}

/* 响应式调整 */
@media (max-width: 768px) {
  .toggle-switch {
    width: 36px;
    height: 18px;
  }
  
  .mcp-tools-toggle.enabled .toggle-slider {
    transform: translateX(18px);
  }
  
  .toggle-slider {
    width: 14px;
    height: 14px;
    top: 2px;
    left: 2px;
  }
  
  .toggle-label {
    font-size: 11px;
    min-width: 45px;
  }
}
</style>