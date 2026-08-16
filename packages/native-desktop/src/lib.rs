// AI 助手桌面原语：截屏 + 键鼠注入（Windows 先行）
// 坐标一律使用物理像素；模块内保证进程 DPI 感知。

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result};
use napi_derive::napi;

use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

mod uia;

#[cfg(target_os = "windows")]
use std::sync::Once;

// ---------- DPI 感知（只设置一次） ----------

#[cfg(target_os = "windows")]
fn ensure_dpi_awareness() {
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
pub fn list_displays() -> Result<Vec<DisplayInfo>> {
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
}

#[napi]
pub fn capture_display(index: u32, max_long_edge: u32) -> Result<CaptureResult> {
    ensure_dpi_awareness();
    let monitors = xcap::Monitor::all().map_err(err)?;
    let monitor = monitors
        .get(index as usize)
        .ok_or_else(|| Error::from_reason(format!("显示器索引越界: {index}")))?;

    // xcap 0.4.1 Windows 端 capture_image 内部已做 BGRA→RGBA，返回标准 RgbaImage，无需再转
    let img = monitor.capture_image().map_err(err)?;
    let phys_width = img.width();
    let phys_height = img.height();
    let origin_x = monitor.x().map_err(err)?;
    let origin_y = monitor.y().map_err(err)?;
    let dpi_scale = monitor.scale_factor().map_err(err)? as f64;

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

    Ok(CaptureResult {
        png: Buffer::from(buf),
        width,
        height,
        dpi_scale,
        origin_x,
        origin_y,
        phys_width,
        phys_height,
    })
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
pub fn mouse_move(x: i32, y: i32) -> Result<()> {
    let mut enigo = new_enigo()?;
    enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)
}

#[napi]
pub fn mouse_click(x: i32, y: i32, button: String, count: u32) -> Result<()> {
    let button = parse_button(&button)?;
    let count = count.max(1);
    let mut enigo = new_enigo()?;
    enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
    for _ in 0..count {
        enigo.button(button, Direction::Click).map_err(err)?;
    }
    Ok(())
}

#[napi]
pub fn mouse_drag(from_x: i32, from_y: i32, to_x: i32, to_y: i32) -> Result<()> {
    let mut enigo = new_enigo()?;
    enigo.move_mouse(from_x, from_y, Coordinate::Abs).map_err(err)?;
    enigo.button(Button::Left, Direction::Press).map_err(err)?;
    // 分步移动，模拟真实拖拽轨迹
    const STEPS: i32 = 10;
    for i in 1..=STEPS {
        let x = from_x + (to_x - from_x) * i / STEPS;
        let y = from_y + (to_y - from_y) * i / STEPS;
        enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    enigo.button(Button::Left, Direction::Release).map_err(err)
}

#[napi]
pub fn scroll(x: i32, y: i32, dx: i32, dy: i32) -> Result<()> {
    let mut enigo = new_enigo()?;
    enigo.move_mouse(x, y, Coordinate::Abs).map_err(err)?;
    if dy != 0 {
        enigo.scroll(dy, Axis::Vertical).map_err(err)?;
    }
    if dx != 0 {
        enigo.scroll(dx, Axis::Horizontal).map_err(err)?;
    }
    Ok(())
}

#[napi]
pub fn cursor_position() -> Result<Vec<i32>> {
    let enigo = new_enigo()?;
    let (x, y) = enigo.location().map_err(err)?;
    Ok(vec![x, y])
}

// ---------- 键盘 ----------

#[napi]
pub fn type_text(text: String) -> Result<()> {
    let mut enigo = new_enigo()?;
    // text() 支持 Unicode，不受当前键盘布局影响
    enigo.text(&text).map_err(err)
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
pub fn key(combo: String) -> Result<()> {
    let mut modifiers: Vec<Key> = Vec::new();
    let mut plain: Option<Key> = None;

    for part in combo.split('+') {
        let name = part.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(Error::from_reason(format!("组合键格式错误: {combo}")));
        }
        match name.as_str() {
            "ctrl" | "control" => modifiers.push(Key::Control),
            "shift" => modifiers.push(Key::Shift),
            "alt" => modifiers.push(Key::Alt),
            "super" | "meta" | "win" | "cmd" | "command" => modifiers.push(Key::Meta),
            _ => {
                if plain.is_some() {
                    return Err(Error::from_reason(format!(
                        "组合键包含多个普通键: {combo}"
                    )));
                }
                plain = Some(parse_plain_key(&name)?);
            }
        }
    }

    let mut enigo = new_enigo()?;
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
    Ok(())
}
