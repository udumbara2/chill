// 宿主保护集：chill 自身（及兄弟 chill 实例）进程树的窗口是键鼠注入禁区。
//
// 单不变量：任何 SendInput 系注入（点击/拖拽/滚动/按键/文字）永不到达保护集中的
// 任何窗口；唯一例外是 UIA set_value 带外写文本（不经过本模块判定面，见 uia.rs）。
//
// 保护 PID 集五来源并集，现算不缓存（窗口会移动/开关、Electron 子进程会后 spawn；
// Toolhelp32 快照与 EnumWindows 均亚毫秒级，每次判定现取）：
//   a. 自身 PID + 祖先链（覆盖 mintty/conhost/ConPTY 链）
//   b. 后代进程树（Electron renderer/utility 子进程——UIA 元素级判定依赖此来源）
//   c. GetConsoleWindow 属主 PID
//   d. GetConsoleProcessList 同控制台全部 PID（经 expand 覆盖其祖先）
//   e. 兄弟 chill 实例根 PID（JS 侧实例注册表经 set_protected_extra_pids 注入）
//
// 两个判定面各用可靠数据源，严禁混用：
//   点/窗口级：WindowFromPoint/EnumWindows → 顶层窗口属主 PID（窗口属主恒为创建进程）
//   UIA 元素级：元素 ProcessId 属性（严禁用 NativeWindowHandle——Chromium 渲染树元素
//   hwnd 常为 0，判定会落空；元素级判定在 uia.rs 内调用 is_protected_pid）

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// ---------- 审批挂起标志（core 审批聚合器经 shell 推送；自审批攻击面封堵） ----------

static APPROVAL_PENDING: AtomicBool = AtomicBool::new(false);

pub fn set_approval_pending(v: bool) {
    APPROVAL_PENDING.store(v, Ordering::SeqCst);
}

pub fn approval_pending() -> bool {
    APPROVAL_PENDING.load(Ordering::SeqCst)
}

// ---------- 兄弟实例根 PID（JS 注入） ----------

static EXTRA_ROOTS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// JS 侧（core 实例注册表）注入兄弟 chill 实例的根 PID 列表；全量替换语义
pub fn set_extra_roots(pids: Vec<u32>) {
    let mut guard = EXTRA_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    *guard = pids;
}

