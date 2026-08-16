import type { IUserInputProvider, AskUserOption } from '@assistant-ai/core'
import { usePlanModeStore } from '../stores/planModeStore'

// 渲染进程用户输入适配器：core 执行器的 ask 经此转到 Pinia store 驱动 PlanAskDialog
// （与 PiniaConfirmationHandler 同范式：adapter 内惰性取 store，避免模块级循环依赖）
export class RendererUserInputProvider implements IUserInputProvider {
  ask(question: string, options?: AskUserOption[], allowFreeText?: boolean): Promise<string> {
    const store = usePlanModeStore()
    return store.openAsk(question, options, allowFreeText)
  }
}
