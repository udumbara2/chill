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

/** 显示器信息（四期多显示器能力；与 @assistant-ai/native-desktop 的 napi DisplayInfo 同形状） */
export interface DisplayInfo {
  /** 显示器索引（capture 的 display 参数取值） */
  index: number
  /** 显示器名（如 \\.\DISPLAY1） */
  name: string
  /** 虚拟桌面原点 X（物理像素，可为负） */
  x: number
  /** 虚拟桌面原点 Y（物理像素，可为负） */
  y: number
  /** 物理分辨率宽 */
  width: number
  /** 物理分辨率高 */
  height: number
  /** 原生 DPI 缩放比（纯信息性，不参与坐标换算） */
  dpiScale: number
  /** 是否主显示器 */
  isPrimary: boolean
}

/** region zoom 的物理裁剪矩形（虚拟桌面物理像素；由 core 把模型图像坐标 region 换算后传入） */
export interface DesktopCaptureRegion {
  x: number
  y: number
  width: number
  height: number
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
  /** 元素属于 chill 宿主进程树（ProcessId 判定）：宿主元素保留在快照中（set_value 带外写文本
      是合法窄通道），但 invoke 会被原生层硬门拒绝；core 文本表据此标注「宿主」 */
  isHost?: boolean
}

/** preflight 探测结果（批处理逐步安全检查数据源） */
export interface DesktopPreflight {
  /** 用户物理按下 ESC（中止信号） */
  escPressed: boolean
  /** 当前光标物理像素 X（用户接管检测：与我方预期位置比对） */
  x: number
  /** 当前光标物理像素 Y */
  y: number
}

/** window_manage 的操作类型（几何三操作 + 状态三操作 + close；close 对宿主窗口永拒） */
export type DesktopWindowManageOp = 'move' | 'resize' | 'set_bounds' | 'minimize' | 'maximize' | 'restore' | 'close'

export interface IDesktopController {
  /** 原生模块加载失败 / 平台不支持 → false（可控降级，工具返回明确错误而非启动即炸） */
  isAvailable(): Promise<boolean>
  /** 枚举显示器（多显示器 display 参数与摘要清单的数据源） */
  listDisplays(): Promise<DisplayInfo[]>
  /**
   * 截取屏幕（display 缺省主显示器；maxLongEdge 缺省由实现决定）。
   * regionPhys：region zoom 的物理裁剪矩形——capture 层先裁剪再等比缩放，
   * 返回值的 originX/originY/physWidth/physHeight 按裁剪框回写（core 的 meta/toPhysical 因此零改动）。
   */
  capture(req?: { display?: number; maxLongEdge?: number; regionPhys?: DesktopCaptureRegion }): Promise<DesktopCaptureResult>
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
  /** 批处理逐步安全探测：ESC 物理按下 + 当前光标位置（PyAutoGUI FAILSAFE 的 Windows 等价） */
  preflight(): Promise<DesktopPreflight>
  /** 释放全部修饰键与鼠标键（批首恢复调用——清除上次异常残留的卡键状态；幂等无害） */
  releaseAllInputs(): Promise<void>
  /** 注入兄弟 chill 实例根 PID（core 实例注册表 → 本接口 → 原生保护集；全量替换语义） */
  setProtectedExtraPids(pids: number[]): Promise<void>
  /** 审批挂起状态推送（core 审批聚合器 → 本接口 → 原生 APPROVAL_PENDING；
      挂起期间对宿主窗口的点击/键入被原生层拦截——自审批攻击面封堵） */
  setApprovalPending(pending: boolean): Promise<void>
  /** 窗口管理原语（API 直调不经像素注入；rect 为物理像素虚拟桌面坐标，由 core 换算后传入；
      close 对宿主窗口被原生层永拒——与点 X 同义，非强杀） */
  manageWindow(req: { hwnd: number; op: DesktopWindowManageOp; rect?: DesktopCaptureRegion }): Promise<DesktopActionResult>
}
