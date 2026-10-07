import { ref } from 'vue'
import { getChatEngine } from '../services/chatEngine'
import { useContextStatusStore } from '../stores/contextStatusStore'

/**
 * 手动压缩上下文（/compact 的 UI 等价物）：行业惯例是"指示与动作同位"——
 * 动作入口在上下文占用环的悬停详情里（ContextUsageRing），不在控件行占视觉位。
 * 模块级单例状态：isCompacting 防重入（引擎侧另有 running/后台任务护栏），toast 为结果反馈通道
 * （压缩成败 + 目标模式停滞提示等输入区瞬态消息共用），由 ContextUsageRing 渲染。
 * 成功后 compactionVersion 自增（Home watch 它刷新消息区「已压缩」标记条）。
 */

export const isCompacting = ref(false)

/** 压缩成功版本号（每次成功 +1；Home watch 触发 chatArea.refreshCompactions） */
export const compactionVersion = ref(0)

export const compactToast = ref<{ show: boolean; message: string; type: 'success' | 'error' | 'info' }>({
  show: false,
  message: '',
  type: 'success',
})
let toastTimer: ReturnType<typeof setTimeout> | null = null

export const showCompactToast = (message: string, type: 'success' | 'error' | 'info') => {
  compactToast.value = { show: true, message, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    compactToast.value.show = false
  }, 6000)
}

/** 手动压缩：护栏不满足/压缩失败时引擎抛错（错误消息用户可读），原样友好提示。
 *  成功反馈 = 聊天区压缩分割线（checkpoint 携带统计，CompactionMarker 渲染）——不再有成功 toast */
export const runCompact = async () => {
  if (isCompacting.value) return
  isCompacting.value = true
  try {
    const engine = getChatEngine()
    const result = await engine.compactHistory()
    if (!result) {
      showCompactToast('压缩失败：未产生有效总结，会话记录未改动', 'error')
      return
    }
    // 通知 Home 刷新消息区的压缩分割线
    compactionVersion.value++
    // 手动压缩无引擎事件（CONTEXT_AUTO_COMPACTED 仅自动路径发射）——占用环在成功点顺手同步，
    // 否则环要等下一轮 API 实测才刷新（引擎已重置 lastUsage，sync 后环按"无实测"隐藏）
    useContextStatusStore().syncFromEngine()
  } catch (error) {
    showCompactToast(error instanceof Error ? error.message : '压缩失败：未知错误', 'error')
  } finally {
    isCompacting.value = false
  }
}
