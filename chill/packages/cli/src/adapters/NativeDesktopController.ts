import { createRequire, Module } from 'node:module'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { pickNativeFile, computeShadowTag, shadowFileName, staleShadowNames } from '@assistant-ai/core'
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

/**
 * 元素级 napi 导出（UIA 快照/调用/写值/置前）的类型补充。
 * 本地声明而非依赖 @assistant-ai/native-desktop 的 index.d.ts——Rust 侧并行开发，
 * 类型层不耦合其发布节奏；运行期缺导出时调用处抛错透传（可控降级）。
 * 全异步化后所有导出返回 Promise（spawn_blocking 包裹，panic 被 tokio 隔离为 Error）。
 */
interface NativeUiExtension {
  uiSnapshot(scope: string): Promise<UiElementInfo[]>
  uiInvoke(runtimeId: string): Promise<void>
  uiSetValue(runtimeId: string, text: string): Promise<void>
  focusWindow(hwnd: number): Promise<void>
  preflight(): Promise<{ escPressed: boolean; cursorX: number; cursorY: number }>
  releaseAllInputs(): Promise<void>
  setProtectedExtraPids(pids: number[]): void
  setApprovalPending(pending: boolean): void
  windowManage(hwnd: number, op: string, rect?: { x: number; y: number; width: number; height: number }): Promise<void>
}

type NativeBinding = typeof NativeDesktop & NativeUiExtension

/** 截屏等比缩放长边上限缺省值（core 未指定时；对齐模型图像输入惯例） */
const DEFAULT_MAX_LONG_EDGE = 1280

/**
 * 桌面能力宿主适配器：实现 core 的 IDesktopController。
 * 原生模块 @assistant-ai/native-desktop（napi-rs）懒加载——首次调用桌面方法时才
 * createRequire 加载 .node，不拖慢 CLI 启动（沿用 build.mjs 的 TUI 懒加载哲学）；
 * 加载失败（缺 prebuild / 平台不支持）→ isAvailable()=false，方法返回明确错误。
 * Windows 下构造注入 shadowDir 时走影子加载：.node 原件先复制到安装树外
 * （~/.chill/native-shadow/）再 dlopen——Windows 对加载中的映像文件终身禁删，
 * 影子加载让进程锁的是影子而非安装树/workcopy 原件，版本切换后的清理不再撞 EPERM
 * （.NET Shadow Copy 同款解法；判定逻辑唯一事实点在 core services/nativeShadow.ts，
 * 本适配器只做 fs 接线）。影子链路任何一步失败 → 降级回直连 require（行为退化=现状）。
 * 坐标系：action 内坐标均为物理像素（模型图坐标→物理像素的换算在 core 纯函数里做）。
 * 宿主注入硬门在原生层（protect.rs）：落点/前台命中 chill 自身窗口的动作被原生层拒绝，
 * 本适配器只如实透传错误。
 */
export class NativeDesktopController implements IDesktopController {
  private binding: NativeBinding | null = null
  private loadError: string | null = null
  private loadAttempted = false

  constructor(private shadowDir?: string) {}

  /** 懒加载原生绑定；失败只记录一次，后续调用直接走降级路径。
   *  解析链：①包名（dev/managed 布局，pnpm workspace 链接）→ ②bundle 同目录的 native-desktop.js
   * （npm 包内布局：build.mjs 把 napi 加载器与 .node 复制进 dist/）。
   *  必须 fileURLToPath——本机路径含中文，.pathname 会 percent-encode 导致 require 失败 */
  private ensureLoaded(): NativeBinding | null {
    if (this.loadAttempted) return this.binding
    this.loadAttempted = true
    // Windows 影子加载（防映像锁阻碍 workcopy/版本目录清理）；失败降级直连
    if (process.platform === 'win32' && this.shadowDir) {
      this.binding = this.tryLoadShadow()
      if (this.binding) return this.binding
      console.warn(`[native-desktop] 影子加载失败，降级直连（workcopy 清理可能被映像锁阻碍）：${this.loadError ?? '原件未找到'}`)
    }
    const require = createRequire(import.meta.url)
    try {
      this.binding = require('@assistant-ai/native-desktop') as NativeBinding
    } catch (err) {
      try {
        this.binding = require(fileURLToPath(new URL('./native-desktop.cjs', import.meta.url))) as NativeBinding
      } catch (err2) {
        this.loadError = `${err instanceof Error ? err.message : String(err)}；包内路径同样失败：${err2 instanceof Error ? err2.message : String(err2)}`
        this.binding = null
      }
    }
    return this.binding
  }

