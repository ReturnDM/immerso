# fix-rust.md — Rust 后端修复记录（lib.rs）

仅修改 `src-tauri/` 下文件：`src/lib.rs`（主）、`Cargo.toml`（加 sqlx 显式依赖）。
`cargo check` 通过，无 warning。验证方法：代码审查 + `cargo check`（编译期）
+ Python sqlite3 模拟存量库跑 v8 迁移（运行时 SQL 行为）。

---

## 1. [B-03] 划词捕获失败时修饰键永不释放（全局卡键）— 已修

**位置**：`capture_selected`（原 lib.rs:493-495，现约 :553-564）

**根因**：Press / Click / Release 三连击各自 `?` 短路。Click 失败或后续等待/读取
剪贴板出错提前 return 时，Ctrl/⌘ 保持按下，全局键盘卡死。

**修复**：RAII guard。Press 成功后立即构造 `ModifierGuard`，其 `Drop` 无条件执行
Release（失败仅 `eprintln`，不 panic）；后续 Click 及所有可能提前返回的路径
（等待超时、剪贴板读取失败）都经 guard 的 `enigo` 引用操作，guard 存活到闭包
自然结束，保证 Release 一定执行且只执行一次：

```rust
// 定义在 spawn_blocking 闭包内
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
// 用法
enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
let guard = ModifierGuard { enigo: &mut enigo, key: modifier };
guard.enigo.key(copy, Direction::Click).map_err(|e| e.to_string())?;
```

**借用说明**：guard 持有 `&'a mut Enigo`，之后经 `guard.enigo` 访问，原 `enigo`
绑定不再直接使用，无二次可变借用冲突；闭包体内后续只读剪贴板，不碰 enigo。

**遗留**：Release 失败本身仍未解决（enigo 偶发失败），但已从「卡死全局」降级为
「单次外设短暂失效 + stderr 日志」，可接受。

---

## 2. [安全] read/write_backup_file 任意路径读写 — 已修

**位置**：原 lib.rs:589-597（现重写为异步命令）

**根因**：前端传任意 `path` 参数，Rust 直接 `std::fs::write/read_to_string`——
前端被注入即可读走/覆盖任意文件，绕过 capabilities 的 fs 收窄。

**修复**：对话框移到 Rust 侧，前端不再传路径：

- `write_backup_file(app, content)`：Rust 弹保存对话框（`tauri_plugin_dialog` 的
  `DialogExt` + `FileDialogBuilder`），默认文件名 `immerso-backup-YYYYMMDD.json`
  （`today_yyyymmdd()` 用 Hinnant civil_from_days 算法，无需 chrono），过滤 `*.json`。
- `read_backup_file(app)`：Rust 弹打开对话框（JSON 过滤），读入前校验
  `metadata().len() <= 20MB`，防大文件读爆。
- 对话框阻塞调用放 `tauri::async_runtime::spawn_blocking`，不阻塞主线程/js runtime。
- 扩展名非 `.json` 时自动补 `.json`（用户在对话框手输无扩展名文件名的情况）。

**契约（前端需同步适配）**：
- 取消 → 返回 `Ok("cancelled")`（前端据此显示「已取消导出/导入」）
- 写成功 → `Ok("ok:<最终路径>")`（路径含补全扩展名后可拼接或直接展示）
- 读成功 → `Ok(<文件全文>)`
- 失败 → `Err(<中文描述>)`

---

## 3. [schema] 时间 DEFAULT 改 UTC — 已修

**位置**：`CORE_SCHEMA`（lib.rs:9-54）

**改动**：三处 `DEFAULT (datetime('now', 'localtime'))` → `DEFAULT (datetime('now'))`：
- `cards.added_at`
- `reviews.reviewed_at`
- `sources.created_at`

并加注释说明：全库时间统一 UTC `YYYY-MM-DD HH:MM:SS`，与前端 `fmtDbTime()`
读取格式一致。

**影响范围**：只影响新装用户建表（migration v1 用 CORE_SCHEMA）。存量库不重建，
由前端显式传值兜底（另一成员负责），无需 migration。

---

## 4. [B-05] migration v8：cards.word 大小写不敏感唯一 — 已修

**位置**：`migrations()`（lib.rs:56-138 追加 version 8）

**问题**：`cards.word TEXT NOT NULL UNIQUE` 区分大小写，'Apple'/'apple' 能双卡，
而全库查询均 `COLLATE NOCASE`；deck_words 已在 v7 重建为 NOCASE。

**修复**：追加 migration v8，按 v7 已验证的「CREATE 新表 → INSERT OR IGNORE →
DROP → RENAME → 重建索引」模式重建 cards：

```sql
CREATE TABLE cards_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL COLLATE NOCASE UNIQUE,
  source_id INTEGER REFERENCES sources(id),
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  due TEXT, last_review TEXT,
  state INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  deck TEXT NOT NULL DEFAULT '生词本'   -- v2 加的列
);
INSERT OR IGNORE INTO cards_new (id, word, source_id, ...)
  SELECT id, word, source_id, ... FROM cards ORDER BY id;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_cards_state ON cards(state);
```

- `ORDER BY id` 保证 INSERT OR IGNORE 保留**先插**（id 小）的词条，丢弃后插的
  大小写重复行——正是收敛目标。
- `CORE_SCHEMA` 同步为 `word TEXT NOT NULL COLLATE NOCASE UNIQUE`，新装库与
  迁移后状态一致。

**验证（Python sqlite3 模拟存量库执行）**：
- `foreign_keys=OFF`（当前插件连接默认，连接串未开该 pragma）→ v8 完整执行成功；
  存量 `Apple`(id=1) / `apple`(id=2) 收敛为仅 `Apple`，正常词与索引重建完好，
  reviews.card_id 引用保留 ✓
