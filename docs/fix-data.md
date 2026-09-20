# 数据层/同步层修复说明（fix-data）

改动范围：`src/lib/db.ts`、`src/lib/sync.ts`、`tests/sync-time.test.ts`（新增）、`docs/fix-data.md`。
Rust 侧配合项由其他成员负责：schema DEFAULT 改 UTC、新增 `execute_tx` 命令、`read/write_backup_file`
改为自行弹文件对话框（见文末「依赖 Rust 侧的配合项」）。

## B-01 跨时区同步误删（最高优先）

**根因**：`added_at`/`deleted_at`/`reviewed_at` 用 SQLite `datetime('now','localtime')` 存本地时间
字符串，sync 合并（db.ts → sync.ts）按字典序跨设备判定新旧；设备时区不同时顺序颠倒 →
远端较新的删除被本机"更早"的本地时间误判、旧卡回灌、删除误删新词。

**修复**：全链统一为 **UTC 无毫秒 `YYYY-MM-DD HH:MM:SS`**（与 SQLite `datetime('now')` 同格式），
纯字典序比较从此正确：

- `db.ts` 顶部新增并导出 `fmtDbTime(d)`：`d.toISOString().slice(0,19).replace("T"," ")`。
- `deleteCard` 墓碑、`deleteDeck` 的 `deck_removals` 与批量墓碑：删除 SQL 里的
  `datetime('now','localtime')`，改传 `fmtDbTime()` 绑定参数。
- `applyReview`：`reviewed_at` 显式写 `fmtDbTime()`（不再依赖表 DEFAULT localtime）；
  `due`/`last_review` 统一写 `fmtDbTime(c.due)` / `fmtDbTime()`（不再写带 T/毫秒/Z 的 ISO）。
- 读方阈值全部同格式自洽：`getQueue`/`getTodayStats` 的 `c.due <= ?` 阈值 now 改 `fmtDbTime()`；
  `newQuotaLeft`/`getTodayStats.doneToday` 的当日零点从 `datetime('now','localtime','start of day')`
  改 `datetime('now','start of day')`（UTC 当日零点）。
- `sync.ts`：卡片插入的 `added_at COALESCE(?, datetime('now','localtime'))` → `COALESCE(?, ?)`，
  兜底参数传 `fmtDbTime()`；四处跨设备字典序比较加注释说明格式约定，并把比较抽成纯函数
  `timeGte/timeGt/timeLt`（`tests/sync-time.test.ts` 覆盖）。

## B-02 评分非原子 + 双窗口并发覆盖

**根因**：`applyReview` 的 `UPDATE cards` + `INSERT reviews` 两条 autocommit；主窗/小窗共享同一
sqlx 连接池（多连接），并发评分用各自旧快照相互覆盖。

**修复**（三层防御）：

1. **事务**：`db.ts` 新增 `withTx(ops)`，调 Rust 侧新命令 `execute_tx`
   （单连接 `BEGIN IMMEDIATE` → 全部成功 COMMIT / 任一失败 ROLLBACK）。
   `applyReview` 把 UPDATE + INSERT 包进一个 `withTx`。
2. **CAS 防陈旧覆盖**：落库前重读 `SELECT due, last_review, reps, state FROM cards WHERE id = ?`，
   与本窗口最近一次"看到/写入"的快照（模块级 `cardSnapshots`，`getQueue` 登记、`applyReview`
   成功写入后刷新）比对；不一致抛 `Error("STALE_CARD")`（UI 层提示"该卡刚在其他窗口复习过"）。
   - 快照按 **card id** 而非 item 原始字段比较：同窗口的 Again 重现/练习重试会先写入并刷新快照，
     不会把本窗口自己的重试误判为并发冲突。
   - 快照必须存 DB **原始字符串**：`new Date("YYYY-MM-DD HH:MM:SS")` 会被 JS 按本地时区解析
     （丢时区），经 Date 往返的值无法与 DB 精确对齐。
3. **进程内串行锁**：模块级 `reviewQueue` Promise 链，`applyReview` 开头排队、finally 释放，
   同一窗口内评分严格串行（跨窗口靠事务 + CAS 兜底）。

## B-04 mergeIntoLocal 无事务半导入

**修复**（不重写全量逻辑，只给两处高危段加事务边界）：

- **墓碑应用 + 墓碑预过期段**（纯写）：所有 DELETE/INSERT 收集为 `ops[]`，段末一次 `withTx` 提交；
  SELECT 保持实时读取（有读依赖的不进 ops）。
- **复习补插段**（纯 INSERT）：`cardId` 来自循环内实时查询，INSERT 收集 `reviewOps` 循环结束后
  一次 `withTx` 提交；`reviewKeys` 去重仍在 JS 层维护。