fn extra_roots() -> Vec<u32> {
    EXTRA_ROOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

// ---------- 命中测试与危险组合键（双判定面共享原语） ----------

/// WM_NCHITTEST 命中码（本模块用到的子集）
pub const HT_CLIENT: i32 = 1;
pub const HT_CAPTION: i32 = 2;
pub const HT_SYSMENU: i32 = 3;
pub const HT_CLOSE: i32 = 20;
/// 自绘标题栏顶部条带（Windows Terminal 类：标签页自带关闭小 X，几何无法定位安全区——整带拒点）
pub const HT_HOST_CUSTOM_STRIP: i32 = 0x7FFF01;
/// 命中测试超时/失败（无法判定区域）——调用方按保守拦截处理
pub const HT_UNKNOWN: i32 = i32::MIN;

/// 危险组合键判定（封闭敏感集；mods 为规范化修饰键名集合，plain 为规范化普通键名）。
/// 精确匹配修饰键组合——ctrl+shift+c（mintty 复制）不等于 ctrl+c，不误伤。
pub fn is_dangerous_combo(mods: &[&str], plain: Option<&str>) -> bool {
    let has = |s: &str| mods.contains(&s);
    let ctrl = has("ctrl");
    let shift = has("shift");
    let alt = has("alt");
    let meta = has("meta");
    let p = plain.unwrap_or("");
    match (ctrl, shift, alt, meta) {
        // 信号类：SIGINT/SIGTSTP/EOF/SIGQUIT；流控冻结：XOFF；关闭快捷键：ctrl+w
        (true, false, false, false) => {
            matches!(p, "c" | "break" | "pause" | "z" | "d" | "\\" | "s" | "w")
        }
        // 关闭快捷键：ctrl+shift+w
        (true, true, false, false) => p == "w",
        // 关闭快捷键 alt+f4；系统菜单键盘路径 alt+space
        (false, false, true, false) => matches!(p, "f4" | "space"),
        _ => false,
    }
}

// ---------- 非 Windows 桩 ----------

#[cfg(not(target_os = "windows"))]
pub fn is_protected_pid(_pid: u32) -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn host_hit_test(_x: i32, _y: i32) -> Option<i32> {
    None
}
#[cfg(not(target_os = "windows"))]
pub fn foreground_is_host() -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn host_window_rects() -> Vec<(i32, i32, i32, i32)> {
    Vec::new()
}
#[cfg(not(target_os = "windows"))]
pub fn debug_protection() -> (Vec<u32>, Vec<String>, Vec<String>) {
    (Vec::new(), Vec::new(), Vec::new())
}

// ---------- Windows 实现 ----------

#[cfg(target_os = "windows")]
mod imp {
    use super::{extra_roots, HashSet};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
    use windows::Win32::System::Console::{GetConsoleProcessList, GetConsoleWindow};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetAncestor, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
        IsWindowVisible, WindowFromPoint, GA_ROOT,
    };

    /// 进程快照：(pid, ppid, exe 名) 列表；失败返回空（降级为只剩自身来源，不放大保护区）
    fn snapshot_processes() -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut pe = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut pe).is_ok() {
                loop {
                    let len = pe
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(pe.szExeFile.len());
                    let exe = String::from_utf16_lossy(&pe.szExeFile[..len]).to_ascii_lowercase();
                    out.push((pe.th32ProcessID, pe.th32ParentProcessID, exe));
                    if Process32NextW(snap, &mut pe).is_err() {
                        break;
                    }
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(snap);
        }
        out
    }

    /// 同控制台 PID 列表（未附加控制台返回空）
    fn console_pids() -> Vec<u32> {
        unsafe {
            // 空切片首调拿所需数量，再分配实调
            let count = GetConsoleProcessList(&mut []);
            if count == 0 {
                return Vec::new();
            }
            let mut buf = vec![0u32; count as usize];
            let got = GetConsoleProcessList(&mut buf);
            buf.truncate(got as usize);
            buf
        }
    }

    /// 从根集合扩展出完整保护集：每根的祖先链 + 后代树。
    /// 后代收编规则（实测教训）：仅收 exe 名与根相同的子进程——Electron/Chromium 的
    /// renderer/utility 子进程与主进程同 exe（元素级判定靠它）；若全量收编后代，
    /// 宿主自己 spawn 的目标应用（如让 agent 打开记事本再操作它）会被误判为宿主。
    fn expand_roots(entries: &[(u32, u32, String)], roots: &[u32]) -> HashSet<u32> {
        let mut parent_of = std::collections::HashMap::new();
        let mut exe_of: std::collections::HashMap<u32, &str> = std::collections::HashMap::new();
        let mut children_of: std::collections::HashMap<u32, Vec<u32>> =
            std::collections::HashMap::new();
        for (pid, ppid, exe) in entries {
            parent_of.insert(*pid, *ppid);
            exe_of.insert(*pid, exe.as_str());
            children_of.entry(*ppid).or_default().push(*pid);
        }
        let mut set: HashSet<u32> = HashSet::new();
        for &root in roots {
            if !set.insert(root) {
                continue;
            }
            // 祖先链（无条件：终端宿主在祖先方向上）
            // 例外剪枝：explorer.exe 是桌面壳不是终端宿主——chill 从桌面/开始菜单启动时
            // 父进程即 explorer，不剪枝会把任务栏/开始菜单误判为宿主（实测教训）
            let mut cur = root;
            for _ in 0..64 {
                match parent_of.get(&cur) {
                    Some(&pp) if pp != 0 && pp != cur => {
                        if exe_of.get(&pp).copied().unwrap_or("") == "explorer.exe" {
                            break; // 到桌面壳即止，不收入保护集
                        }
                        if !set.insert(pp) {
                            break;
                        }
                        cur = pp;
                    }
                    _ => break,
                }
            }
            // 后代树（仅同 exe 名：Electron 同形子进程）
            let root_exe = exe_of.get(&root).copied().unwrap_or("");
            let mut stack = vec![root];
            while let Some(p) = stack.pop() {
                if let Some(kids) = children_of.get(&p) {
                    for &k in kids {
                        if exe_of.get(&k).copied().unwrap_or("") == root_exe && set.insert(k) {
                            stack.push(k);
                        }
                    }
                }
            }
        }
        set
    }

    /// 现算保护 PID 集（五来源并集）
    pub fn protected_pids() -> HashSet<u32> {
        // 坐标一致性红线：一切窗口/命中查询前必须物理像素感知
        // （DWM 扩展边框恒物理、GetWindowRect/WindowFromPoint 随进程感知态——
        // 不统一则 rect 与探针坐标系错配，实测教训）
        crate::ensure_dpi_awareness();
        let entries = snapshot_processes();
        let mut roots: Vec<u32> = vec![unsafe { GetCurrentProcessId() }];
        roots.extend(console_pids());
        roots.extend(extra_roots());
        let mut set = expand_roots(&entries, &roots);

        // GetConsoleWindow 属主 PID（无控制台返回无效句柄，跳过）
        unsafe {
            let hwnd = GetConsoleWindow();
            if !hwnd.is_invalid() {
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid != 0 {
                    set.extend(expand_roots(&entries, &[pid]));
                }
            }
        }
        // 来源 f：终端身份环境变量锚定（实测教训：mintty 下 bash 的 Win32 父进程是已退出的
        // 中间进程，祖先链断裂，纯进程树永远追不到 mintty.exe）。终端模拟器经环境变量
        // 自报身份且子进程天然继承——命中即把该终端全部进程收编（宁多勿漏：同类型其他
        // 终端窗口一并保护，方向安全）。
        let term_program = std::env::var("TERM_PROGRAM")
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        let mut term_exes: Vec<&str> = Vec::new();
        if term_program == "mintty" {
            term_exes.push("mintty.exe");
        }
        if std::env::var("WT_SESSION").is_ok() {
            term_exes.extend(["windowsterminal.exe", "openconsole.exe"]);
        }
        if term_program == "vscode" {
            term_exes.extend(["code.exe", "code-insiders.exe", "code - insiders.exe"]);
        }
        if !term_exes.is_empty() {
            let extra: Vec<u32> = entries
                .iter()
                .filter(|(_, _, exe)| term_exes.contains(&exe.as_str()))
                .map(|(pid, _, _)| *pid)
                .collect();
            set.extend(expand_roots(&entries, &extra));
        }
        set
    }

    fn window_pid(hwnd: HWND) -> u32 {
        let mut pid: u32 = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        pid
    }


    /// 前台判定：当前前台窗口是否属于保护集（key/type 注入前检查）
    pub fn foreground_is_host() -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return false;
            }
            protected_pids().contains(&window_pid(hwnd))
        }
    }

    /// 保护集中全部可见顶层窗口的矩形（虚拟桌面物理坐标：(left, top, right, bottom)）
    pub fn host_window_rects() -> Vec<(i32, i32, i32, i32)> {
        let set = protected_pids();
        enum_visible_windows()
            .into_iter()
            .filter(|(pid, _)| set.contains(pid))
            .map(|(_, rc)| rc)
            .collect()
    }

    /// 窗口矩形取可见边框（DWMWA_EXTENDED_FRAME_BOUNDS），GetWindowRect 兜底。
    /// 实测教训：GetWindowRect 含隐形调整边框（上下左右数像素~十余像素不等），
    /// 直接当可见区域用会把标题栏中点算进 HTTOP 拖拽区，且标注会涂出窗口可见边界。
    fn window_rect(hwnd: HWND) -> (i32, i32, i32, i32) {
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
        unsafe {
            let mut rc = RECT::default();
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut rc as *mut _ as *mut _,
                std::mem::size_of::<RECT>() as u32,
            )
            .is_ok()
            {
                return (rc.left, rc.top, rc.right, rc.bottom);
            }
            let mut rc = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rc);
            (rc.left, rc.top, rc.right, rc.bottom)
        }
    }

    /// 全部可见顶层窗口：(属主 PID, 矩形)——host_window_rects 与诊断共用
    pub fn enum_visible_windows() -> Vec<(u32, (i32, i32, i32, i32))> {
        struct Payload {
            out: Vec<(u32, (i32, i32, i32, i32))>,
        }
        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let payload = &mut *(lparam.0 as *mut Payload);
            if IsWindowVisible(hwnd).as_bool() {
                let pid = window_pid(hwnd);
                payload.out.push((pid, window_rect(hwnd)));
            }
            BOOL(1)
        }
        let mut payload = Payload { out: Vec::new() };
        unsafe {
            let _ = EnumWindows(Some(enum_proc), LPARAM(&mut payload as *mut _ as isize));
        }
        payload.out
    }

    /// 点级宿主命中测试：落点在宿主窗口内返回 Some(WM_NCHITTEST 命中码)，非宿主返回 None。
    /// 命中码发给最深处的实际命中窗口（子控件可自报 HTCLIENT），宿主归属判定走 GA_ROOT 顶层属主。
    /// SendMessageTimeout 100ms + ABORTIFHUNG——目标无响应时返回 HT_UNKNOWN（调用方保守拦截）。
    pub fn host_hit_test(x: i32, y: i32) -> Option<i32> {
        use windows::Win32::Foundation::WPARAM;
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_NCHITTEST,
        };
        unsafe {
            let hwnd = WindowFromPoint(POINT { x, y });
            if hwnd.is_invalid() {
                return None;
            }
            let root = GetAncestor(hwnd, GA_ROOT);
            let top = if root.is_invalid() { hwnd } else { root };
            if !protected_pids().contains(&window_pid(top)) {
                return None;
            }
            // WM_NCHITTEST 的 lParam 为 i16 打包屏幕坐标（常规多屏范围内无损）
            let lp = (((y as i16 as u16) as i32) << 16) | ((x as i16 as u16) as i32);
            let mut result: usize = 0;
            let sent = SendMessageTimeoutW(
                hwnd,
                WM_NCHITTEST,
                WPARAM(0),
                LPARAM(lp as isize),
                SMTO_ABORTIFHUNG,
                100,
                Some(&mut result),
            );
            if sent.0 == 0 {
                return Some(super::HT_UNKNOWN);
            }
            let raw = result as i32;
            // 自绘标题栏兜底（实测：Win11 Notepad / Windows Terminal 全窗报 HTCLIENT，
            // 系统命中测试拿不到关闭按钮）：顶部条带内做几何重分类。
            // WT（CASCADIA 类）标签页自带关闭小 X、安全区无法几何定位 → 整带报
            // HT_HOST_CUSTOM_STRIP（除右上角关闭区外），调用方整带拒点；
            // 其余自绘窗按经典布局近似：右上角关闭区 / 左上角系统菜单区 / 其余按 CAPTION。
            if raw == super::HT_CLIENT || raw == 0 {
                let (l, t, r, _b) = window_rect(top);
                let dpi = windows::Win32::UI::HiDpi::GetDpiForWindow(top) as i32;
                let dpi = if dpi > 0 { dpi } else { 96 };
                let band = 48 * dpi / 96; // 标题栏带高近似
                if y >= t && y < t + band {
                    let close_w = 46 * dpi / 96;
                    let sys_w = 30 * dpi / 96;
                    let cls = window_class_name(top);
                    return Some(if x >= r - close_w {
                        super::HT_CLOSE
                    } else if cls == "CASCADIA_HOSTING_WINDOW_CLASS" {
                        super::HT_HOST_CUSTOM_STRIP
                    } else if x <= l + sys_w {
                        super::HT_SYSMENU
                    } else {
                        super::HT_CAPTION
                    });
                }
            }
            Some(raw)
        }
    }

    /// 窗口类名（自绘标题栏识别用；取不到返回空串）
    fn window_class_name(hwnd: HWND) -> String {
        use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
        unsafe {
            let mut buf = [0u16; 256];
            let n = GetClassNameW(hwnd, &mut buf);
            String::from_utf16_lossy(&buf[..n as usize])
        }
    }

    /// 句柄属主判定（window_manage 的 close 护栏用）
    pub fn hwnd_is_host(hwnd: i64) -> bool {
        let hwnd = HWND(std::ptr::with_exposed_provenance_mut(hwnd as usize));
        if hwnd.is_invalid() {
            return false;
        }
        protected_pids().contains(&window_pid(hwnd))
    }

    /// 窗口完整矩形（GetWindowRect 空间）——SetWindowPos 的写空间；保维读取必须用它，
    /// 否则 DWM 可见矩形（扣了隐形边框）回写会让窗口每轮缩一圈（实测教训）
    pub fn window_full_rect_of(hwnd: i64) -> Option<(i32, i32, i32, i32)> {
        let hwnd = HWND(std::ptr::with_exposed_provenance_mut(hwnd as usize));
        if hwnd.is_invalid() {
            return None;
        }
        unsafe {
            let mut rc = RECT::default();
            let _ = GetWindowRect(hwnd, &mut rc);
            Some((rc.left, rc.top, rc.right, rc.bottom))
        }
    }

    /// 诊断：命中链路全量信息 [命中窗口pid, 根窗口pid, 是否在保护集(0/1), 原始命中码或-999]
    pub fn debug_probe(x: i32, y: i32) -> Vec<i64> {
        use windows::Win32::Foundation::WPARAM;
        use windows::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_NCHITTEST,
        };
        unsafe {
            let hwnd = WindowFromPoint(POINT { x, y });
            if hwnd.is_invalid() {
                return vec![-1, -1, 0, -999];
            }
            let hit_pid = window_pid(hwnd);
            let root = GetAncestor(hwnd, GA_ROOT);
            let top = if root.is_invalid() { hwnd } else { root };
            let root_pid = window_pid(top);
            let prot = if protected_pids().contains(&root_pid) { 1 } else { 0 };
            let lp = (((y as i16 as u16) as i32) << 16) | ((x as i16 as u16) as i32);
            let mut result: usize = 0;
            let sent = SendMessageTimeoutW(
                hwnd,
                WM_NCHITTEST,
                WPARAM(0),
                LPARAM(lp as isize),
                SMTO_ABORTIFHUNG,
                100,
                Some(&mut result),
            );
            let code = if sent.0 == 0 { -999 } else { result as i32 };
            vec![hit_pid as i64, root_pid as i64, prot, code as i64]
        }
    }
}

