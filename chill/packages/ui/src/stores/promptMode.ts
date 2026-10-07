import { reactive } from 'vue'

interface PromptModeState {
  isDirectSend: boolean
}

export const promptMode = reactive<PromptModeState>({
  isDirectSend: false
})
