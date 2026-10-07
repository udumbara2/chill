// AI 助手桌面原语：截屏 + 键鼠注入（Windows 先行）
// 坐标一律使用物理像素；模块内保证进程 DPI 感知。
//
// 全异步化（防崩溃体系）：全部阻塞性导出为 async fn，函数体经 blocking() 包进
// tokio spawn_blocking——① Node 事件循环不再被截屏/UIA/长输入阻塞（假死消除）；
// ② 闭包内 panic 被 tokio 捕获成 JoinError → napi Error，从机制上杜绝
// "Rust panic 跨 FFI unwind → 进程 abort"整类硬崩溃。
// 例外（保持同步）：set_protected_extra_pids / debug_protection——纯内存操作，亚毫秒级。

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result};
use napi_derive::napi;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

mod protect;
mod uia;

#[cfg(target_os = "windows")]
use std::sync::Once;

/// 阻塞执行统一入口：spawn_blocking + JoinError→napi Error（panic 被 tokio 捕获，进程安全）
pub(crate) async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    napi::tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::from_reason(format!("原生任务执行异常（panic 已被隔离，进程安全）: {e}")))?
}

// ---------- DPI 感知（只设置一次） ----------

#[cfg(target_os = "windows")]
pub(crate) fn ensure_dpi_awareness() {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe {
        // PER_MONITOR_AWARE_V2：GetSystemMetrics/截图/坐标均为物理像素
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    });
}

#[cfg(not(target_os = "windows"))]
fn ensure_dpi_awareness() {}

fn err<E: std::fmt::Display>(e: E) -> Error {
    Error::from_reason(format!("{e}"))
}

// 每次调用新建 Enigo（MVP，构造很轻）
fn new_enigo() -> Result<Enigo> {
    ensure_dpi_awareness();
    Enigo::new(&Settings::default()).map_err(err)
}

// ---------- 显示器信息与截屏 ----------

#[napi(object)]
pub struct DisplayInfo {
    pub index: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 原生 DPI 缩放比（如 150% → 1.5）。纯信息性，不参与坐标换算——
    /// 图像↔物理换算由消费方用 width/phys_width 现派生（契约只运输实测事实）
    pub dpi_scale: f64,
    pub is_primary: bool,
}

#[napi(object)]
pub struct CaptureResult {
    pub png: Buffer,
    /// 缩放后（PNG 实际）宽度
    pub width: u32,
    /// 缩放后（PNG 实际）高度
    pub height: u32,
    /// 原生 DPI 缩放比（纯信息性，不参与坐标换算；换算比 = width/phys_width 现派生）
    pub dpi_scale: f64,
    pub origin_x: i32,
    pub origin_y: i32,
    /// 原始物理宽度
    pub phys_width: u32,
    /// 原始物理高度
    pub phys_height: u32,
}

#[napi]
pub async fn list_displays() -> Result<Vec<DisplayInfo>> {
    blocking(|| {
        ensure_dpi_awareness();
        let monitors = xcap::Monitor::all().map_err(err)?;
        let mut out = Vec::with_capacity(monitors.len());
        for (i, m) in monitors.iter().enumerate() {
            out.push(DisplayInfo {
                index: i as u32,
                name: m.name().map_err(err)?,
                x: m.x().map_err(err)?,
                y: m.y().map_err(err)?,
                width: m.width().map_err(err)?,
                height: m.height().map_err(err)?,
                dpi_scale: m.scale_factor().map_err(err)? as f64,
                is_primary: m.is_primary().map_err(err)?,
            });
        }
        Ok(out)
    })
    .await
}

/// 区域裁剪框（region zoom）。坐标为**虚拟桌面物理像素**（多显示器环境下原点可为负），
/// 与 core 侧约定一致：裁剪时先减去显示器原点换算成局部坐标，越界部分 clamp 到显示器范围。
#[napi(object)]
pub struct CropRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// capture_display 的阻塞段返回体（纯数据，Send 安全；Buffer 在 await 之后构造）
struct CaptureRaw {
    png: Vec<u8>,
    width: u32,
    height: u32,
    dpi_scale: f64,
    origin_x: i32,
    origin_y: i32,
    phys_width: u32,
    phys_height: u32,
}

