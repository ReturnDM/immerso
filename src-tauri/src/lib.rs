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
    ]
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

/// 显示（或首次创建）快速收词小窗；划词直加遇到整句时由前端调用，把句子带入原句栏
#[tauri::command]
fn open_quick(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        show_quick(&app, &w);
        return;
    }
    build_quick(&app);
}

fn show_quick(_app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    let _ = w.center();
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("quick-show", ());
}

fn build_quick(app: &tauri::AppHandle) {
    let mut builder = tauri::WebviewWindowBuilder::new(
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
    // transparent() 在 macOS 需 macos-private-api 特性，不开；Mac 上小窗为不透明方角
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.transparent(true);
    }
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

/// 注册两个热键（None = 关闭该热键）；改键时先全部注销再重挂
fn register_hotkeys(
    app: &tauri::AppHandle,
    direct: Option<&str>,
    popup: Option<&str>,
) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
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

/// 模拟 Ctrl+C（macOS 为 ⌘C）复制当前选中文本并读取；先记旧剪贴板，复制完还原，不破坏用户剪贴板
#[tauri::command]
async fn capture_selected(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings};
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let old = app.clipboard().read_text().ok();
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let (modifier, copy) = (Key::Meta, Key::Unicode('c'));
        #[cfg(not(target_os = "macos"))]
        let (modifier, copy) = (Key::Control, Key::Unicode('c'));
        enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(copy, Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(modifier, Direction::Release).map_err(|e| e.to_string())?;
        std::thread::sleep(std::time::Duration::from_millis(180));
        let text = app.clipboard().read_text().map_err(|e| e.to_string())?;
        if let Some(old) = old {
            if old != text {
                let _ = app.clipboard().write_text(&old);
            }
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            open_quick
        ])
        .setup(|app| {
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
                            if let Err(e) = std::fs::copy(&res, &target) {
                                eprintln!("内置词典释放失败: {e}");
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