- **卡合并主循环**：单条 UPDATE/INSERT 本身原子，保持现状；整体包 try/catch，失败抛出
  含"未完成导入，建议重试"的错误（事务段已回滚，主循环可能残留部分卡 → 重试幂等收敛）。
- 函数头注释写明事务边界。

## B-05 前端兜底

`addCard`：INSERT 卡片带 `ON CONFLICT(word) DO NOTHING`，但查重 SELECT 与 INSERT 之间并发窗口可能
先插入同词 → 现在检查 `rowsAffected === 0` 视为已存在，不抛错，仍补挂词书标签并返回
`"added"/"exists"`（行为与查重一致）。sync.ts 的卡片插入已有 `ON CONFLICT(word) DO NOTHING`，不动。
（Rust migration 把 `cards.word` 建成 NOCASE UNIQUE 后，大小写不同词冲突也会被前端这套
`ON CONFLICT` 自动吸收。）

## B-07 LIKE 通配符未转义

`lookup`（中文释义子串 / 英文前缀 / 包含兜底）与 `getLibrary` 的 `word LIKE ?`：用户输入含
`%` `_` 会扩大匹配。新增 `escapeLike(s)`（转义 `%` `_` `\`），SQL 加 `ESCAPE '\'`。
`instr()` 与精确排序用的原始参数不做转义（非 LIKE 语义）。

## 6. 文件导入/导出签名（配合 Rust 端改造）

`exportData`：`invoke("write_backup_file", { content })`——去掉前端 `path`，对话框/默认文件名由
Rust 弹；返回 null/空串视为取消。
`importData`：`invoke("read_backup_file")` 无参，Rust 弹打开框并返回文件内容；null/空串视为取消。
删除不再使用的 `@tauri-apps/plugin-dialog` 的 `open/save` 导入（全仓仅 sync.ts 用过）。

## 测试

新增 `tests/sync-time.test.ts`（8 个用例）：`fmtDbTime` 的 UTC 规范化与跨时区等价性、
时间比较纯函数语义、null/空串最旧约定、空间格式被本地解析的坑（说明为何快照存原始字符串）。
`npm run build`（tsc + vite）零错误；`npm test` 6 文件 94 用例全绿（原有 fsrs/spell/books/
exercises/useCountUp 均不受影响）。

## 遗留风险与待办

1. **存量旧数据无法完美迁移**：旧库/旧备份里 `added_at`/`deleted_at`/`reviewed_at` 是本地时间
   且无时区标记（旧 ISO 的 due/last_review 带 T/Z，与新"空格"格式直接字典序比较会整体偏大）。
   无法逐条重写（不知道当时时区），新写入数据收敛后即正确。
2. **toCard 的 Date 解析偏斜（需关注）**：`src/lib/fsrs.ts`（不允许改动）用
   `new Date("YYYY-MM-DD HH:MM:SS")`，浏览器按**本地时区**解析。due/last_review 改为 UTC
   空间格式后，FSRS 重建 `elapsed_days`（用真实 now − last_review）会带时区偏斜
   （中国 ≈ 8h，仅影响临近整天边界时的取整，scheduled_days 两端同偏相互抵消）。建议后续在
   toCard 里按 UTC 解析（`new Date(s.replace(" ","T")+"Z")`）彻底消除；本次受范围限制未改 fsrs.ts。
3. **每日额度边界变化**：`newQuotaLeft`/`doneToday` 的"当天"改为 UTC 零点（东八区即早 8:00
   重置），与旧"本地零点"行为不同——为同格式自洽的刻意取舍。
4. **依赖 Rust 侧的配合项**（另一成员实现，前端已按契约对接）：
   - `execute_tx`：`db: String, ops: Vec<(String, Vec<serde_json::Value>)>`，返回
     `Vec<(u64, i64)>` = 每条的 `(rowsAffected, lastInsertId)`。**注意**：IPC 上 `ops` 每项是
     `[sql, params]` **数组**（serde tuple 要求），不是 `{sql, params}` 对象；`withTx` 内部已转换。
   - `read/write_backup_file` 改为自弹对话框、不信任前端 path；null/空串 = 取消。
   - Rust schema 里 `added_at` 等 DEFAULT 改 `datetime('now')`（UTC）。
5. **UI 对 `STALE_CARD` 的提示**：`applyReview` 抛 `Error("STALE_CARD")`，当前 `Review.tsx`
   会把它当普通错误展示（setBug）；"该卡刚在其他窗口复习过，跳过"的友好提示由 UI 侧成员负责，
   不在本次改动范围。