fn capture_display_impl(index: u32, max_long_edge: u32, crop: Option<CropRect>) -> Result<CaptureRaw> {
    ensure_dpi_awareness();
    let monitors = xcap::Monitor::all().map_err(err)?;
    let monitor = monitors
        .get(index as usize)
        .ok_or_else(|| Error::from_reason(format!("显示器索引越界: {index}")))?;

    // xcap 0.4.1 Windows 端 capture_image 内部已做 BGRA→RGBA，返回标准 RgbaImage，无需再转
    let img = monitor.capture_image().map_err(err)?;
    let monitor_x = monitor.x().map_err(err)?;
    let monitor_y = monitor.y().map_err(err)?;
    let dpi_scale = monitor.scale_factor().map_err(err)? as f64;

    // 有 crop 时：clamp 后裁剪，并回写裁剪框的虚拟桌面坐标/物理尺寸；
    // 无 crop 时行为与改造前逐字节一致（整屏 origin + 整屏物理尺寸）
    let (mut img, phys_width, phys_height, origin_x, origin_y) = if let Some(crop) = crop {
        let mon_w = img.width();
        let mon_h = img.height();
        // 虚拟桌面坐标 → 显示器局部坐标（用 i64 防 i32 溢出）
        let rx = crop.x as i64 - monitor_x as i64;
        let ry = crop.y as i64 - monitor_y as i64;
        let left = rx.clamp(0, mon_w as i64) as u32;
        let top = ry.clamp(0, mon_h as i64) as u32;
        let right = (rx + crop.width as i64).clamp(0, mon_w as i64) as u32;
        let bottom = (ry + crop.height as i64).clamp(0, mon_h as i64) as u32;
        if right <= left || bottom <= top {
            return Err(Error::from_reason(format!(
                "裁剪区域与显示器 {index} 无交集: crop=({},{} {}x{})",
                crop.x, crop.y, crop.width, crop.height
            )));
        }
        let cropped = image::DynamicImage::ImageRgba8(img)
            .crop_imm(left, top, right - left, bottom - top)
            .to_rgba8();
        // 回写：origin = 裁剪框左上角的虚拟桌面物理坐标（非显示器原点），
        // phys_* = 裁剪框物理尺寸（非整屏）
        (
            cropped,
            right - left,
            bottom - top,
            monitor_x + left as i32,
            monitor_y + top as i32,
        )
    } else {
        let w = img.width();
        let h = img.height();
        (img, w, h, monitor_x, monitor_y)
    };

    // 宿主窗口标题栏红斜纹标注（缩放前、本图局部坐标系）
    annotate_host_regions(&mut img, origin_x, origin_y, dpi_scale);

    // 长边超过 max_long_edge 才等比缩放
    let long_edge = phys_width.max(phys_height);
    let img = if max_long_edge > 0 && long_edge > max_long_edge {
        let ratio = max_long_edge as f64 / long_edge as f64;
        let w = ((phys_width as f64 * ratio).round() as u32).max(1);
        let h = ((phys_height as f64 * ratio).round() as u32).max(1);
        image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let width = img.width();
    let height = img.height();

    // PNG 编码
    let mut buf: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(err)?;

    Ok(CaptureRaw {
        png: buf,
        width,
        height,
        dpi_scale,
        origin_x,
        origin_y,
        phys_width,
        phys_height,
    })
}

/// 宿主窗口标题栏红斜纹标注（缩放前、物理像素坐标系）。
/// 只涂标题栏条带（band_px ≈ 标题栏高）——身份传达足矣，内容区零遮挡
///（宿主窗口可正常操作后，"模型阅读 chill 窗口内容"是合法需求）。
/// 窗口矩形是虚拟桌面坐标，逐显示器/裁剪框先换算成本图局部坐标，越界 clamp（跨屏部分覆盖）。
fn annotate_host_regions(img: &mut image::RgbaImage, origin_x: i32, origin_y: i32, dpi_scale: f64) {
    let rects = protect::host_window_rects();
    if rects.is_empty() {
        return;
    }
    let band = ((40.0 * dpi_scale).round() as i64).max(24); // 标题栏条带高（物理像素）
    let (w, h) = (img.width() as i64, img.height() as i64);
    for (l, t, r, b) in rects {
        let left = (l as i64 - origin_x as i64).clamp(0, w) as u32;
        let top = (t as i64 - origin_y as i64).clamp(0, h) as u32;
        let right = (r as i64 - origin_x as i64).clamp(0, w) as u32;
        // 条带底 = min(窗口底, 顶+band)
        let bottom = ((t as i64 + band).min(b as i64) - origin_y as i64).clamp(0, h) as u32;
        if right <= left || bottom <= top {
            continue;
        }
        // 45° 斜纹：(x+y)%16<5 的像素叠半强度红
        for y in top..bottom {
            for x in left..right {
                if (x + y) % 16 < 5 {
                    let p = img.get_pixel_mut(x, y);
                    p[0] = p[0] / 2 + 128;
                    p[1] /= 2;
                    p[2] /= 2;
                }
            }
        }
    }
}

#[napi]
pub async fn capture_display(
    index: u32,
    max_long_edge: u32,
    crop: Option<CropRect>,
) -> Result<CaptureResult> {
    let raw = blocking(move || capture_display_impl(index, max_long_edge, crop)).await?;
    Ok(CaptureResult {
        png: Buffer::from(raw.png),
        width: raw.width,
        height: raw.height,
        dpi_scale: raw.dpi_scale,
        origin_x: raw.origin_x,
        origin_y: raw.origin_y,
        phys_width: raw.phys_width,
        phys_height: raw.phys_height,
    })
}

// ---------- 宿主注入门（封闭敏感集精确拦截；默认放行） ----------
//
// 规则（规划 superboy-falcon-storm）：对宿主的注入默认放行，仅拦截——
// ①命中 HTCLOSE/HTSYSMENU（关闭按钮/标题栏图标）的点击与拖拽起点；②NC 区右键（系统菜单路径）；
// ③前台=宿主时的封闭危险组合键集（protect::is_dangerous_combo）；④审批未决期间对宿主的点击/键入。
// 无法判定命中区域（HT_UNKNOWN）时保守拦截。

/// 审批未决拒绝文案
fn approval_pending_refusal() -> Error {
    Error::from_reason(
        "有审批对话框正等待用户决策，期间对 chill 窗口的点击/键入一律拦截（防止模型自己回答审批）；请等待用户完成审批后重试",
    )
}

/// 鼠标落点门：right_button 标记是否右键（NC 区右键会弹系统菜单——含关闭项）
fn mouse_point_gate(x: i32, y: i32, right_button: bool) -> Result<()> {
    let Some(code) = protect::host_hit_test(x, y) else {
        return Ok(()); // 非宿主：放行
    };
    if protect::approval_pending() {
        return Err(approval_pending_refusal());
    }
    if code == protect::HT_CLOSE {
        return Err(Error::from_reason(
            "目标落点是 chill 宿主窗口的关闭按钮，一律拦截（防宿主被关闭）；如需调整 chill 窗口可拖动标题栏或点最小化",
        ));
    }
    if code == protect::HT_SYSMENU {
        return Err(Error::from_reason(
            "目标落点是 chill 宿主窗口的标题栏图标（双击关窗/单击弹系统菜单含关闭项），一律拦截",
        ));
    }
    if code == protect::HT_HOST_CUSTOM_STRIP {
        return Err(Error::from_reason(
            "目标是 chill 宿主的自绘标题栏（Windows Terminal 类：标签页自带关闭按钮，安全区无法定位），整带拒点；移动窗口请改用其他区域或请用户手动",
        ));
    }
    if code == protect::HT_UNKNOWN {
        return Err(Error::from_reason(
            "无法判定 chill 宿主窗口的目标区域（命中测试超时），保守拦截；请重试或换用元素级动作",
        ));
    }
    if right_button && code != protect::HT_CLIENT {
        return Err(Error::from_reason(
            "在 chill 宿主窗口非客户区右键会弹出系统菜单（含关闭项），一律拦截；客户区右键不受影响",
        ));
    }
    Ok(())
}

/// 键盘门：前台=宿主时，审批未决全拒 + 封闭危险组合键集拒；其余放行
fn keyboard_gate(mods: &[&str], plain: Option<&str>) -> Result<()> {
    if !protect::foreground_is_host() {
        return Ok(());
    }
    if protect::approval_pending() {
        return Err(approval_pending_refusal());
    }
    if protect::is_dangerous_combo(mods, plain) {
        return Err(Error::from_reason(
            "该组合键在 chill 宿主前台可致宿主退出/挂起/冻结/关闭（信号/流控/关闭快捷键/系统菜单路径封闭集），一律拦截；普通文字与其他按键不受影响",
        ));
    }
    Ok(())
}

// ---------- 输入状态 hygiene ----------

/// 尽力释放全部可能卡住的修饰键与鼠标键（批首恢复/异常兜底；对未按下的键发 Release 是无害空操作）
fn release_inputs_safely() {
    if let Ok(mut e) = new_enigo() {
        for k in [Key::Control, Key::Shift, Key::Alt, Key::Meta] {
            let _ = e.key(k, Direction::Release);
        }
        for b in [Button::Left, Button::Right, Button::Middle] {
            let _ = e.button(b, Direction::Release);
        }
    }
}

/// RAII 卡键保险丝：armed 状态下任何路径退出（含 `?` 提前返回与 panic unwind）都会在
/// Drop 里释放全部修饰键与鼠标键；正常完成须 disarm（正常路径已自行释放）
struct ReleaseGuard(bool);
impl ReleaseGuard {
    fn new() -> Self {
        Self(true)
    }
    fn disarm(&mut self) {
        self.0 = false;
    }
}
impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        if self.0 {
            release_inputs_safely();
        }
    }
}

