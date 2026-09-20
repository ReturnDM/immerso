use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg(target_os = "macos")]
mod quick_panel;

const CORE_SCHEMA: &str = r#"
-- 全库时间统一 UTC，格式 YYYY-MM-DD HH:MM:SS（与前端 fmtDbTime() 读取格式一致）。
-- 历史版本 DEFAULT (datetime('now','localtime')) 存在时区歧义（B-03 附带修正），
-- 仅影响新装用户建表；存量库由前端显式传值兜底，无需重建。
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL COLLATE NOCASE UNIQUE,
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
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
        Migration {
            version: 8,
            description: "cards_word_case_insensitive_unique",
            // cards.word 原为大小写敏感的 UNIQUE：'Apple'/'apple' 能同时入书（B-05），
            // 与全库 COLLATE NOCASE 查询语义不一致。重建为 word COLLATE NOCASE UNIQUE；
            // 存量大小写重复行借 INSERT OR IGNORE（ORDER BY id 保留先插的那条）收敛。
            //
            // 迁移执行方式（与 v7 同模式已验证）：sqlx Migrator 对 sqlite 每个迁移在
            // 单个事务里执行全部语句（插件构造 SqlxMigration 时 no_transaction=false），
            // SQLite 的 DDL（CREATE/DROP/ALTER）支持事务内执行；v7 已用同样的
            // CREATE+INSERT+DROP+RENAME 组合跑通。
            //
            // 外键风险：reviews.card_id REFERENCES cards(id)。本应用连接从未开启
            // PRAGMA foreign_keys（插件 path_mapper 连接串不带该参数），DROP TABLE 不受
            // 外键约束阻碍；若未来某处开启 foreign_keys，此迁移需要在关闭外键状态下执行。
            sql: r#"
CREATE TABLE cards_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL COLLATE NOCASE UNIQUE,
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
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  deck TEXT NOT NULL DEFAULT '生词本'
);
INSERT OR IGNORE INTO cards_new (id, word, source_id, stability, difficulty, due, last_review, state, step, reps, lapses, suspended, added_at, deck)
  SELECT id, word, source_id, stability, difficulty, due, last_review, state, step, reps, lapses, suspended, added_at, deck
  FROM cards ORDER BY id;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);
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
pub(crate) fn toggle_quick(app: &tauri::AppHandle) {
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || toggle_quick_on_main(&handle)) {
        eprintln!("呼出快速收词失败: {e}");
    }
}

fn toggle_quick_on_main(app: &tauri::AppHandle) {
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
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window("quick") {
            show_quick(&handle, &w);
        } else {
            build_quick(&handle);
        }
    }) {
        eprintln!("呼出快速收词失败: {e}");
    }
}

/// 小窗取走暂存的整句（无则返回 null，小窗回落读剪贴板）
#[tauri::command]
fn take_quick_payload() -> Option<String> {
    QUICK_PAYLOAD.lock().ok().and_then(|mut g| g.take())
}

/// 小窗落在鼠标所在屏居中。NSWindow.center 只认主屏，多屏或全屏 App 在副屏时
/// 小窗会跑到别的屏幕去；拿不到鼠标位置时回落 center()
fn center_quick_on_cursor(app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    use tauri::PhysicalPosition;
    let centered = (|| -> Option<()> {
        let cursor = app.cursor_position().ok()?;
        let mon = w.monitor_from_point(cursor.x, cursor.y).ok()??;
        let ws = w.outer_size().ok()?;
        let (mp, ms) = (mon.position(), mon.size());
        let pos = PhysicalPosition::new(
            mp.x + (ms.width as i32 - ws.width as i32).max(0) / 2,
            mp.y + (ms.height as i32 - ws.height as i32).max(0) / 2,
        );
        w.set_position(pos).ok()?;
        Some(())
    })();
    if centered.is_none() {
        let _ = w.center();
    }
}

