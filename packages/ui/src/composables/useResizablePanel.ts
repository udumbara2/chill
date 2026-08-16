import { ref, onUnmounted } from 'vue'
import type { Ref } from 'vue'

export interface UseResizablePanelOptions {
  /** 默认宽度（双击手柄复位到此值） */
  defaultWidth: number
  /** 拖拽最小宽度 */
  minWidth: number
  /** 拖拽最大宽度（函数形式可随窗口大小动态求值，如 45% 窗口宽） */
  maxWidth: number | (() => number)
  /**
   * 吸附收起阈值（VS Code 模式）：拖过该宽度立即收起面板。
   * 不传则只拖宽不收起。收起后宽度值保留，重开时恢复。
   */
  collapseThreshold?: number
  /** 拖拽手柄所在边缘：'right' = 手柄在面板右缘（向右拖变宽），'left' = 左缘 */
  direction?: 'right' | 'left'
}

export interface UseResizablePanelReturn {
  width: Ref<number>
  collapsed: Ref<boolean>
  isResizing: Ref<boolean>
  /** 手柄 mousedown 时调用 */
  startResize: (e: MouseEvent) => void
  /**
   * 从收起状态「拉出」面板的拖拽入口（宽度从 0 起步，拖过 collapseThreshold 正式打开，
   * 不足则在 mouseup 时重新收起）。onOpen 在拉出开始时触发（如刷新列表数据）。
   */
  startPull: (e: MouseEvent, onOpen?: () => void | Promise<void>) => void
  /** 双击手柄复位默认宽（收起状态下同时展开） */
  resetWidth: () => void
}

/**
 * 面板拖拽调宽 composable（提取自 WorkflowView/WritingView/ResultModal 三处同构拖拽逻辑）。
 * 拖宽与「拖过 min 阈值吸附收起」为一套逻辑；双击手柄复位默认宽。
 */
export function useResizablePanel(options: UseResizablePanelOptions): UseResizablePanelReturn {
  const { defaultWidth, minWidth, maxWidth, collapseThreshold, direction = 'right' } = options

  const width = ref(defaultWidth)
  const collapsed = ref(false)
  const isResizing = ref(false)

  const resolveMaxWidth = () => (typeof maxWidth === 'function' ? maxWidth() : maxWidth)
  const clampWidth = (w: number) => Math.max(minWidth, Math.min(resolveMaxWidth(), w))

  // 当前拖拽会话的监听器（卸载兜底清理用）
  let activeMouseMove: ((e: MouseEvent) => void) | null = null
  let activeMouseUp: (() => void) | null = null

  const cleanupListeners = () => {
    if (activeMouseMove) document.removeEventListener('mousemove', activeMouseMove)
    if (activeMouseUp) document.removeEventListener('mouseup', activeMouseUp)
    activeMouseMove = null
    activeMouseUp = null
  }

  const startResize = (e: MouseEvent) => {
    isResizing.value = true
    const startX = e.clientX
    const startWidth = collapsed.value ? defaultWidth : width.value

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isResizing.value) return
      const delta = direction === 'right' ? ev.clientX - startX : startX - ev.clientX
      const newWidth = startWidth + delta

      // 拖过收起阈值：吸附收起，宽度保留待重开恢复
      if (collapseThreshold !== undefined && newWidth < collapseThreshold) {
        collapsed.value = true
        isResizing.value = false
        cleanupListeners()
        return
      }

      collapsed.value = false
      width.value = clampWidth(newWidth)
    }

    const handleMouseUp = () => {
      isResizing.value = false
      cleanupListeners()
    }

    activeMouseMove = handleMouseMove
    activeMouseUp = handleMouseUp
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  const resetWidth = () => {
    width.value = defaultWidth
    collapsed.value = false
  }

  const startPull = (e: MouseEvent, onOpen?: () => void | Promise<void>) => {
    // 先展开但宽度为 0，随拖拽逐渐拉出；不足阈值则 mouseup 时重新收起
    collapsed.value = false
    width.value = 0
    isResizing.value = true
    void onOpen?.()

    const startX = e.clientX
    const openThreshold = collapseThreshold ?? 100

    const handleMouseMove = (ev: MouseEvent) => {
      if (!isResizing.value) return
      const delta = direction === 'right' ? ev.clientX - startX : startX - ev.clientX

      // 反方向拖（拉出距离为负）：取消打开
      if (delta < 0) {
        collapsed.value = true
        width.value = defaultWidth
        isResizing.value = false
        cleanupListeners()
        return
      }

      // 达到打开阈值后按正常区间收敛，否则实时显示拉出宽度
      width.value = delta >= openThreshold ? clampWidth(delta) : delta
    }

    const handleMouseUp = () => {
      isResizing.value = false
      if (width.value < openThreshold) {
        // 拉出距离不足：收起并复位宽度，下次展开恢复默认宽
        collapsed.value = true
        width.value = defaultWidth
      } else {
        width.value = clampWidth(width.value)
      }
      cleanupListeners()
    }

    activeMouseMove = handleMouseMove
    activeMouseUp = handleMouseUp
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  onUnmounted(cleanupListeners)

  return { width, collapsed, isResizing, startResize, startPull, resetWidth }
}