#[napi]
pub async fn release_all_inputs() -> Result<()> {
    blocking(|| {
        release_inputs_safely();
        Ok(())
    })
    .await
}

// ---------- Failsafe 原语 ----------

#[napi(object)]
pub struct Preflight {
    /// 用户物理按下 ESC（GetAsyncKeyState 0x8000 当前态位）
    pub esc_pressed: bool,
    pub cursor_x: i32,
    pub cursor_y: i32,
}

#[napi]
pub async fn preflight() -> Result<Preflight> {
    blocking(|| {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::POINT;
            use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE};
            use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
            let esc = unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } & (0x8000u16 as i16) != 0;
            let mut pt = POINT::default();
            unsafe {
                let _ = GetCursorPos(&mut pt);
            }
            return Ok(Preflight {
                esc_pressed: esc,
                cursor_x: pt.x,
                cursor_y: pt.y,
            });
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Preflight {
                esc_pressed: false,
                cursor_x: 0,
                cursor_y: 0,
            })
        }
    })
    .await
}

/// 兄弟 chill 实例根 PID 注入（core 实例注册表 → shell → 本导出；全量替换语义）
/// 纯内存写，亚微秒级——保持同步导出
#[napi]
pub fn set_protected_extra_pids(pids: Vec<u32>) {
    protect::set_extra_roots(pids);
}