#[cfg(target_os = "windows")]
pub fn is_protected_pid(pid: u32) -> bool {
    imp::protected_pids().contains(&pid)
}
#[cfg(target_os = "windows")]
pub fn foreground_is_host() -> bool {
    imp::foreground_is_host()
}
#[cfg(target_os = "windows")]
pub fn host_window_rects() -> Vec<(i32, i32, i32, i32)> {
    imp::host_window_rects()
}

/// 点级宿主命中测试包装（非宿主返回 None；命中返回 WM_NCHITTEST 码）
#[cfg(target_os = "windows")]
pub fn host_hit_test(x: i32, y: i32) -> Option<i32> {
    imp::host_hit_test(x, y)
}

/// 诊断包装：[命中pid, 根pid, 是否保护集, 原始命中码或-999]
#[cfg(target_os = "windows")]
pub fn debug_probe(x: i32, y: i32) -> Vec<i64> {
    imp::debug_probe(x, y)
}

/// 窗口句柄是否属保护集（window_manage 的 close 护栏用）
#[cfg(target_os = "windows")]
pub fn hwnd_is_host(hwnd: i64) -> bool {
    imp::hwnd_is_host(hwnd)
}
#[cfg(not(target_os = "windows"))]
pub fn hwnd_is_host(_hwnd: i64) -> bool {
    false
}

