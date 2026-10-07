import type {
  IDesktopController,
  DesktopCaptureResult,
  DesktopInputAction,
  DesktopActionResult,
  DesktopPreflight,
  DesktopWindowManageOp,
  UiElementInfo,
  DisplayInfo,
  DesktopCaptureRegion,
} from '@assistant-ai/core'
import { getHostAPI } from '../host/hostApi'

/**
 * 桌面控制器 IPC 桥（迭代 4.2）：渲染进程侧 IDesktopController 实现。
 * 全方法经单通道 desktop:call 转发到主进程 DesktopMainController
 * （napi 原生模块只能在主进程加载，渲染进程是浏览器环境）。
 * 错误语义与 CLI NativeDesktopController 对齐：不可用/失败经返回值或异常透传，由 core 组织文案。
 */
export class ElectronDesktopController implements IDesktopController {
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return getHostAPI().desktopCall(method, args) as Promise<T>
  }

  isAvailable(): Promise<boolean> {
    return this.call<boolean>('isAvailable')
  }

  listDisplays(): Promise<DisplayInfo[]> {
    return this.call<DisplayInfo[]>('listDisplays')
  }

  capture(req?: { display?: number; maxLongEdge?: number; regionPhys?: DesktopCaptureRegion }): Promise<DesktopCaptureResult> {
    return this.call<DesktopCaptureResult>('capture', req)
  }

  input(action: DesktopInputAction): Promise<DesktopActionResult> {
    return this.call<DesktopActionResult>('input', action)
  }

  snapshot(scope?: 'active_window' | 'desktop'): Promise<UiElementInfo[]> {
    return this.call<UiElementInfo[]>('snapshot', scope)
  }

  invokeElement(runtimeId: string): Promise<DesktopActionResult> {
    return this.call<DesktopActionResult>('invokeElement', runtimeId)
  }

  setElementValue(runtimeId: string, text: string): Promise<DesktopActionResult> {
    return this.call<DesktopActionResult>('setElementValue', runtimeId, text)
  }

  focusWindow(hwnd: number): Promise<DesktopActionResult> {
    return this.call<DesktopActionResult>('focusWindow', hwnd)
  }

  preflight(): Promise<DesktopPreflight> {
    return this.call<DesktopPreflight>('preflight')
  }

  releaseAllInputs(): Promise<void> {
    return this.call<void>('releaseAllInputs')
  }

  setProtectedExtraPids(pids: number[]): Promise<void> {
    return this.call<void>('setProtectedExtraPids', pids)
  }

  setApprovalPending(pending: boolean): Promise<void> {
    return this.call<void>('setApprovalPending', pending)
  }

  manageWindow(req: { hwnd: number; op: DesktopWindowManageOp; rect?: DesktopCaptureRegion }): Promise<DesktopActionResult> {
    return this.call<DesktopActionResult>('manageWindow', req)
  }
}