/// 审批挂起状态推送（core 审批聚合器 → shell → 本导出；自审批攻击面封堵的数据源）
/// 纯内存写——保持同步导出
#[napi]
pub fn set_approval_pending(pending: bool) {
    protect::set_approval_pending(pending);
}

/// 实测闸门：保护 PID 集 + 宿主窗口矩形清单（调试用，不进工具链）
/// 窗口枚举亚毫秒级——保持同步导出
#[napi(object)]
pub struct DebugProtection {
    pub pids: Vec<u32>,
    pub host_windows: Vec<String>,
    pub all_windows: Vec<String>,
}

#[napi]
pub fn debug_protection() -> DebugProtection {
    let (pids, host_windows, all_windows) = protect::debug_protection();
    DebugProtection {
        pids,
        host_windows,
        all_windows,
    }
}

/// 诊断：某点的宿主命中测试码（非宿主返回 None；HT_UNKNOWN=i32::MIN 表示超时/失败）
#[napi]
pub fn debug_hit_test(x: i32, y: i32) -> Option<i32> {
    protect::host_hit_test(x, y)
}

/// 诊断：某点命中链路全量信息 [命中窗口pid, 根窗口pid, 是否在保护集, 命中码或-999]
#[cfg(target_os = "windows")]
#[napi]
pub fn debug_probe(x: i32, y: i32) -> Vec<i64> {
    protect::debug_probe(x, y)
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn debug_probe(_x: i32, _y: i32) -> Vec<i64> {
    vec![]
}

// ---------- 窗口管理（window_manage：API 直调，不经像素注入） ----------

/// 窗口管理原语（RPA 式：PAD/UiPath 的 Move/Resize/SetState/Close 对应物）。
/// 操作集封闭：move/resize/set_bounds/minimize/maximize/restore + close（仅非宿主）。
/// 宿主护栏：close 对保护集窗口永拒（与注入门同一 protect.rs 事实源）；强杀永远不进本动作。
#[napi]
pub async fn window_manage(hwnd: i64, op: String, rect: Option<CropRect>) -> Result<()> {
    blocking(move || window_manage_impl(hwnd, &op, rect)).await
}

#[cfg(target_os = "windows")]
fn window_manage_impl(hwnd: i64, op: &str, rect: Option<CropRect>) -> Result<()> {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    ensure_dpi_awareness();
    if hwnd == 0 {
        return Err(Error::from_reason(
            "该元素没有窗口句柄（hwnd=0，Chromium/UWP 渲染树元素常见）：请改用其顶层窗口的 hwnd",
        ));
    }
    let mut hwnd = HWND(std::ptr::with_exposed_provenance_mut(hwnd as usize));
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err(Error::from_reason(format!("无效窗口句柄: {hwnd:?}")));
        }
        // 子句柄归一到顶层窗口（inspect_ui 元素的 hwnd 可能是子窗口）
        let root = GetAncestor(hwnd, GA_ROOT);
        if !root.is_invalid() {
            hwnd = root;
        }
    }
    let is_host = protect::hwnd_is_host(hwnd.0 as i64);

    match op {
        "close" => {
            if is_host {
                return Err(Error::from_reason(
                    "chill 宿主窗口永远不可经 window_manage 关闭（单不变量）；宿主窗口可移动/缩放/最小化",
                ));
            }
            // PostMessage(WM_CLOSE)：与点 X 完全同义（应用可弹保存确认），非强杀
            unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)) }
                .map_err(|e| Error::from_reason(format!("发送关闭消息失败: {e}")))?;
            Ok(())
        }
        "minimize" | "maximize" | "restore" => {
            let cmd = match op {
                "minimize" => SW_MINIMIZE,
                "maximize" => SW_MAXIMIZE,
                _ => SW_RESTORE,
            };
            unsafe {
                let _ = ShowWindow(hwnd, cmd);
            }
            Ok(())
        }
        "move" | "resize" | "set_bounds" => {
            let rect = rect.ok_or_else(|| Error::from_reason(format!("{op} 需要 rect 参数 [x, y, 宽, 高]（图像坐标系，core 已换算物理像素）")))?;
            let (cl, ct, cr, cb) = protect::window_full_rect_of(hwnd.0 as i64)
                .ok_or_else(|| Error::from_reason("无法读取目标窗口当前矩形"))?;
            // move 保尺寸、resize 保位置、set_bounds 四值全用
            let (x, y, w, h) = match op {
                "move" => (rect.x, rect.y, cr - cl, cb - ct),
                "resize" => (cl, ct, rect.width as i32, rect.height as i32),
                _ => (rect.x, rect.y, rect.width as i32, rect.height as i32),
            };
            if op != "move" && (w < 320 || h < 200) {
                return Err(Error::from_reason(format!(
                    "窗口尺寸下限 320×200（物理像素，防呆护栏）：请求 {w}×{h}"
                )));
            }
            // 屏幕交集护栏：变更后矩形与虚拟桌面交集 ≥100×100（防窗口丢到找不回的屏幕外）
            let (vx, vy, vw, vh) = unsafe {
                (
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN),
                    GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    GetSystemMetrics(SM_CYVIRTUALSCREEN),
                )
            };
            let ix = x.max(vx);
            let iy = y.max(vy);
            let ir = (x + w).min(vx + vw);
            let ib = (y + h).min(vy + vh);
            if ir - ix < 100 || ib - iy < 100 {
                return Err(Error::from_reason(format!(
                    "变更后窗口与虚拟桌面的可见交集不足 100×100（防丢屏外护栏）：目标矩形 ({x},{y} {w}×{h})"
                )));
            }
            unsafe {
                // 最大化/最小化状态下 SetWindowPos 不生效——先 restore 确定化
                if IsZoomed(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                }
                SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER)
                    .map_err(|e| Error::from_reason(format!("SetWindowPos 失败: {e}")))?;
            }
            Ok(())
        }
        other => Err(Error::from_reason(format!(
            "未知窗口管理操作: {other}（支持 move/resize/set_bounds/minimize/maximize/restore/close）"
        ))),
    }
}

