import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useMCPStore = defineStore('mcp', () => {
  // MCP工具自动同步开关状态
  const isMCPToolsEnabled = ref<boolean>(true) // 默认开启
  
  // 切换开关状态
  const toggleMCPTools = () => {
    isMCPToolsEnabled.value = !isMCPToolsEnabled.value
    // 保存到localStorage
    localStorage.setItem('mcp-tools-enabled', JSON.stringify(isMCPToolsEnabled.value))
  }
  
  // 初始化状态（从localStorage加载）
  const initMCPToolsState = () => {
    try {
      const saved = localStorage.getItem('mcp-tools-enabled')
      if (saved !== null) {
        isMCPToolsEnabled.value = JSON.parse(saved)
      } else {
        isMCPToolsEnabled.value = true
      }
    } catch (error) {
      isMCPToolsEnabled.value = true
    }
  }
  
  // 获取当前状态
  const getMCPToolsEnabled = () => {
    return isMCPToolsEnabled.value;
  }
  
  return {
    isMCPToolsEnabled,
    toggleMCPTools,
    initMCPToolsState,
    getMCPToolsEnabled
  }
})