/// 窗口完整矩形（GetWindowRect 空间；window_manage 保维读取用）
#[cfg(target_os = "windows")]
pub fn window_full_rect_of(hwnd: i64) -> Option<(i32, i32, i32, i32)> {
    imp::window_full_rect_of(hwnd)
}
#[cfg(not(target_os = "windows"))]
pub fn window_full_rect_of(_hwnd: i64) -> Option<(i32, i32, i32, i32)> {
    None
}

/// 实测闸门用：返回（保护 PID 集, 宿主窗口矩形清单, 全部可见窗口[pids+矩形]）
#[cfg(target_os = "windows")]
pub fn debug_protection() -> (Vec<u32>, Vec<String>, Vec<String>) {
    let pids: Vec<u32> = {
        let mut v: Vec<u32> = imp::protected_pids().into_iter().collect();
        v.sort_unstable();
        v
    };
    let fmt = |(l, t, r, b): &(i32, i32, i32, i32)| {
        format!("({},{})-({},{}) {}x{}", l, t, r, b, r - l, b - t)
    };
    let all: Vec<String> = imp::enum_visible_windows()
        .iter()
        .map(|(pid, rc)| format!("pid={} {}", pid, fmt(rc)))
        .collect();
    let set = imp::protected_pids();
    let wins: Vec<String> = imp::enum_visible_windows()
        .iter()
        .filter(|(pid, _)| set.contains(pid))
        .map(|(pid, rc)| format!("pid={} {}", pid, fmt(rc)))
        .collect();
    (pids, wins, all)
}
