// AppKit 必须在主线程运行，因此使用 harness=false 的真实 Tauri 窗口测试。
// 不注册数据库/同步插件，不读写用户词库。
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../src/lib.rs"]
mod application;

/// AppKit 只在应用拿到前台身份后才分配 key window：脚本里跑（进程从未被激活）时
/// `NSApp.keyWindow` 恒为 nil、`isKeyWindow` 恒为 false，和面板实现无关。所以这里问
/// 「焦点窗口是谁」和「焦点窗口能不能收字」，不把 isKeyWindow 当断言依据。
#[cfg(target_os = "macos")]
mod macos {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_app_kit::NSWindow;

    fn ns_app() -> *mut AnyObject {
        let cls = AnyClass::get(c"NSApplication").unwrap();
        unsafe { objc2::msg_send![cls, sharedApplication] }
    }

    pub fn app_is_active() -> bool {
        unsafe { objc2::msg_send![ns_app(), isActive] }
    }

    /// 应用当前的 key window；应用没有前台身份时为 None
    pub fn key_window_is(window: &NSWindow) -> Option<bool> {
        let key: *mut AnyObject = unsafe { objc2::msg_send![ns_app(), keyWindow] };
        if key.is_null() {
            return None;
        }
        let this = window as *const NSWindow as *const ();
        Some(key as *const () == this)
    }

    /// 焦点是不是落在能接收键入的视图上（WKWebView 实现了 NSTextInputClient；
    /// 若面板把 first responder 设成窗口的 contentView，输入会静默失效）
    pub fn first_responder_accepts_text(window: &NSWindow) -> bool {
        let responder: *mut AnyObject = unsafe { objc2::msg_send![window, firstResponder] };
        !responder.is_null()
            && unsafe {
                objc2::msg_send![responder, respondsToSelector: objc2::sel!(insertText:replacementRange:)]
            }
    }
}

#[cfg(target_os = "macos")]
fn main() {
    use objc2_app_kit::{NSWindow, NSWindowStyleMask};
    use tauri::Manager;

    let mut context = tauri::generate_context!(test = true);
    context.config_mut().app.windows[0].visible = false;
    context.config_mut().app.windows[0].focus = false;
    let state_file =
        std::env::temp_dir().join(format!("immerso-quick-test-{}.json", std::process::id()));

    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .plugin(
            application::window_state_plugin()
                .with_filename(state_file.to_string_lossy())
                .skip_initial_state("main")
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("quick-state-regression")
                .on_window_ready(|window| {
                    if window.label() == "quick" {
                        assert!(
                            !window.is_visible().unwrap(),
                            "state restoration must not show the popup before panel configuration"
                        );
                    }
                })
                .build(),
        )
        .build(context)
        .expect("build native test application")
        .run(|app, event| {
            if !matches!(event, tauri::RunEvent::Ready) {
                return;
            }
            // 不让断言穿过 AppKit 的 Objective-C 回调边界，失败时正常返回测试退出码。
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                // 呼出不能改变应用的激活状态：激活会切 Space，把全屏里的用户拽回桌面
                let active_before = macos::app_is_active();
                application::toggle_quick(app);
                assert_eq!(
                    macos::app_is_active(),
                    active_before,
                    "summoning must not activate the app and switch Spaces"
                );

                let quick = app.get_webview_window("quick").expect("quick window");
                let ns = unsafe { &*(quick.ns_window().unwrap() as *const NSWindow) };
                assert!(ns.isVisible(), "first summon must display the window");
                assert!(
                    ns.canBecomeKeyWindow(),
                    "the input must accept keyboard focus"
                );
                assert!(
                    !ns.canBecomeMainWindow(),
                    "the popup must not become an application main window"
                );
                assert!(
                    ns.styleMask()
                        .contains(NSWindowStyleMask::NonactivatingPanel),
                    "keyboard focus must not activate the whole app and switch Spaces"
                );
                assert!(
                    macos::first_responder_accepts_text(ns),
                    "keyboard focus must land on the web view so typing reaches the input"
                );

                application::toggle_quick(app);
                assert!(!ns.isVisible(), "second shortcut must hide the popup");
                application::toggle_quick(app);
                assert!(
                    ns.isVisible(),
                    "third shortcut must reuse and show the popup"
                );
                assert!(
                    macos::first_responder_accepts_text(ns),
                    "reopening must restore keyboard focus to the input"
                );
                if let Some(is_key) = macos::key_window_is(ns) {
                    assert!(is_key, "the popup must hold keyboard focus when shown");
                }
                assert!(
                    !app.get_webview_window("main")
                        .unwrap()
                        .is_visible()
                        .unwrap(),
                    "summoning must preserve the main window's hidden state"
                );
                application::toggle_quick(app);
                let main = app.get_webview_window("main").unwrap();
                main.show().unwrap();
                application::toggle_quick(app);
                assert!(
                    main.is_visible().unwrap(),
                    "summoning must not hide a visible main window"
                );
                application::toggle_quick(app);
                assert!(
                    main.is_visible().unwrap(),
                    "dismissing must preserve a visible main window"
                );
                println!(
                    "quick_window_macos: summon (no activation, focus on web view), hide, reopen passed"
                );
            }));
            app.exit(if result.is_ok() { 0 } else { 1 });
        });
    let _ = std::fs::remove_file(state_file);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("quick_window_macos: skipped on this platform");
}
