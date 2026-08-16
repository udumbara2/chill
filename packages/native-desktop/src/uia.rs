// UIA（UI Automation）元素级能力：ui_snapshot / ui_invoke / ui_set_value / focus_window
//
// 架构红线：
// 1. 所有 UIA 调用在专用 MTA 工作线程内执行（napi 同步函数跑 Node 主线程，宿主可能已
//    STA 初始化 → RPC_E_CHANGED_MODE）。线程懒启动：首次 UIA 调用才创建（OnceLock）。
// 2. 完全无状态：不跨调用持有任何元素/COM 指针，每次调用自含参数现场解析。
// 3. focus_window 是纯 Win32 调用（不涉及 COM），直接在本线程执行，不走 UIA 线程。

use std::sync::OnceLock;

use napi::{Error, Result};
use napi_derive::napi;

#[napi(object)]
pub struct UiElementInfo {
    /// 快照内编号，从 1 开始
    pub label: u32,
    pub name: String,
    /// 本地化无关的英文控件类型名（ControlType 的 Debug 名）
    pub control_type: String,
    /// bbox，物理像素（进程已 Per-Monitor V2）
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub hwnd: i64,
    /// Vec<i32> 以 "." 连接序列化
    pub runtime_id: String,
    pub has_invoke: bool,
    pub has_value: bool,
    pub has_toggle: bool,
}

// ---------- Windows 实现 ----------

#[cfg(target_os = "windows")]
mod imp {
    use super::UiElementInfo;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::time::{Duration, Instant};

    use uiautomation::controls::ControlType;
    use uiautomation::core::{UICacheRequest, UIElement, UITreeWalker};
    use uiautomation::patterns::{UIPatternType, UIInvokePattern, UITogglePattern, UIValuePattern};
    use uiautomation::types::{Handle, TreeScope, UIProperty};
    use uiautomation::variants::{Value, Variant};
    use uiautomation::UIAutomation;

    type Reply<T> = Sender<std::result::Result<T, String>>;

    pub enum UiaRequest {
        Snapshot { scope: String, reply: Reply<Vec<UiElementInfo>> },
        Invoke { runtime_id: String, reply: Reply<()> },
        SetValue { runtime_id: String, text: String, reply: Reply<()> },
    }

    /// 快照元素总数上限
    const MAX_ELEMENTS: usize = 300;
    /// 抓树总时限（超时返回已收集部分，防不响应应用挂死）
    const SNAPSHOT_BUDGET: Duration = Duration::from_secs(5);
    /// 调用方等待工作线程应答的上限（COM 挂死时兜底）
    const CALL_TIMEOUT: Duration = Duration::from_secs(15);
    /// invoke/set_value 现场解析元素的超时
    const RESOLVE_TIMEOUT: Duration = Duration::from_secs(3);

    /// 可交互控件类型（ControlView 内再按此过滤）
    const INTERACTIVE_TYPES: &[ControlType] = &[
        ControlType::Button,
        ControlType::MenuItem,
        ControlType::Edit,
        ControlType::ComboBox,
        ControlType::CheckBox,
        ControlType::RadioButton,
        ControlType::TabItem,
        ControlType::ListItem,
        ControlType::TreeItem,
        ControlType::Hyperlink,
        ControlType::Document,
        ControlType::Text,
        ControlType::SplitButton,
    ];

    static UIA_TX: super::OnceLock<std::result::Result<Sender<UiaRequest>, String>> =
        super::OnceLock::new();

