import type {
  IDesktopController,
  DesktopCaptureResult,
  DesktopInputAction,
  DesktopActionResult,
  DesktopPreflight,
  UiElementInfo,
  DisplayInfo,
  DesktopCaptureRegion,
} from '@assistant-ai/core'
import type * as NativeDesktop from '@assistant-ai/native-desktop'
import path from 'node:path'

type NativeBinding = typeof NativeDesktop

/** 截屏等比缩放长边上限缺省值（core 未指定时；与 CLI NativeDesktopController 同一缺省） */
const DEFAULT_MAX_LONG_EDGE = 1280

/**
 * 桌面能力主进程控制器：core IDesktopController 的主进程实现。
 * napi 模块 @assistant-ai/native-desktop 只能在主进程加载（渲染进程是浏览器环境）；
 * 懒加载——首次桌面调用才 require，不拖慢 app 启动；加载失败（缺 prebuild/平台不支持）
 * → isAvailable()=false，方法返回明确错误（可控降级）。
 * esbuild 打包时该模块标 external，运行期从 node_modules 现解析，不进 bundle。
 * 坐标系：action 内坐标均为物理像素（模型图坐标→物理像素的换算在 core 纯函数里做）。
 * 宿主注入硬门在原生层（protect.rs）：落点/前台命中 chill 自身窗口（含 Electron 主窗口——
 * 窗口属主即本进程 PID，自动进保护集）的动作被原生层拒绝，本控制器只如实透传错误。
 */
export class DesktopMainController implements IDesktopController {
  private binding: NativeBinding | null = null
  private loadError: string | null = null
  private loadAttempted = false

  /** 懒加载原生绑定；失败只记录一次，后续调用直接走降级路径。
   *  解析链：①包名（dev 布局，node_modules 链接）→ ②process.resourcesPath/native-desktop/index.js
   * （打包布局：electron-builder extraResources 收 index.js + .node；index.js 内部按相对路径解析 .node） */
  private ensureLoaded(): NativeBinding | null {
    if (this.loadAttempted) return this.binding
    this.loadAttempted = true
    try {
      this.binding = require('@assistant-ai/native-desktop') as NativeBinding
    } catch (err) {
      try {
        this.binding = require(path.join(process.resourcesPath, 'native-desktop', 'index.js')) as NativeBinding
      } catch (err2) {
        this.loadError = `${err instanceof Error ? err.message : String(err)}；resourcesPath 同样失败：${err2 instanceof Error ? err2.message : String(err2)}`
        this.binding = null
      }
    }
    return this.binding
  }

  private unavailableError(): string {
    return `当前环境缺少桌面原生模块（需重新构建或该平台暂无 prebuild）：${this.loadError}`
  }

  async isAvailable(): Promise<boolean> {
    return this.ensureLoaded() !== null
  }

  /** 枚举显示器（多显示器 display 参数与摘要清单的数据源） */
  async listDisplays(): Promise<DisplayInfo[]> {
    const native = this.ensureLoaded()
    if (!native) throw new Error(this.unavailableError())
    return native.listDisplays()
  }

  async capture(req?: { display?: number; maxLongEdge?: number; regionPhys?: DesktopCaptureRegion }): Promise<DesktopCaptureResult> {
    const native = this.ensureLoaded()
    if (!native) throw new Error(this.unavailableError())
    // 未指定显示器时截主屏
    let displayIndex = req?.display
    if (displayIndex === undefined) {
      const displays = await native.listDisplays()
      displayIndex = displays.find((d) => d.isPrimary)?.index ?? 0
    }
    // regionPhys：region zoom 物理裁剪矩形（可选第三参；napi 侧先裁剪再缩放，origin/phys 按裁剪框回写）
    const r = await native.captureDisplay(displayIndex, req?.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE, req?.regionPhys)
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
          await native.mouseMove(action.x, action.y)
          return { success: true }
        case 'mouse_click':
          await native.mouseClick(action.x, action.y, action.button ?? 'left', action.count ?? 1)
          return { success: true }
        case 'mouse_drag':
          await native.mouseDrag(action.startX, action.startY, action.endX, action.endY)
          return { success: true }
        case 'scroll':
          await native.scroll(action.x, action.y, action.deltaX, action.deltaY)
          return { success: true }
        case 'type':
          await native.typeText(action.text)
          return { success: true }
        case 'key':
          await native.key(action.keys)
          return { success: true }
        case 'cursor_position': {
          const [x, y] = await native.cursorPosition()
          return { success: true, data: { x, y } }
        }
        default:
          return { success: false, error: `未知的桌面输入动作：${JSON.stringify(action)}` }
      }
    } catch (err) {
      // napi 抛错（含宿主硬门拒绝、SendInput 被完整性级别拦截）如实透传，由 core 组织文案
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** UIA 元素快照；元素含 isHost 标注（宿主元素 set_value 放行 / invoke 被原生硬门拒绝） */
  async snapshot(scope?: 'active_window' | 'desktop'): Promise<UiElementInfo[]> {
    const native = this.ensureLoaded()
    if (!native) throw new Error(this.unavailableError())
    return native.uiSnapshot(scope ?? 'active_window')
  }

  async invokeElement(runtimeId: string): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      await native.uiInvoke(runtimeId)
      return { success: true }
    } catch (err) {
      // napi 抛错（"元素已失效，请重新 inspect_ui" / "该元素不支持 Invoke" / 宿主硬门拒绝）如实透传
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async setElementValue(runtimeId: string, text: string): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      await native.uiSetValue(runtimeId, text)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async focusWindow(hwnd: number): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      await native.focusWindow(hwnd)
      return { success: true }
    } catch (err) {
      // 置前配方失败（回读验证未通过等）如实透传，由 core 组织文案让模型重试
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 批处理逐步安全探测（ESC/光标位置）；原生字段 cursorX/cursorY 映射为接口契约 x/y */
  async preflight(): Promise<DesktopPreflight> {
    const native = this.ensureLoaded()
    if (!native) throw new Error(this.unavailableError())
    const p = await native.preflight()
    return { escPressed: p.escPressed, x: p.cursorX, y: p.cursorY }
  }

  async releaseAllInputs(): Promise<void> {
    const native = this.ensureLoaded()
    if (!native) return // 无原生模块时无键可卡，静默空操作
    await native.releaseAllInputs()
  }

  async setProtectedExtraPids(pids: number[]): Promise<void> {
    const native = this.ensureLoaded()
    if (!native) return
    native.setProtectedExtraPids(pids)
  }

  async setApprovalPending(pending: boolean): Promise<void> {
    const native = this.ensureLoaded()
    if (!native) return
    native.setApprovalPending(pending)
  }

  async manageWindow(req: { hwnd: number; op: string; rect?: { x: number; y: number; width: number; height: number } }): Promise<DesktopActionResult> {
    const native = this.ensureLoaded()
    if (!native) return { success: false, error: this.unavailableError() }
    try {
      await native.windowManage(req.hwnd, req.op, req.rect)
      return { success: true }
    } catch (err) {
      // napi 抛错（含宿主 close 永拒、护栏拦截）如实透传，由 core 组织文案
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
