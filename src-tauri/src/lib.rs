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

/// 热键按下：呼出 / 收起快速收词小窗。
/// 小窗惰性创建——Windows 上透明窗体配 visible:false 会被 WebView2 无视（启动即显形），
/// 所以不在配置里预建，首次按热键时再建，之后复用切换显隐。
fn toggle_quick(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("quick-show", ());
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "quick",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("快速收词")
    .inner_size(440.0, 320.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .center()
    .build()
    .map(|w| {
        let _ = w.set_focus();
        // webview 还没加载完，不 emit quick-show；QuickCapture 挂载时会自取剪贴板
    });
}

/// 设置页改热键后由前端调用：全部注销再注册新键；None/空串 = 关闭
#[tauri::command]
fn set_quick_hotkey(app: tauri::AppHandle, accelerator: Option<String>) -> Result<(), String> {
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    let acc = accelerator.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(acc) = acc {
        gs.register(acc).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:immerso.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![set_quick_hotkey])
        .setup(|app| {
            // 默认 Alt+Q；前端起来后会按设置页的保存值重新注册
            let _ = app.global_shortcut().register("alt+q");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
