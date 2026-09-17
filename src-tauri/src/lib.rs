use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

const CORE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  source_id INTEGER REFERENCES sources(id),
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  due TEXT,
  last_review TEXT,
  state INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  rating INTEGER NOT NULL,
  state INTEGER,
  stability REAL,
  difficulty REAL,
  due TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id);
CREATE INDEX IF NOT EXISTS idx_reviews_time ON reviews(reviewed_at);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'manual',
  context TEXT,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_core_tables",
            sql: CORE_SCHEMA,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_deck_to_cards",
            sql: "ALTER TABLE cards ADD COLUMN deck TEXT NOT NULL DEFAULT '生词本';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "deck_words_many_to_many",
            sql: r#"
CREATE TABLE IF NOT EXISTS deck_words (
  word TEXT NOT NULL,
  deck TEXT NOT NULL,
  PRIMARY KEY (word, deck)
);
INSERT OR IGNORE INTO deck_words (word, deck) SELECT word, deck FROM cards;
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "tombstones_for_sync_deletion",
            sql: r#"
CREATE TABLE IF NOT EXISTS tombstones (
  word TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "backfill_orphan_deck_tags",
            // 修复存量：历史同步 bug 曾让「删除后重收」的词复活时丢掉全部词书标签，
            // 词卡在却在任何词书里都不可见——按卡的主词书补一张标签兜底
            sql: r#"
INSERT OR IGNORE INTO deck_words (word, deck)
SELECT c.word, c.deck FROM cards c
WHERE NOT EXISTS (SELECT 1 FROM deck_words dw WHERE dw.word = c.word);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "deck_removals_for_book_delete",
            // 整本移除词书的本地记录：同步合并（并集只增不删）据此跳过已移除词书的标签，
            // 防止另一台设备的备份把移掉的书灌回来。只在本机生效，不进备份格式
            sql: r#"
CREATE TABLE IF NOT EXISTS deck_removals (
  deck TEXT PRIMARY KEY,
  removed_at TEXT NOT NULL
);
"#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "deck_words_case_insensitive_pk",
            // (word, deck) 主键原本大小写敏感，与全库 COLLATE NOCASE 的读法不一致：
            // 同词异大小写会插出重复标签（小窗显示「已在：生词本 · 生词本」）。
            // 重建为 word 按 NOCASE 去重，存量重复行借 INSERT OR IGNORE 收敛
            sql: r#"
CREATE TABLE deck_words_ci (
  word TEXT NOT NULL COLLATE NOCASE,
  deck TEXT NOT NULL,
  PRIMARY KEY (word, deck)
);
INSERT OR IGNORE INTO deck_words_ci (word, deck) SELECT word, deck FROM deck_words;
DROP TABLE deck_words;
ALTER TABLE deck_words_ci RENAME TO deck_words;
"#,
            kind: MigrationKind::Up,
        },
    ]
}

/// 唤起主窗（托盘左键/菜单、二次启动实例、macOS Dock 重开共用）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// macOS 辅助功能权限：模拟 ⌘C 读取选区的前提。
/// 没授权时 CGEvent 会被系统直接丢弃且不报错，剪贴板读到的还是用户上一次的内容
/// ——不检查就会把无关的词静默收进词书，所以模拟前必须先判断。
#[cfg(target_os = "macos")]
mod accessibility {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    static PROMPTED: AtomicBool = AtomicBool::new(false);

    pub fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// 弹系统引导框：把本应用加进「辅助功能」列表并给出跳转按钮。
    /// 每次运行只弹一次——已拒绝过的用户系统不会再弹，重复调用只会多一次 XPC 往返
    pub fn prompt_once() {
        if PROMPTED.swap(true, Ordering::SeqCst) {
            return;
        }
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let opts = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
            let _ = AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef());
        }
    }
}

/// 查词小窗热键：呼出 / 收起快速收词小窗。
/// 小窗惰性创建——Windows 上透明窗体配 visible:false 会被 WebView2 无视（启动即显形），
/// 所以不在配置里预建，首次按热键时再建，之后复用切换显隐。
fn toggle_quick(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
        show_quick(app, &w);
        return;
    }
    build_quick(app);
}

