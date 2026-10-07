import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 一条 hook 面向用户的消息（core HOOK_MESSAGE 事件载荷的单条展开） */
export interface HookNotice {
  id: number
  /** 触发的 hook 事件名（展示用） */
  event?: string
  text: string
  at: number
}

/** 保留的 hook 消息上限（超出丢弃最旧；内存态、不持久化、不入模型上下文） */
const MAX_HOOK_NOTICES = 50

/**
 * hook 消息 store（阶段 3：桌面 UI 支持）：
 * core 只经 eventBus 抛 HOOK_MESSAGE（警告/拦截理由/systemMessage，显示分离），
 * main.ts 订阅后推入本 store，ChatArea 以提示卡片渲染。
 * 信任询问的裁决结果（RendererHookTrustAsker）也经此告知用户。
 */
export const useHookMessageStore = defineStore('hookMessage', () => {
  const notices = ref<HookNotice[]>([])
  let nextId = 1

  /** 推入一批消息（一次 HOOK_MESSAGE 的 messages 数组逐条展开） */
  const push = (event: string | undefined, messages: string[]) => {
    for (const text of messages) {
      if (!text) continue
      notices.value.push({ id: nextId++, event, text, at: Date.now() })
    }
    if (notices.value.length > MAX_HOOK_NOTICES) {
      notices.value.splice(0, notices.value.length - MAX_HOOK_NOTICES)
    }
  }

  const dismiss = (id: number) => {
    const idx = notices.value.findIndex((n) => n.id === id)
    if (idx >= 0) notices.value.splice(idx, 1)
  }

  const clear = () => {
    notices.value = []
  }

  return { notices, push, dismiss, clear }
})