    fn uia_sender() -> std::result::Result<&'static Sender<UiaRequest>, String> {
        let res = UIA_TX.get_or_init(|| {
            let (tx, rx) = channel::<UiaRequest>();
            match std::thread::Builder::new()
                .name("uia-worker".into())
                .spawn(move || uia_worker(rx))
            {
                Ok(_) => Ok(tx),
                Err(e) => Err(format!("UIA 工作线程启动失败: {e}")),
            }
        });
        res.as_ref().map_err(Clone::clone)
    }

    /// 发请求并等有界超时应答
    pub fn call_uia<T: Send>(
        make: impl FnOnce(Reply<T>) -> UiaRequest,
    ) -> napi::Result<T> {
        let tx = uia_sender().map_err(napi::Error::from_reason)?;
        let (rtx, rrx) = channel();
        tx.send(make(rtx))
            .map_err(|_| napi::Error::from_reason("UIA 工作线程已退出"))?;
        rrx.recv_timeout(CALL_TIMEOUT)
            .map_err(|_| napi::Error::from_reason("UIA 调用超时（目标应用可能无响应）"))?
            .map_err(napi::Error::from_reason)
    }

    fn uia_worker(rx: Receiver<UiaRequest>) {
        // UIAutomation::new() 内部 CoInitializeEx(COINIT_MULTITHREADED)，长期持有
        let automation = match UIAutomation::new() {
            Ok(a) => Some(a),
            Err(e) => {
                eprintln!("UIA 初始化失败: {e}");
                None
            }
        };
        while let Ok(req) = rx.recv() {
            let Some(auto) = &automation else {
                let msg = "UIA 初始化失败，见 stderr".to_string();
                match req {
                    UiaRequest::Snapshot { reply, .. } => {
                        let _ = reply.send(Err(msg));
                    }
                    UiaRequest::Invoke { reply, .. } | UiaRequest::SetValue { reply, .. } => {
                        let _ = reply.send(Err(msg));
                    }
                }
                continue;
            };
            match req {
                UiaRequest::Snapshot { scope, reply } => {
                    let _ = reply.send(do_snapshot(auto, &scope));
                }
                UiaRequest::Invoke { runtime_id, reply } => {
                    let _ = reply.send(do_invoke(auto, &runtime_id));
                }
                UiaRequest::SetValue {
                    runtime_id,
                    text,
                    reply,
                } => {
                    let _ = reply.send(do_set_value(auto, &runtime_id, &text));
                }
            }
        }
    }

    // ---------- 快照 ----------

    fn do_snapshot(
        auto: &UIAutomation,
        scope: &str,
    ) -> std::result::Result<Vec<UiElementInfo>, String> {
        let root = match scope {
            "active_window" => {
                let hwnd = foreground_hwnd_retry().ok_or("没有前台窗口")?;
                auto.element_from_handle(Handle::from(hwnd))
                    .map_err(|e| format!("无法获取前台窗口元素: {e}"))?
            }
            "desktop" => auto
                .get_root_element()
                .map_err(|e| format!("无法获取桌面根元素: {e}"))?,
            other => {
                return Err(format!(
                    "未知 scope: {other}（支持 active_window / desktop）"
                ))
            }
        };

        // Chromium/Electron 类进程树巨大，限深
        let max_depth = if is_chromium_like(&root) { 12 } else { 24 };

        // UICacheRequest 批量缓存：name/control_type/bbox/hwnd + pattern 支持位
        let cache = build_cache_request(auto)?;
        let walker = auto
            .filter_tree_walker(
                auto.get_control_view_condition()
                    .map_err(|e| format!("无法获取 ControlView 条件: {e}"))?,
            )
            .map_err(|e| format!("无法创建树遍历器: {e}"))?;

        let mut out: Vec<UiElementInfo> = Vec::new();
        let deadline = Instant::now() + SNAPSHOT_BUDGET;
        collect(&walker, &cache, &root, 1, max_depth, &mut out, deadline);
        Ok(out)
    }

    /// GetForegroundWindow（NULL 时 100ms×3 重试），返回 hwnd 值
    fn foreground_hwnd_retry() -> Option<isize> {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        for i in 0..3 {
            let hwnd = unsafe { GetForegroundWindow() };
            if !hwnd.is_invalid() {
                return Some(hwnd.0 as isize);
            }
            if i < 2 {
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        None
    }

    fn build_cache_request(
        auto: &UIAutomation,
    ) -> std::result::Result<UICacheRequest, String> {
        let cache = auto
            .create_cache_request()
            .map_err(|e| format!("无法创建缓存请求: {e}"))?;
        cache
            .set_tree_scope(TreeScope::Element)
            .map_err(|e| e.to_string())?;
        for p in [
            UIProperty::Name,
            UIProperty::ControlType,
            UIProperty::BoundingRectangle,
            UIProperty::NativeWindowHandle,
        ] {
            cache.add_property(p).map_err(|e| e.to_string())?;
        }
        for pat in [
            UIPatternType::Invoke,
            UIPatternType::Value,
            UIPatternType::Toggle,
        ] {
            cache.add_pattern(pat).map_err(|e| e.to_string())?;
        }
        Ok(cache)
    }

    /// 递归收集元素（子节点带缓存批量取，本地过滤/限深/截断）
    fn collect(
        walker: &UITreeWalker,
        cache: &UICacheRequest,
        elem: &UIElement,
        depth: u32,
        max_depth: u32,
        out: &mut Vec<UiElementInfo>,
        deadline: Instant,
    ) {
        if out.len() >= MAX_ELEMENTS || Instant::now() >= deadline {
            return;
        }
        let Some(children) = walker.get_children_build_cache(elem, cache) else {
            return;
        };
        for child in &children {
            if out.len() >= MAX_ELEMENTS || Instant::now() >= deadline {
                return;
            }
            let Ok(ct) = child.get_cached_control_type() else {
                continue; // 无法分类则跳过该元素（仍不递归，缓存属性都读不到说明元素异常）
            };
            let has_invoke = child.get_cached_pattern::<UIInvokePattern>().is_ok();
            let has_value = child.get_cached_pattern::<UIValuePattern>().is_ok();
            let has_toggle = child.get_cached_pattern::<UITogglePattern>().is_ok();
            // 只收可交互类型；容器类（Pane/Group 等）有可用 pattern 才收
            let keep =
                INTERACTIVE_TYPES.contains(&ct) || has_invoke || has_value || has_toggle;
            if keep {
                let name = child.get_cached_name().unwrap_or_default();
                let (x, y, width, height) = child
                    .get_cached_bounding_rectangle()
                    .map(|r| (r.get_left(), r.get_top(), r.get_width(), r.get_height()))
                    .unwrap_or((0, 0, 0, 0));
                let hwnd: i64 = child
                    .get_cached_native_window_handle()
                    .map(|h| Into::<isize>::into(h) as i64)
                    .unwrap_or(0);
                // RuntimeId 不可缓存，仅对入选元素现场取（≤ MAX_ELEMENTS 次）
                let runtime_id = child
                    .get_runtime_id()
                    .map(|ids| {
                        ids.iter()
                            .map(|i| i.to_string())
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                out.push(UiElementInfo {
                    label: (out.len() + 1) as u32,
                    name,
                    control_type: format!("{ct:?}"),
                    x,
                    y,
                    width,
                    height,
                    hwnd,
                    runtime_id,
                    has_invoke,
                    has_value,
                    has_toggle,
                });
            }
            if depth < max_depth {
                collect(walker, cache, child, depth + 1, max_depth, out, deadline);
            }
        }
    }

    /// Chromium/Electron 系判定：窗口类名 Chrome_WidgetWin，或进程名在已知清单
    fn is_chromium_like(root: &UIElement) -> bool {
        if let Ok(cls) = root.get_classname() {
            if cls.contains("Chrome_WidgetWin") {
                return true;
            }
        }
        if let Ok(pid) = root.get_process_id() {
            if let Some(name) = process_exe_name(pid as u32) {
                return matches!(
                    name.to_ascii_lowercase().as_str(),
                    "msedge.exe" | "chrome.exe" | "wechat.exe" | "weixin.exe" | "wxwork.exe"
                );
            }
        }
        false
    }

    fn process_exe_name(pid: u32) -> Option<String> {
        use windows::core::PWSTR;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 260];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                h,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .is_ok();
            let _ = windows::Win32::Foundation::CloseHandle(h);
            if !ok {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            Some(
                path.rsplit(['\\', '/'])
                    .next()
                    .unwrap_or_default()
                    .to_string(),
            )
        }
    }

    // ---------- 单元素操作（现场解析） ----------

    fn parse_runtime_id(s: &str) -> std::result::Result<Vec<i32>, String> {
        s.split('.')
            .map(|p| p.parse::<i32>().map_err(|_| format!("runtime_id 格式错误: {s}")))
            .collect()
    }

    /// root 起按 RuntimeIdProperty 现场重新解析（3s 超时）
    fn resolve_by_runtime_id(
        auto: &UIAutomation,
        runtime_id: &str,
    ) -> std::result::Result<UIElement, String> {
        let ids = parse_runtime_id(runtime_id)?;
        let root = auto
            .get_root_element()
            .map_err(|e| format!("无法获取桌面根元素: {e}"))?;
        let cond = auto
            .create_property_condition(
                UIProperty::RuntimeId,
                Variant::from(Value::ArrayI4(ids)),
                None,
            )
            .map_err(|e| format!("无法构造 RuntimeId 条件: {e}"))?;
        let deadline = Instant::now() + RESOLVE_TIMEOUT;
        loop {
            match root.find_first(TreeScope::Subtree, &cond) {
                Ok(e) => return Ok(e),
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(_) => return Err("元素已失效，请重新 inspect_ui".to_string()),
            }
        }
    }

    fn do_invoke(auto: &UIAutomation, runtime_id: &str) -> std::result::Result<(), String> {
        let elem = resolve_by_runtime_id(auto, runtime_id)?;
        let pat: UIInvokePattern = elem
            .get_pattern()
            .map_err(|_| "该元素不支持 Invoke".to_string())?;
        pat.invoke().map_err(|e| format!("Invoke 失败: {e}"))
    }

    fn do_set_value(
        auto: &UIAutomation,
        runtime_id: &str,
        text: &str,
    ) -> std::result::Result<(), String> {
        let elem = resolve_by_runtime_id(auto, runtime_id)?;
        let pat: UIValuePattern = elem
            .get_pattern()
            .map_err(|_| "该元素不支持 Value".to_string())?;
        pat.set_value(text).map_err(|e| format!("SetValue 失败: {e}"))
    }
}

// ---------- napi 导出 ----------

#[cfg(target_os = "windows")]
#[napi]
pub fn ui_snapshot(scope: String) -> Result<Vec<UiElementInfo>> {
    imp::call_uia(|reply| imp::UiaRequest::Snapshot { scope, reply })
}

#[cfg(target_os = "windows")]
#[napi]
pub fn ui_invoke(runtime_id: String) -> Result<()> {
    imp::call_uia(|reply| imp::UiaRequest::Invoke { runtime_id, reply })
}

#[cfg(target_os = "windows")]
#[napi]
pub fn ui_set_value(runtime_id: String, text: String) -> Result<()> {
    imp::call_uia(|reply| imp::UiaRequest::SetValue {
        runtime_id,
        text,
        reply,
    })
}

/// 焦点配方：IsIconic→SW_RESTORE → AllowSetForegroundWindow → AttachThreadInput
/// 双线程 → SetForegroundWindow/BringWindowToTop/SetWindowPos → 逆序 detach（RAII）→
/// GetForegroundWindow 回读验证（100ms×3）
#[cfg(target_os = "windows")]
#[napi]
pub fn focus_window(hwnd: i64) -> Result<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, GetForegroundWindow,
        GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow, SetWindowPos,
        ShowWindow, ASFW_ANY, HWND_TOP, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
    };

    // RAII guard：逆序 detach
    struct AttachGuard(Vec<(u32, u32)>);
    impl AttachGuard {
        /// 附加当前线程到目标线程；失败（如提权窗口 Access Denied）跳过仍继续
        fn attach(&mut self, from: u32, to: u32) {
            if from != to && unsafe { AttachThreadInput(from, to, true) }.as_bool() {
                self.0.push((from, to));
            }
        }
    }
    impl Drop for AttachGuard {
        fn drop(&mut self) {
            for &(a, b) in self.0.iter().rev() {
                unsafe {
                    let _ = AttachThreadInput(a, b, false);
                }
            }
        }
    }

    let hwnd = HWND(std::ptr::with_exposed_provenance_mut(hwnd as usize));
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err(Error::from_reason(format!("无效窗口句柄: {hwnd:?}")));
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = AllowSetForegroundWindow(ASFW_ANY);

        let fg = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(fg, None);
        let target_thread = GetWindowThreadProcessId(hwnd, None);
        let current = GetCurrentThreadId();

        let mut guard = AttachGuard(Vec::new());
        guard.attach(current, fg_thread);
        guard.attach(current, target_thread);

        let _ = SetForegroundWindow(hwnd);
        let _ = BringWindowToTop(hwnd);
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        // guard 在此 drop（逆序 detach）
    }

    // 回读验证（100ms×3 重试包络）
    for _ in 0..3 {
        let fg = unsafe { GetForegroundWindow() };
        if fg == hwnd {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(Error::from_reason("无法将目标窗口置前"))
}

// ---------- 非 Windows 桩 ----------

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn ui_snapshot(_scope: String) -> Result<Vec<UiElementInfo>> {
    Err(Error::from_reason("UIA 仅支持 Windows"))
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn ui_invoke(_runtime_id: String) -> Result<()> {
    Err(Error::from_reason("UIA 仅支持 Windows"))
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn ui_set_value(_runtime_id: String, _text: String) -> Result<()> {
    Err(Error::from_reason("UIA 仅支持 Windows"))
}

#[cfg(not(target_os = "windows"))]
#[napi]
pub fn focus_window(_hwnd: i64) -> Result<()> {
    Err(Error::from_reason("focus_window 仅支持 Windows"))
}