#[cfg(not(target_os = "windows"))]
fn window_manage_impl(_hwnd: i64, _op: &str, _rect: Option<CropRect>) -> Result<()> {
    Err(Error::from_reason("window_manage 仅支持 Windows"))
}

// ---------- 鼠标 ----------

fn parse_button(button: &str) -> Result<Button> {
    match button.to_ascii_lowercase().as_str() {
        "left" => Ok(Button::Left),
        "right" => Ok(Button::Right),
        "middle" => Ok(Button::Middle),
        other => Err(Error::from_reason(format!("未知鼠标按键: {other}"))),
    }
}

#[napi]
pub async fn mouse_move(x: i32, y: i32) -> Result<()> {
    blocking(move || {
        // mouse_move 纯被动（不改变宿主状态），不做宿主判定
        let mut enigo = new_enigo()?;
        enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)
    })
    .await
}

#[napi]
pub async fn mouse_click(x: i32, y: i32, button: String, count: u32) -> Result<()> {
    blocking(move || {
        let right = button.eq_ignore_ascii_case("right");
        mouse_point_gate(x, y, right)?;
        let button = parse_button(&button)?;
        let count = count.max(1);
        let mut enigo = new_enigo()?;
        enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
        for _ in 0..count {
            enigo.button(button, Direction::Click).map_err(err)?;
        }
        Ok(())
    })
    .await
}