fn show_quick(app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    center_quick_on_cursor(app, w);
    #[cfg(target_os = "macos")]
    if let Err(e) = quick_panel::show(w) {
        eprintln!("显示快速收词面板失败: {e}");
        return;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = w.show();
        let _ = w.set_focus();
    }
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
    // macOS 先配置成非激活面板再显示，避免首次创建时普通窗口抢走全屏 Space。
    // Windows 保留创建即显示，避免 WebView2 透明窗口忽略 visible:false 的问题。
    #[cfg(target_os = "macos")]
    let builder = builder.visible(false).focused(false);
    match builder.build() {
        Ok(w) => show_quick(app, &w),
        Err(e) => eprintln!("创建快速收词窗口失败: {e}"),
    }
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

/// 剪贴板版本号：macOS 为 NSPasteboard.changeCount，Windows 为 GetClipboardSequenceNumber。
/// 模拟 ⌘C 后序号不变 = 目标应用没把选区写进剪贴板（未响应/无选区/权限被拒），
/// 此时读到的只会是用户旧剪贴板——不判定就会把无关内容当成选中的词收进词书
#[cfg(target_os = "macos")]
fn clipboard_seq() -> usize {
    use objc2_app_kit::NSPasteboard;
    NSPasteboard::generalPasteboard().changeCount().max(0) as usize
}

#[cfg(target_os = "windows")]
fn clipboard_seq() -> usize {
    #[link(name = "user32")]
    extern "C" {
        fn GetClipboardSequenceNumber() -> u32;
    }
    unsafe { GetClipboardSequenceNumber() as u32 as usize }
}

/// 其余平台拿不到序号：视为「已变化」，退回固定等待后读取的老行为
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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

        // RAII：修饰键按下后立即构造，保证后续任何错误路径（Click 失败、等待超时、
        // 读剪贴板失败 → 提前 return）都会在 Drop 中执行 Release，
        // 杜绝 Ctrl/⌘ 卡死的全局键盘锁死（B-03）。Release 失败只记日志，不 panic
        struct ModifierGuard<'a> {
            enigo: &'a mut Enigo,
            key: Key,
        }
        impl Drop for ModifierGuard<'_> {
            fn drop(&mut self) {
                if let Err(e) = self.enigo.key(self.key, Direction::Release) {
                    eprintln!("修饰键释放失败: {e}");
                }
            }
        }

        // macOS/Windows 都能查剪贴板序号；其余平台退回内容比对
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let seq_supported = true;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let seq_supported = false;

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
        let guard = ModifierGuard {
            enigo: &mut enigo,
            key: modifier,
        };
        // 后续按键操作一律经 guard 的 enigo 引用，确保 guard 持有该可变借用直到函数结束
        guard
            .enigo
            .key(copy, Direction::Click)
            .map_err(|e| e.to_string())?;

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
                // 拿不到序号的平台（如 Linux）：以「读到的文本与旧剪贴板不同」为准。
                // 盲区：选中文本恰好与旧剪贴板相同时无法与「复制失败」区分，按没读到处理
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

/// 内置词典是否需要从资源目录重新释放到数据目录：
/// 大小不同 → 需要；大小相同但前 4096 字节不同（同体积重打包的新版）→ 也需要。
/// target 不存在时视为需要释放（metadata 取 0 vs res 的 len 必然不同）。
fn dict_needs_copy(res: &std::path::Path, target: &std::path::Path) -> bool {
    use std::io::Read;
    let sz_res = std::fs::metadata(res).map(|m| m.len()).unwrap_or(0);
    let sz_tgt = std::fs::metadata(target).map(|m| m.len()).unwrap_or(0);
    if sz_res != sz_tgt {
        return true;
    }
    // 大小一致时对比文件头；任一读取失败视为需要重新释放（保守）
    let mut head_res = [0u8; 4096];
    let mut head_tgt = [0u8; 4096];
    let n_res = std::fs::File::open(res)
        .and_then(|mut f| f.read(&mut head_res))
        .unwrap_or(0);
    let n_tgt = std::fs::File::open(target)
        .and_then(|mut f| f.read(&mut head_tgt))
        .unwrap_or(0);
    n_res != n_tgt || head_res != head_tgt
}

