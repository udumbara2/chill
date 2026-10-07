import { defineStore } from 'pinia'
import { ref } from 'vue'
import { builtInToolExecutor, type PermissionMode } from '@assistant-ai/core'

/**
 * permissionModeStore（对照 contextStatusStore/goalModeStore：引擎状态的订阅/转发层，不是状态源）：
 * 权限三态（只读/边界/直写）的唯一事实源是 core executor 的 permissionMode 单字段；
 * 本 store 是唯一 UI 写入点（radio 互斥由 setPermissionMode 构造保证），镜像供组件响应式渲染。
 * 会话级内存态，不持久化（与 CLI /auto-apply 语义一致）。
 */
export const usePermissionModeStore = defineStore('permissionMode', () => {
  const mode = ref<PermissionMode>('boundary')

  const set = (m: PermissionMode) => {
    builtInToolExecutor.setPermissionMode(m)
    mode.value = m
    // Web 家目录只读闸联动（可选 API，desktop 无此闸空转；daemon 仅在降级态实际生效）：
    // 选择器=只读 → 落闸；边界/直写 → 抬闸。会话级不落盘，重启复位。
    void window.electronAPI?.fsSetGate?.(m === 'readonly')
  }

  /** 现读引擎（不回调，无回环）；启动时初始化 */
  const syncFromEngine = () => {
    mode.value = builtInToolExecutor.getPermissionMode()
  }

  /** Web 启动对齐：daemon 处家目录降级落闸态时选择器同步为只读（闸的真相在 daemon） */
  const syncGateFromHost = async () => {
    const gate = await window.electronAPI?.fsGetGate?.()
    if (gate?.downgraded && gate.enforced) set('readonly')
  }

  return { mode, set, syncFromEngine, syncGateFromHost }
})
