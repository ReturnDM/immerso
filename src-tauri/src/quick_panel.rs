use tauri::Manager;
use tauri_nspanel::{
    tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt,
};

tauri_panel! {
    panel!(QuickCapturePanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true,
            becomes_key_only_if_needed: false,
            hides_on_deactivate: false
        }
    })
}

/// 在主线程调用。普通 NSWindow 的 always_on_top 只解决层级，不能提供
/// Spotlight 式跨全屏输入。保留 Tauri 的 delegate，让前端继续收到失焦事件。
/// 参考：https://github.com/orgs/tauri-apps/discussions/9876
pub(super) fn show(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let panel = match window.app_handle().get_webview_panel(window.label()) {
        Ok(panel) => panel,
        Err(_) => {
            let panel = window.to_panel::<QuickCapturePanel>()?;
            panel.set_style_mask(StyleMask::empty().nonactivating_panel().into());
            panel.set_level(PanelLevel::Floating.value());
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .can_join_all_spaces()
                    .full_screen_auxiliary()
                    .into(),
            );
            panel
        }
    };
    // 不调用 Tauri set_focus：它会 activateIgnoringOtherApps，触发 Space 切换。
    panel.show_and_make_key();
    Ok(())
}