/// 今天的 YYYYMMDD 串（导出备份的默认文件名用）。
/// 不引 chrono 依赖，用 Hinnant 的 civil_from_days 算法从 unix 秒换算，
/// 取 UTC 日近似即可（仅作默认文件名，时区差一天不影响功能）
fn today_yyyymmdd() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let z = secs / 86400 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}")
}

/// 导出备份。Rust 侧弹保存对话框并直写文件，不信任前端传的任何路径
/// （旧实现收前端 path 直接 std::fs::write，被注入即可覆盖任意文件，绕过 fs 权限收窄）。
///
/// 契约（前端据此适配，见 docs/fix-rust.md）：
/// - Ok("cancelled")：用户在保存对话框点了取消
/// - Ok("ok:<path>")：写入成功，path 为最终落盘路径（扩展名非 .json 已自动补全）
/// - Err(msg)：写入失败
#[tauri::command]
async fn write_backup_file(app: tauri::AppHandle, content: String) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let default_name = format!("immerso-backup-{}.json", today_yyyymmdd());
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("导出备份")
            .set_file_name(default_name)
            .add_filter("JSON 备份", &["json"])
            .blocking_save_file()
            .and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| format!("弹出保存对话框失败: {e}"))?;
    let Some(path) = picked else {
        return Ok("cancelled".to_string()); // 用户取消
    };
    // 用户在对话框里敲的文件名可能没扩展名，补 .json，保证前端按扩展名识别
    let path = if path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
    {
        path
    } else {
        path.with_extension("json")
    };
    std::fs::write(&path, &content).map_err(|e| format!("写入备份失败: {e}"))?;
    Ok(format!("ok:{}", path.display()))
}

/// 读取备份。Rust 侧弹打开对话框再读文件，不信任前端传的任何路径
/// （旧实现收前端 path 直接 std::fs::read_to_string，被注入即可读走任意文件）。
///
/// 契约（前端据此适配）：
/// - Ok("cancelled")：用户在打开对话框点了取消
/// - Ok(内容)：读取成功，返回备份文件全文
/// - Err(msg)：读取失败 / 文件超过 20MB 限制
#[tauri::command]
async fn read_backup_file(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("导入备份")
            .add_filter("JSON 备份", &["json"])
            .blocking_pick_file()
            .and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| format!("弹出打开对话框失败: {e}"))?;
    let Some(path) = picked else {
        return Ok("cancelled".to_string()); // 用户取消
    };
    // 防大文件把进程读爆：> 20MB 直接拒
    let len = std::fs::metadata(&path)
        .map_err(|e| format!("读取文件信息失败: {e}"))?
        .len();
    if len > 20 * 1024 * 1024 {
        return Err(format!("备份文件超过 20MB 限制（{} 字节）", len));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取备份失败: {e}"))
}