#[napi]
pub async fn mouse_drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32) -> Result<()> {
    blocking(move || {
        // 起点门：HTCLOSE/HTSYSMENU 上按下即拒（press+release=点击）；路径其余点不约束
        // （拖标题栏移动窗口 = 起点 HTCAPTION，放行；落点在关闭按钮上不构成点击）
        mouse_point_gate(from_x, from_y, false)?;
        const STEPS: i32 = 10;
        let mut guard = ReleaseGuard::new(); // Press 后任何失败路径都会在 Drop 释放左键
        let mut enigo = new_enigo()?;
        enigo.move_mouse(from_x, from_y, Coordinate::Abs).map_err(err)?;
        enigo.button(Button::Left, Direction::Press).map_err(err)?;
        // 分步移动，模拟真实拖拽轨迹
        for i in 1..=STEPS {
            let x = from_x + (to_x - from_x) * i / STEPS;
            let y = from_y + (to_y - from_y) * i / STEPS;
            enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        enigo.button(Button::Left, Direction::Release).map_err(err)?;
        guard.disarm();
        Ok(())
    })
    .await
}

#[napi]
pub async fn scroll(x: i32, y: i32, dx: i32, dy: i32) -> Result<()> {
    blocking(move || {
        // 滚动对宿主无害（滚 scrollback 不改变宿主状态），无宿主门
        let mut enigo = new_enigo()?;
        enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
        if dy != 0 {
            enigo.scroll(dy, Axis::Vertical).map_err(err)?;
        }
        if dx != 0 {
            enigo.scroll(dx, Axis::Horizontal).map_err(err)?;
        }
        Ok(())
    })
    .await
}

#[napi]
pub async fn cursor_position() -> Result<Vec<i32>> {
    blocking(|| {
        let enigo = new_enigo()?;
        let (x, y) = enigo.location().map_err(err)?;
        Ok(vec![x, y])
    })
    .await
}

// ---------- 键盘 ----------

#[napi]
pub async fn type_text(text: String) -> Result<()> {
    blocking(move || {
        // 纯文字对宿主放行（往 chill 输入框打字是合法场景）；仅审批未决期间拦截
        if protect::foreground_is_host() && protect::approval_pending() {
            return Err(approval_pending_refusal());
        }
        let mut enigo = new_enigo()?;
        // text() 支持 Unicode，不受当前键盘布局影响
        enigo.text(&text).map_err(err)
    })
    .await
}

// 解析普通键（非修饰键）到 enigo Key
fn parse_plain_key(name: &str) -> Result<Key> {
    let key = match name {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        // 单个字符：字母/数字走 Keycode，其余走 Unicode
        s if s.chars().count() == 1 => {
            let c = s.chars().next().unwrap();
            match c {
                'a'..='z' => Key::Unicode(c),
                '0'..='9' => Key::Unicode(c),
                _ => Key::Unicode(c),
            }
        }
        other => return Err(Error::from_reason(format!("无法识别的按键: {other}"))),
    };
    Ok(key)
}

#[napi]
pub async fn key(combo: String) -> Result<()> {
    blocking(move || {
        let mut modifiers: Vec<Key> = Vec::new();
        let mut mod_names: Vec<&'static str> = Vec::new();
        let mut plain: Option<Key> = None;
        let mut plain_name: Option<String> = None;

        for part in combo.split('+') {
            let name = part.trim().to_ascii_lowercase();
            if name.is_empty() {
                return Err(Error::from_reason(format!("组合键格式错误: {combo}")));
            }
            match name.as_str() {
                "ctrl" | "control" => {
                    modifiers.push(Key::Control);
                    mod_names.push("ctrl");
                }
                "shift" => {
                    modifiers.push(Key::Shift);
                    mod_names.push("shift");
                }
                "alt" => {
                    modifiers.push(Key::Alt);
                    mod_names.push("alt");
                }
                "super" | "meta" | "win" | "cmd" | "command" => {
                    modifiers.push(Key::Meta);
                    mod_names.push("meta");
                }
                _ => {
                    if plain.is_some() {
                        return Err(Error::from_reason(format!(
                            "组合键包含多个普通键: {combo}"
                        )));
                    }
                    plain = Some(parse_plain_key(&name)?);
                    plain_name = Some(name);
                }
            }
        }

        // 宿主键盘门：前台=宿主时，审批未决全拒 + 封闭危险组合键集拒（其余放行）
        keyboard_gate(&mod_names, plain_name.as_deref())?;

        let mut enigo = new_enigo()?;
        let mut guard = ReleaseGuard::new(); // 修饰键按下后任何失败路径都在 Drop 里释放
        // 按下修饰键 → 点按普通键 → 逆序释放修饰键
        for m in &modifiers {
            enigo.key(*m, Direction::Press).map_err(err)?;
        }
        if let Some(k) = plain {
            enigo.key(k, Direction::Click).map_err(err)?;
        } else if modifiers.is_empty() {
            return Err(Error::from_reason(format!("空组合键: {combo}")));
        }
        for m in modifiers.iter().rev() {
            enigo.key(*m, Direction::Release).map_err(err)?;
        }
        guard.disarm();
        Ok(())
    })
    .await
}