  /**
   * 影子加载：原件复制到 shadowDir（内容标签去重，同构建全复用）后 dlopen 影子。
   * 影子文件名带标签后缀（<original>.<tag>），require 会按未知扩展名当 JS 解析——
   * 必须 process.dlopen 直载（实测验证）；napi 导出等价（加载器本就是纯转发）。
   */
  private tryLoadShadow(): NativeBinding | null {
    try {
      const originalPath = this.resolveOriginalNativeFile()
      if (!originalPath) return null
      const originalName = basename(originalPath)
      const st = statSync(originalPath)
      const tag = computeShadowTag({ size: st.size, mtimeMs: st.mtimeMs })
      const shadowName = shadowFileName(originalName, tag)
      mkdirSync(this.shadowDir!, { recursive: true })
      const shadowPath = join(this.shadowDir!, shadowName)
      if (!existsSync(shadowPath)) {
        // 原子复制：tmp+rename（对齐 AGENTS.md 原子写约定）；每进程至多复制一次，同构建全复用
        const tmpPath = join(this.shadowDir!, `${shadowName}.tmp-${process.pid}`)
        copyFileSync(originalPath, tmpPath)
        try {
          renameSync(tmpPath, shadowPath)
        } catch (err) {
          if (!existsSync(shadowPath)) throw err
          // rename 撞已存在=多进程同启竞态败者：删临时件，复用胜者文件
          try { unlinkSync(tmpPath) } catch { /* 清理失败无碍 */ }
        }
      }
      const mod = new Module(shadowPath)
      process.dlopen(mod, shadowPath)
      const binding = mod.exports as NativeBinding
      // 过期影子清理（逐个 try/catch：被活着的旧进程锁住的跳过，下轮再清）
      for (const stale of staleShadowNames(readdirSync(this.shadowDir!), originalName, tag)) {
        try { unlinkSync(join(this.shadowDir!, stale)) } catch { /* 被锁跳过 */ }
      }
      return binding
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  /** 定位 .node 原件：链① require.resolve 包名得入口同目录选定；链② dist/ 同目录选定 */
  private resolveOriginalNativeFile(): string | null {
    const require = createRequire(import.meta.url)
    try {
      const dir = dirname(require.resolve('@assistant-ai/native-desktop'))
      const picked = pickNativeFile(readdirSync(dir), 'native-desktop', process.platform, process.arch)
      if (picked) return join(dir, picked)
    } catch { /* 落到链② */ }
    try {
      const dir = fileURLToPath(new URL('.', import.meta.url))
      const picked = pickNativeFile(readdirSync(dir), 'native-desktop', process.platform, process.arch)
      if (picked) return join(dir, picked)
    } catch { /* 无原件 */ }
    return null
  }

  private unavailableError(): string {
    // 平台诚实降级：当前 npm 分发仅携带 win32-x64 prebuild，其余平台给出确定性话术而非泛化报错
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      return `桌面控制当前仅支持 Windows x64（当前环境：${process.platform}-${process.arch}），其余功能不受影响`
    }
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
      // core 契约：完整 data URI（mediaParts 组装在 core executor 侧）；
      // dpiScale 纯信息性透传（坐标换算由 core 用 width/physWidth 现派生，本适配器不参与）
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
