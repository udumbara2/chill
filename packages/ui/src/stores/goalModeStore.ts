import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getChatEngine } from '../services/chatEngine'

/**
 * goalModeStore（对照 planModeStore：引擎状态的订阅/转发层，不是状态源）：
 * - 展示态（目标/轮次/状态）：由 syncFromEngine 现读引擎（GOAL_* 事件经 main.ts 接线触发）；
 * - setGoal/clearGoal/pauseGoal/resumeGoal（用户动作：InputArea 按钮 / GoalModeBar）：
 *   转发引擎（状态源），并同步主进程 executor（read_goal 是 Node-only 工具、在主进程执行，
 *   "仅目标模式"门需两端一致；单向通道，主进程不回传，无回环）；
 * - goal 的 ask 对话框（熔断请示 / propose_goal 确认）复用 planModeStore 的 ask 状态机
 *   （RendererUserInputProvider → planModeStore.openAsk → PlanAskDialog），此处不重复实现。
 */
export const useGoalModeStore = defineStore('goalMode', () => {
  const isGoalMode = ref(false)
  const objective = ref('')
  const status = ref<'active' | 'paused'>('active')
  const roundCount = ref(0)
  const maxRounds = ref(20)

  /** 设定目标（InputArea 目标按钮确认后调用）；状态源归引擎，事件回流后 syncFromEngine 刷新展示 */
  const setGoal = (objectiveText: string) => {
    getChatEngine().setGoal(objectiveText)
    ;(window.electronAPI as any)?.setGoalMode?.(true)
  }

  /** 放弃目标（GoalModeBar 退出按钮 / InputArea 按钮再点） */
  const clearGoal = () => {
    getChatEngine().clearGoal()
    ;(window.electronAPI as any)?.setGoalMode?.(false)
  }

  /** 暂停推进（GoalModeBar 暂停按钮） */
  const pauseGoal = () => {
    getChatEngine().pauseGoal()
  }

  /** 恢复推进（GoalModeBar 恢复按钮；引擎空闲即续跑，异步不阻塞 UI） */
  const resumeGoal = () => {
    void getChatEngine().resumeGoal()
  }

  /**
   * 事件驱动的展示同步（GOAL_STARTED/GOAL_ACHIEVED/GOAL_PAUSED/GOAL_RESUMED/GOAL_CLEARED/
   * GOAL_BUDGET_EXHAUSTED 与逐轮计数刷新，均由 main.ts 接线调用）：现读引擎状态，不回调引擎。
   */
  const syncFromEngine = () => {
    const goal = getChatEngine().getGoalState()
    isGoalMode.value = goal !== null
    objective.value = goal?.objective ?? ''
    status.value = goal?.status ?? 'active'
    roundCount.value = goal?.roundCount ?? 0
    maxRounds.value = goal?.maxRounds ?? 20
    // 主进程 executor 门单向同步（覆盖 propose_goal/交卷达成等模型侧路径——它们不经 setGoal/clearGoal）
    ;(window.electronAPI as any)?.setGoalMode?.(goal !== null)
  }

  return {
    isGoalMode,
    objective,
    status,
    roundCount,
    maxRounds,
    setGoal,
    clearGoal,
    pauseGoal,
    resumeGoal,
    syncFromEngine,
  }
})
