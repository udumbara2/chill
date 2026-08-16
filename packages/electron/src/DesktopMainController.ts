import type {
  IDesktopController,
  DesktopCaptureResult,
  DesktopInputAction,
  DesktopActionResult,
  UiElementInfo,
} from '@assistant-ai/core'
import type * as NativeDesktop from '@assistant-ai/native-desktop'

type NativeBinding = typeof NativeDesktop

/** 截屏等比缩放长边上限缺省值（core 未指定时；与 CLI NativeDesktopController 同一缺省） */
const DEFAULT_MAX_LONG_EDGE = 1280

/**
 * 桌面能力主进程控制器（迭代 4.1）：core IDesktopController 的主进程实现。
 * napi 模块 @assistant-ai/native-desktop 只能在主进程加载（渲染进程是浏览器环境）；
 * 懒加载——首次桌面调用才 require，不拖慢 app 启动；加载失败（缺 prebuild/平台不支持）
 * → isAvailable()=false，方法返回明确错误（可控降级）。
 * esbuild 打包时该模块标 external，运行期从 node_modules 现解析，不进 bundle。
 * 坐标系：action 内坐标均为物理像素（模型图坐标→物理像素的换算在 core 纯函数里做）。
 */
export class DesktopMainController implements IDesktopController {
  private binding: NativeBinding | null = null
  private loadError: string | null = null
  private loadAttempted = false

  /** 懒加载原生绑定；失败只记录一次，后续调用直接走降级路径 */
  private ensureLoaded(): NativeBinding | null {
    if (this.loadAttempted) return this.binding
    this.loadAttempted = true
    try {
      this.binding = require('@assistant-ai/native-desktop') as NativeBinding
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err)
      this.binding = null
    }
    return this.binding
  }

  private unavailableError(): string {
    return `当前环境缺少桌面原生模块（需重新构建或该平台暂无 prebuild）：${this.loadError}`
  }

  async isAvailable(): Promise<boolean> {
    return this.ensureLoaded() !== null
  }

  async capture(req?: { display?: number; maxLongEdge?: number }): Promise<DesktopCaptureResult> {
    const native = this.ensureLoaded()
    if (!native) throw new Error(this.unavailableError())
    // 未指定显示器时截主屏（多显示器 display 参数为四期能力，此处先解析主屏索引兜底）
    let displayIndex = req?.display
    if (displayIndex === undefined) {
      const displays = native.listDisplays()
      displayIndex = displays.find((d) => d.isPrimary)?.index ?? 0
    }
    const r = native.captureDisplay(displayIndex, req?.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE)
    return {
      // core 契约：完整 data URI；napi Buffer 在此转 base64 字符串后再过 IPC（结构化克隆只运纯数据）
      dataUri: `data:image/png;base64,${r.png.toString('base64')}`,
      width: r.width,
      height: r.height,
      dpiScale: r.dpiScale,
      originX: r.originX,
      originY: r.originY,
      physWidth: r.physWidth,
      physHeight: r.physHeight,
    }
  }

  async input(action: DesktopInputAction): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      switch (action.action) {
        case 'mouse_move':
          native.mouseMove(action.x, action.y)
          return { success: true }
        case 'mouse_click':
          native.mouseClick(action.x, action.y, action.button ?? 'left', action.count ?? 1)
          return { success: true }
        case 'mouse_drag':
          native.mouseDrag(action.startX, action.startY, action.endX, action.endY)
          return { success: true }
        case 'scroll':
          native.scroll(action.x, action.y, action.deltaX, action.deltaY)
          return { success: true }
        case 'type':
          native.typeText(action.text)
          return { success: true }
        case 'key':
          native.key(action.keys)
          return { success: true }
        case 'cursor_position': {
          const [x, y] = native.cursorPosition()
          return { success: true, data: { x, y } }
        }
        default:
          return { success: false, error: `未知的桌面输入动作：${JSON.stringify(action)}` }
      }
    } catch (err) {
      // napi 抛错（如 SendInput 被完整性级别拦截）如实透传，由 core 组织文案
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** UIA 元素快照；napi 同步返回元素数组，字段与 UiElementInfo 同形状直传 */
  async snapshot(scope?: 'active_window' | 'desktop'): Promise<UiElementInfo[]> {
    const native = this.ensureLoaded()
    if (!native) throw new Error(this.unavailableError())
    return native.uiSnapshot(scope ?? 'active_window')
  }

  async invokeElement(runtimeId: string): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      native.uiInvoke(runtimeId)
      return { success: true }
    } catch (err) {
      // napi 抛错（"元素已失效，请重新 inspect_ui" / "该元素不支持 Invoke"）如实透传
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async setElementValue(runtimeId: string, text: string): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      native.uiSetValue(runtimeId, text)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async focusWindow(hwnd: number): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      native.focusWindow(hwnd)
      return { success: true }
    } catch (err) {
      // 置前配方失败（回读验证未通过等）如实透传，由 core 组织文案让模型重试
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
