import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getChatEngine } from '../services/chatEngine'

/**
 * contextStatusStore（对照 goalModeStore：引擎状态的订阅/转发层，不是状态源）：
 * 展示态（实测占用/窗口上限）由 syncFromEngine 现读引擎 getContextStatus（lastUsage 数据源，
 * 每轮 API 调用后更新）；main.ts 接线（ASSISTANT_MESSAGE_CREATED / CONTEXT_AUTO_COMPACTED）触发。
 * null（新会话/服务未返回 usage/压缩后未回报）时组件整条隐藏，不显示错误数字。
 */
export const useContextStatusStore = defineStore('contextStatus', () => {
  const usedTokens = ref<number | null>(null)
  const maxContextTokens = ref<number | null>(null)

  /** 现读引擎（不回调引擎 API，无回环）；无实测或分母缺失时两值置 null → 组件隐藏 */
  const syncFromEngine = () => {
    const status = getChatEngine().getContextStatus()
    usedTokens.value = status?.usedTokens ?? null
    maxContextTokens.value = status?.maxContextTokens ?? null
  }

  return { usedTokens, maxContextTokens, syncFromEngine }
})