/// 划词直加选中整句（≥3 词）时分流给小窗的文本。capture_selected 完成前就把用户
/// 旧剪贴板还原了，小窗再读剪贴板只能读到旧内容——句子只能经这里交接，
/// 由小窗挂载/呼出时经 take_quick_payload 取走（取走即清）
static QUICK_PAYLOAD: Mutex<Option<String>> = Mutex::new(None);

fn stash_quick_payload(text: Option<String>) {
    if let Some(t) = text {
        if let Ok(mut g) = QUICK_PAYLOAD.lock() {
            *g = Some(t);
        }
    }
}

/// 显示（或首次创建）快速收词小窗；划词直加遇到整句时由前端调用，
/// text 为捕获到的选中文本，暂存后由小窗取走填进原句栏
#[tauri::command]
fn open_quick(app: tauri::AppHandle, text: Option<String>) {
    stash_quick_payload(text);
    if let Some(w) = app.get_webview_window("quick") {
        show_quick(&app, &w);
        return;
    }
    build_quick(&app);
}

/// 小窗取走暂存的整句（无则返回 null，小窗回落读剪贴板）
#[tauri::command]
fn take_quick_payload() -> Option<String> {
    QUICK_PAYLOAD.lock().ok().and_then(|mut g| g.take())
}

fn show_quick(_app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    let _ = w.center();
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("quick-show", ());
}

fn build_quick(app: &tauri::AppHandle) {
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "quick",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("快速收词")
    .inner_size(440.0, 320.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .center();
    // 透明窗体：Windows 直支；macOS 需 macos-private-api 特性（Cargo.toml 已开 +
    // tauri.conf.json macOSPrivateApi），小窗圆角卡片才不会露白底
    let builder = builder.transparent(true);
    let _ = builder.build().map(|w| {
        let _ = w.set_focus();
        // webview 还没加载完，不 emit quick-show；QuickCapture 挂载时会自取剪贴板
    });
}

/// 划词直加热键：让主窗口前端执行「读选中 → 直接入书 → 系统通知」
fn direct_capture(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("quick-direct", ());
    }
}

