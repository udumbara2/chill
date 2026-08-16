/**
 * 桌面控制器接口（截屏 + 键鼠注入）。
 * core 平台无关硬约束：原生桌面能力是"平台相关能力"，只能以"接口 + 宿主注入实现"
 * 的方式进入引擎（CLI 注入 NativeDesktopController，UI 注入 IPC 桥实现）。
 * 坐标系约定：本接口只认物理像素坐标（含多显示器虚拟桌面原点偏移，origin 可为负）；
 * "模型看到的缩放图坐标 ↔ 物理像素"的换算在 execution/desktopCoordinates.ts 纯函数中完成，
 * 宿主实现永远不需要知道模型坐标的存在。
 */

/** 截屏结果（图像已按 maxLongEdge 等比缩放，即模型实际看到的坐标空间） */
export interface DesktopCaptureResult {
  /** PNG 的 data URI（data:image/png;base64,...），直接作为 image_url 块内容回模型 */
  dataUri: string
  /** 缩放后图像宽度（模型坐标空间） */
  width: number
  /** 缩放后图像高度（模型坐标空间） */
  height: number
  /** 原生 DPI 缩放比（如 Windows 150% → 1.5）。纯信息性（日志/调试），严禁用于坐标换算——
      图像↔物理换算比一律由 width/physWidth 经 deriveImageScale 现派生（契约只运输实测事实） */
  dpiScale: number
  /** 显示器在虚拟桌面中的原点 X（物理像素，可为负） */
  originX: number
  /** 显示器在虚拟桌面中的原点 Y（物理像素，可为负） */
  originY: number
  /** 显示器物理分辨率宽 */
  physWidth: number
  /** 显示器物理分辨率高 */
  physHeight: number
}

/** 键鼠输入动作（判别联合；坐标一律为虚拟桌面物理像素） */
export type DesktopInputAction =
  | { action: 'mouse_move'; x: number; y: number }
  | { action: 'mouse_click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  | { action: 'mouse_drag'; startX: number; startY: number; endX: number; endY: number }
  | { action: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { action: 'type'; text: string }
  | { action: 'key'; keys: string }
  | { action: 'cursor_position' }

/** 输入动作执行结果 */
export interface DesktopActionResult {
  success: boolean
  error?: string
  /** 带返回值的动作使用（如 cursor_position 返回当前光标物理像素坐标） */
  data?: { x?: number; y?: number }
}

/**
 * UIA 快照元素（inspect_ui 的结构化条目；与 @assistant-ai/native-desktop 的 napi 导出同形状）。
 * 坐标系红线：bbox（x/y/width/height）为**物理像素**（宿主加载原生模块时已声明 Per-Monitor V2，
 * UIA 随客户端 DPI awareness 直接返回物理坐标）——像素回退路径直接点 bbox 中心，
 * 严禁再过"模型图坐标 → 物理像素"换算通道（desktopCoordinates.ts 只服务模型看图猜的坐标）。
 */
export interface UiElementInfo {
  /** 元素编号（最近一次快照内的引用句柄；click_element/set_value/focus_window 按此引用） */
  label: number
  /** 元素名（如按钮文本"保存"） */
  name: string
  /** UIA 控件类型（如 Button/Edit/MenuItem） */
  controlType: string
  /** bbox 左上角 X（物理像素，虚拟桌面坐标系，可为负） */
  x: number
  /** bbox 左上角 Y（物理像素） */
  y: number
  /** bbox 宽（物理像素） */
  width: number
  /** bbox 高（物理像素） */
  height: number
  /** 所属顶层窗口句柄（focus_window 用） */
  hwnd: number
  /** UIA RuntimeId 序列化串；invoke/setValue 时传回宿主现场解析活元素（宿主不持有元素缓存） */
  runtimeId: string
  /** 支持 InvokePattern（可直接调用，不移动鼠标、不需要前台焦点） */
  hasInvoke: boolean
  /** 支持 ValuePattern（可直接写值） */
  hasValue: boolean
  /** 支持 TogglePattern */
  hasToggle: boolean
}

export interface IDesktopController {
  /** 原生模块加载失败 / 平台不支持 → false（可控降级，工具返回明确错误而非启动即炸） */
  isAvailable(): Promise<boolean>
  /** 截取屏幕（display 缺省主显示器；maxLongEdge 缺省由实现决定） */
  capture(req?: { display?: number; maxLongEdge?: number }): Promise<DesktopCaptureResult>
  /** 注入键鼠输入（物理像素坐标） */
  input(action: DesktopInputAction): Promise<DesktopActionResult>
  /** UIA 元素快照（scope 缺省 active_window 只抓前台窗口；返回元素 bbox 为物理像素） */
  snapshot(scope?: 'active_window' | 'desktop'): Promise<UiElementInfo[]>
  /** 按 runtimeId 现场解析并 Invoke；元素失效/不支持 → success:false + 明确错误（如"元素已失效，请重新 inspect_ui"） */
  invokeElement(runtimeId: string): Promise<DesktopActionResult>
  /** 按 runtimeId 现场解析并经 ValuePattern 写值；失败语义同 invokeElement */
  setElementValue(runtimeId: string, text: string): Promise<DesktopActionResult>
  /** 置前窗口（宿主内置完整置前配方 + 回读验证；失败返回明确错误，不盲打） */
  focusWindow(hwnd: number): Promise<DesktopActionResult>
}