/// 事务批量执行：一次调用把多条写语句放进同一 SQLite 事务，全部成功才提交，
/// 任一条失败整体回滚。供前端「导入备份 / 批量写入」等需要原子性的场景使用。
///
/// 为什么不走 tauri-plugin-sql 的 execute？插件内部池不对外公开，无法在其上开事务；
/// 这里自建一条独立连接（单连接池，max_connections=1）直连同一个库文件
/// （app_config_dir/immerso.db，与插件 path_mapper 指向一致）。
///
/// 并发写锁说明：SQLite 默认 journal 模式，本命令与插件连接并存写同一库时可能互相
/// 撞锁，连接串已设 busy_timeout(5s)，撞锁会等待对方释放；若 5s 内拿不到锁返回错误。
/// 前端应避免与插件写命令并发调用本命令（如导入前不并发执行其他写操作）。
///
/// 参数：db 固定接受 "sqlite:immerso.db"（与插件连接串一致，其余一律拒绝）；
/// ops 为 [(sql, params)] 列表，params 中的 null → NULL、string → TEXT、
/// number → REAL、其余（bool/数组/对象）→ 按 serde_json 值直接绑定（同插件
/// wrapper.rs 的绑定语义，json 对象会被存成 JSON 文本）。
///
/// 返回：Vec<(rows_affected, last_insert_rowid)>，与 ops 一一对应；
/// 失败返回 Err(描述)，事务已回滚。
#[tauri::command]
async fn execute_tx(
    app: tauri::AppHandle,
    db: String,
    ops: Vec<(String, Vec<serde_json::Value>)>,
) -> Result<Vec<(u64, i64)>, String> {
    use sqlx::Executor;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    // 与插件同样的连接串才放行，防止路径注入/指向任意库文件
    if db != "sqlite:immerso.db" {
        return Err(format!("不支持的数据库连接串: {db}（仅接受 sqlite:immerso.db）"));
    }
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取应用配置目录失败: {e}"))?;
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(format!("创建应用配置目录失败: {e}"));
    }
    let db_path = dir.join("immerso.db");
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| format!("打开数据库失败: {e}"))?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| format!("获取数据库连接失败: {e}"))?;

    // BEGIN IMMEDIATE：立即拿写锁，避免两个写事务升级锁时的死锁。
    // 显式用 Executor::execute（executor 为 self），避免 Execute::execute 的
    // 生命周期泛型在 tauri command 宏下触发 HRTB 检查失败
    (&mut *conn)
        .execute(sqlx::raw_sql("BEGIN IMMEDIATE"))
        .await
        .map_err(|e| format!("开启事务失败: {e}"))?;

    let mut results = Vec::with_capacity(ops.len());
    for (sql, params) in &ops {
        let mut query = sqlx::query(sql);
        for value in params {
            if value.is_null() {
                query = query.bind(None::<serde_json::Value>);
            } else if value.is_string() {
                query = query.bind(value.as_str().unwrap().to_owned());
            } else if let Some(number) = value.as_number() {
                query = query.bind(number.as_f64().unwrap_or_default());
            } else {
                query = query.bind(value.clone());
            }
        }
        match (&mut *conn).execute(query).await {
            Ok(res) => results.push((res.rows_affected(), res.last_insert_rowid())),
            Err(e) => {
                // 任意一条失败：整个事务回滚后再报错
                let _ = (&mut *conn).execute(sqlx::raw_sql("ROLLBACK")).await;
                return Err(format!("事务执行失败，已回滚: {e}"));
            }
        }
    }

    (&mut *conn)
        .execute(sqlx::raw_sql("COMMIT"))
        .await
        .map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(results)
}

pub(crate) fn window_state_plugin() -> tauri_plugin_window_state::Builder {
    // 临时面板每次跟随鼠标定位；状态恢复的 show/set_focus 会在 NSPanel 配置前激活应用。
    tauri_plugin_window_state::Builder::default().with_denylist(&["quick"])
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
        .plugin(window_state_plugin().build())
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
            read_backup_file,
            execute_tx
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
            #[cfg(target_os = "macos")]
            app.handle().plugin(tauri_nspanel::init())?;

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
            // 内置词典释放：安装包带 resources/dict.db 时拷到数据目录。
            // 判新旧不只看文件大小——大小相同但内容不同的新版（同体积重打包）也须覆盖，
            // 所以「大小不同 OR 前 4096 字节不同」都视为需要重新释放。
            // 不让插件直读资源绝对路径——sqlx 对 Windows 绝对路径连接串解析不可靠。
            let res = app
                .path()
                .resolve("resources/dict.db", tauri::path::BaseDirectory::Resource);
            if let Ok(res) = res {
                if res.exists() {
                    let target = app.path().app_config_dir().map(|p| p.join("dict.db"));
                    if let Ok(target) = target {
                        let stale = dict_needs_copy(&res, &target);
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