/// 往（已清空的）热键表上挂一组热键；None = 不挂该热键
fn apply_hotkeys(
    app: &tauri::AppHandle,
    direct: Option<&str>,
    popup: Option<&str>,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    if let Some(acc) = popup {
        gs.on_shortcut(acc, |app, _s, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_quick(app);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    if let Some(acc) = direct {
        gs.on_shortcut(acc, |app, _s, event| {
            if event.state() == ShortcutState::Pressed {
                direct_capture(app);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 注册两个热键（None = 关闭该热键）；改键时先全部注销再重挂。
/// 任意一键挂载失败（如被其他程序占用）时回落默认键——注销在前又不兜底，
/// 会留下「两个热键全灭且无提示」的空窗，后台常驻场景等于功能整体失联
fn register_hotkeys(
    app: &tauri::AppHandle,
    direct: Option<&str>,
    popup: Option<&str>,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    match apply_hotkeys(app, direct, popup) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = gs.unregister_all();
            let _ = apply_hotkeys(app, Some("alt+q"), Some("alt+e"));
            Err(e)
        }
    }
}

/// 设置页改热键后由前端调用：同时重挂两个热键；None/空串 = 关闭
#[tauri::command]
fn set_quick_hotkeys(
    app: tauri::AppHandle,
    direct: Option<String>,
    popup: Option<String>,
) -> Result<(), String> {
    let d = direct.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let p = popup.as_deref().map(str::trim).filter(|s| !s.is_empty());
    register_hotkeys(&app, d, p)
}

/// 剪贴板版本号（Windows）。序号不变 = 目标应用没把选区写进剪贴板
/// （未响应/无选区/权限被拒），此时读到的只会是用户旧剪贴板——
/// 不判定就会把无关内容当成选中的词收进词书。
/// macOS 拿 changeCount 需要引入 objc2-app-kit 新依赖（拉不动 crates.io，暂缓），
/// 退回「读到的文本与旧剪贴板不同」判定，见 capture_selected
#[cfg(target_os = "windows")]
fn clipboard_seq() -> usize {
    #[link(name = "user32")]
    extern "C" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    unsafe { GetClipboardSequenceNumber() as usize }
}

#[cfg(not(target_os = "windows"))]
fn clipboard_seq() -> usize {
    0
}

/// 模拟 Ctrl+C（macOS 为 ⌘C）复制当前选中文本并读取；先记旧剪贴板（含图片），
/// 复制完还原，不破坏用户剪贴板
#[tauri::command]
async fn capture_selected(app: tauri::AppHandle) -> Result<String, String> {
    // macOS 没有辅助功能权限时，下面的 ⌘C 会被系统丢掉，剪贴板里剩的是用户上一次复制的内容，
    // 直接返回就会把无关的词收进词书——这里先拦住，并借系统引导框把用户领到设置页
    #[cfg(target_os = "macos")]
    if !accessibility::trusted() {
        let _ = app.run_on_main_thread(accessibility::prompt_once);
        return Err(
            "缺少「辅助功能」权限，读不到选中文本：系统设置 → 隐私与安全性 → 辅助功能，勾选 immerso 后再试"
                .into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        use tauri_plugin_clipboard_manager::ClipboardExt;

        // Windows 能查剪贴板序号；macOS 只能比对内容
        let seq_supported = cfg!(target_os = "windows");

        // 复制前快照：序号（判定复制是否发生）+ 旧内容（文本/图片，事后还原）
        let seq_before = clipboard_seq();
        let old_text = app.clipboard().read_text().ok();
        let old_image = app.clipboard().read_image().ok();

        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let (modifier, copy) = (Key::Meta, Key::Unicode('c'));
        #[cfg(not(target_os = "macos"))]
        let (modifier, copy) = (Key::Control, Key::Unicode('c'));
        enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(copy, Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;

        // 等目标应用把选区写进剪贴板。固定睡 180ms 的老做法在应用响应慢或
        // 忽略 ⌘C 时会把旧剪贴板误当选区；没等到新内容就明确报错，宁可不收也不错收
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(900);
        let mut text: Option<String> = None;
        while text.is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(30));
            if seq_supported {
                // 序号变了才算复制发生（内容与旧剪贴板相同也能识别），变了再稍等
                // 一拍：有的应用分多步写剪贴板格式，立刻读可能读不到
                if clipboard_seq() != seq_before {
                    std::thread::sleep(std::time::Duration::from_millis(40));
                    text = app
                        .clipboard()
                        .read_text()
                        .ok()
                        .filter(|t| !t.is_empty());
                }
            } else {
                // 以「读到的文本与旧剪贴板不同」为准。盲区：选中文本恰好与旧剪贴板
                // 相同时无法与「复制失败」区分，按没读到处理
                match app.clipboard().read_text() {
                    Ok(t) if !t.is_empty() && Some(&t) != old_text.as_ref() => text = Some(t),
                    _ => {}
                }
            }
        }

        // 复制确实发生过后才需要还原（没发生则剪贴板原样未动）
        if text.is_some() || (seq_supported && clipboard_seq() != seq_before) {
            // 图片优先：剪贴板原本是截图等图片时，被文字覆盖就还原不回来了
            if let Some(img) = old_image.as_ref() {
                let _ = app.clipboard().write_image(img);
            } else if let Some(old) = old_text.as_ref() {
                if Some(old) != text.as_ref() {
                    let _ = app.clipboard().write_text(old);
                }
            }
        }

        text.ok_or_else(|| "没读到选中文本（应用可能未响应复制，或选区不是文本）".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 云同步专用 HTTP：body 以原生字符串直达 reqwest。
/// 不走 plugin-http——大备份会被序列化成字节数组 JSON 过 WebView IPC（体积×4、慢），
/// 上传慢于前端超时就会「请求取消但服务端已建 Gist」的死循环。
#[tauri::command]
async fn gist_http(
    method: String,
    url: String,
    token: String,
    body: Option<String>,
) -> Result<(u16, String), String> {
    if !(url.starts_with("https://api.github.com/")
        || url.starts_with("https://gist.githubusercontent.com/"))
    {
        return Err(format!("不允许的请求地址: {url}"));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PATCH" => client.patch(&url),
        "DELETE" => client.delete(&url),
        other => return Err(format!("不支持的方法: {other}")),
    };
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req
        // GitHub API 强制要求 User-Agent，缺失直接 403
        .header("User-Agent", "immerso-sync")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok((status, text))
}

/// 导出备份到用户在保存对话框选定的路径。放 Rust 侧直写文件，
/// 省得为「任意导出路径」给前端 fs 权限开全盘写
#[tauri::command]
fn write_backup_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// 读取用户在打开对话框选定的备份文件
#[tauri::command]
fn read_backup_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须第一个注册：再次点开应用时唤起已在后台运行的实例，而不是开第二个进程
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:immerso.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_quick_hotkeys,
            capture_selected,
            open_quick,
            take_quick_payload,
            gist_http,
            write_backup_file,
            read_backup_file
        ])
        // 关闭主窗 = 缩到托盘后台（热键照常可用）；退出走托盘菜单或 Cmd+Q。
        // 隐藏不走关闭流程，窗口位置/大小在这里显式落盘
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    let _ = window.app_handle().save_window_state(
                        StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED,
                    );
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {

            // 系统托盘：驻留后台的常驻入口
            let show_item = MenuItem::with_id(app, "tray-show", "显示浸词", true, None::<&str>)?;
            let quick_item = MenuItem::with_id(app, "tray-quick", "快速收词", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quick_item, &quit_item])?;
            TrayIconBuilder::with_id("immerso-tray")
                .icon(app.default_window_icon().expect("缺默认图标").clone())
                .tooltip("浸词 · 后台运行中")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => show_main(app),
                    "tray-quick" => toggle_quick(app),
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            // 内置词典释放：安装包带 resources/dict.db 时拷到数据目录（大小不同视为新版覆盖）。
            // 不让插件直读资源绝对路径——sqlx 对 Windows 绝对路径连接串解析不可靠。
            let res = app
                .path()
                .resolve("resources/dict.db", tauri::path::BaseDirectory::Resource);
            if let Ok(res) = res {
                if res.exists() {
                    let target = app.path().app_config_dir().map(|p| p.join("dict.db"));
                    if let Ok(target) = target {
                        let stale = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0)
                            != std::fs::metadata(&res).map(|m| m.len()).unwrap_or(1);
                        if stale {
                            // macOS/全新机器：数据目录首启时还不存在，先建目录再释放
                            if let Some(parent) = target.parent() {
                                if let Err(e) = std::fs::create_dir_all(parent).and_then(|_| std::fs::copy(&res, &target)) {
                                    eprintln!("内置词典释放失败: {e}");
                                }
                            }
                        }
                    }
                }
            }
            // 默认：划词直加 Alt+Q、查词小窗 Alt+E；前端起来后按设置页保存值重挂
            if let Err(e) = register_hotkeys(app.handle(), Some("alt+q"), Some("alt+e")) {
                eprintln!("注册默认热键失败: {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS：主窗收进托盘后再点 Dock 图标（或 Finder 里重新打开），系统只发 Reopen。
            // tao 在没有可见窗口时返回 false 且不代为显示，不处理的话就是「点了没反应」。
            // 判断主窗自身可见性而非 has_visible_windows——小窗可见而主窗隐藏时 Dock 也应唤起主窗
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                let main_hidden = app
                    .get_webview_window("main")
                    .map(|w| !w.is_visible().unwrap_or(true))
                    .unwrap_or(false);
                if main_hidden {
                    show_main(app);
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}
