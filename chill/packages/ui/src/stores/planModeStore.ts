import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AskUserOption } from '@assistant-ai/core'
import { getChatEngine } from '../services/chatEngine'
import { tryGetHostAPI } from '../host/hostApi'

/**
 * planModeStore（T5 改为引擎状态的订阅/转发层，不再是状态源）：
 * - isPlanMode 展示状态：由 applyExternal 同步（PLAN_MODE_ENTERED/PLAN_APPROVED 事件、主进程 IPC）；
 * - setPlanMode（用户动作：InputArea 规划药丸与其悬停卡退出按钮）：转发引擎（状态源），
 *   并同步主进程 executor（submit_plan/write_plan 是 Node-only 工具、在主进程执行，拦截需一致）；
 * - ask 对话框状态机（PlanAskDialog 与 main.ts 的 AskChannel 呈现面订阅共用）保持原样。
 */
export const usePlanModeStore = defineStore('planMode', () => {
  const isPlanMode = ref(false)

  // 规划模式不持久化：每次启动默认关闭，进入/退出由模型与用户实时决定
  const setPlanMode = (on: boolean) => {
    isPlanMode.value = on
    // 状态源归引擎（同步 renderer 执行器拦截门并发事件；引擎对同态调用幂等）
    getChatEngine().setPlanMode(on)
    // 主进程 executor 同步（node-only 工具在主进程执行，planMode 拦截必须与引擎一致）
    ;tryGetHostAPI()?.setPlanMode?.(on)
  }

  /** 事件/IPC 驱动的展示同步（不回调引擎，防回环） */
  const applyExternal = (on: boolean) => {
    isPlanMode.value = on
  }

  // ---- ask 对话框状态（PlanAskDialog 与 main.ts 的 AskChannel 呈现面共用） ----
  const askVisible = ref(false)
  const askQuestion = ref('')
  const askOptions = ref<AskUserOption[]>([])
  const askAllowFreeText = ref(false)
  // 当前挂起 ask 的 Promise resolve 指针，resolveAsk 时兑现
  let askResolve: ((answer: string) => void) | null = null

  const openAsk = (question: string, options?: AskUserOption[], allowFreeText?: boolean): Promise<string> => {
    // 已有挂起的 ask 时先以空串兑现，避免 Promise 永久悬挂
    if (askResolve) {
      askResolve('')
      askResolve = null
    }
    askQuestion.value = question
    askOptions.value = options ?? []
    askAllowFreeText.value = allowFreeText ?? false
    askVisible.value = true
    return new Promise<string>((resolve) => {
      askResolve = resolve
    })
  }

  const resolveAsk = (answer: string) => {
    if (askResolve) {
      askResolve(answer)
      askResolve = null
    }
    askVisible.value = false
  }

  return {
    isPlanMode,
    setPlanMode,
    applyExternal,
    askVisible,
    askQuestion,
    askOptions,
    askAllowFreeText,
    openAsk,
    resolveAsk
  }
})