- `foreign_keys=ON` → `DROP TABLE cards` 报 FOREIGN KEY constraint failed ✗

**执行方式确认**：tauri-plugin-sql 构造 `SqlxMigration::new(..., no_transaction=false)`，
sqlx Migrator 对 sqlite 每个 migration 在**单事务**内执行（多语句一次提交）；
v7 已用同样的 CREATE+INSERT+DROP+RENAME 模式在生产跑通，v8 同构。

**遗留风险**：若未来开启 `PRAGMA foreign_keys`（连接串加 `?foreign_keys=true`
或 execute_tx 连接显式开启），v8 的 DROP TABLE 会在**已在跑的库**上失败回滚
（迁移事务内失败 = 该迁移不落库，但不破坏数据）。当前全链路未开启外键，不受影响。
修复办法（如未来需要）：v8 迁移 SQL 头部加 `PRAGMA foreign_keys = OFF;`（sqlx
按分号拆分执行），或先删 reviews 外键引用再重建。已在代码注释中记录。

---

## 5. 新增 execute_tx 事务命令 — 已实现

**位置**：lib.rs（read_backup_file 之后），已注册进 invoke_handler。

**设计**：tauri-plugin-sql 的池 state 未公开，无法在其上开事务；execute_tx
自建**独立单连接事务用池**直连同一库文件（`app_config_dir/immerso.db`，
与插件 path_mapper 指向一致），`max_connections(1)` + `busy_timeout(5s)`：

- 校验 `db == "sqlite:immerso.db"`（与插件连接串一致），其余一律拒绝，防路径注入；
- `BEGIN IMMEDIATE` 立即拿写锁，避免两写事务升级锁死锁；
- 按插件 `wrapper.rs` 同款语义绑定参数：null→NULL、string→TEXT、number→REAL、
  其余（bool/数组/对象）→ 直接 bind serde_json 值（sqlx sqlite 会存成 JSON 文本）；
- 全部成功 `COMMIT`；任一条失败尝试 `ROLLBACK` 后返回 `Err`（已回滚）；
- 返回 `Vec<(u64 rows_affected, i64 last_insert_rowid)>`，与 ops 一一对应。

**实现要点（踩坑）**：sqlx 0.8 中 `raw_sql(...).execute(&mut conn)` 解析到
`Execute::execute`（query 为 self），在 tauri command 宏展开下触发
「Executor 生命周期不满足 HRTB」报错；改为显式 `(&mut *conn).execute(sqlx::raw_sql(...))`
（executor 为 self 的 `Executor::execute`）后编译通过。

**Cargo.toml**：新增 `sqlx = { version = "0.8", features = ["sqlite", "runtime-tokio"] }`
（版本与 lock 中 tauri-plugin-sql 引入的 sqlx 0.8.6 一致，features 对齐插件）。

**遗留风险**：
- **并发写锁**：SQLite 默认 journal 模式，execute_tx 与插件池并存写同一库可能
  SQLITE_BUSY。已设 busy_timeout(5s) 等待对方释放；5s 拿不到锁返回错误。
  前端应避免与插件写命令并发调用 execute_tx（如导入流程内不再并发执行其他写）。
- execute_tx 未显式开启 foreign_keys（与插件一致默认 OFF）。
- gen/schemas 由 tauri build 时自动生成，未手动更新；若桌面 schema 校验报错，
  需跑 `npm run tauri build -- --no-bundle` 重新生成（本轮未执行，成本高）。

---

## 6. [可选][B-14 P3] dict.db 判新旧改进 — 已修（低成本方案）

**位置**：`setup` 中 dict.db 释放逻辑 + 新增 `dict_needs_copy()` 辅助函数。

**改动**：原来只按 `len()` 判新旧——大小相同内容不同（同体积重打包）不会覆盖。
现改为：**大小不同 OR 前 4096 字节不同** → 需要重新释放；读取失败按保守
「需要释放」处理。成本低（一次文件头读取），已做。

---

## 验证结果

- `cd src-tauri; cargo check` → `Finished dev profile`，无 error、无 warning ✓
- v8 迁移模拟（Python sqlite3，见第 4 节）：foreign_keys=OFF 下存量库执行成功、
  大小写收敛正确；foreign_keys=ON 下 DROP 失败（当前不生效，已记录风险）✓
- 语法/类型层面：全部新代码经编译器验证；对话框 API 签名基于本地
  `~/.cargo/registry` 中 tauri-plugin-dialog 2.7.3 / sqlx 0.8.6 / tauri-plugin-sql
  2.4.1 实际源码核对（FileDialogBuilder::blocking_save_file/blocking_pick_file、
  FilePath::into_path、SqliteConnectOptions::busy_timeout、SqliteQueryResult 等）。

## 未做 / 遗留事项

1. **前端调用签名同步**（另一成员负责）：exportData 不再传 path、
   importData 无参；接收 `cancelled` / `ok:<path>` / 内容 / Err。
2. **schema 校验**：未跑 `tauri build` 重新生成 gen/schemas（成本高，跳过）。
3. **execute_tx 前端调用方**：由另一成员在需要原生事务的地方接入。
4. **v8 外键风险**（详见第 4 节遗留风险）：当前无碍，需保持 foreign_keys=OFF。
5. 未做端到端运行时验证（无 GUI 环境）；建议合入后手工过一遍：
   划词失败路径（确认不再卡键）、导出/导入对话框取消与成功、导入 >20MB 文件拒绝。