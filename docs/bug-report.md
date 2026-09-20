# 浸词 immerso 逐行代码审查报告（Bug Hunt）

- 审查对象：`src/lib/*`（db/sync/cloud/fsrs/capture/neath/spell/exercises/books/useCountUp）、`src/views/*`（Review/Settings/Library/Search/Stats/Home）、`src/QuickCapture.tsx`、`src/App.tsx`、`src/TitleBar.tsx`、`src-tauri/src/lib.rs`
- 审查方式：全文件逐行阅读（read），未改动任何代码
- 审查日期：2025-06

---

## 摘要统计

| 严重级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 致命 | 0 | 未发现必然崩溃 / 必然丢数据的常规路径缺陷 |
| P1 高 | 6 | 数据完整性受损（同步误删、无事务半写）、全局输入失效、竞态重复调度 |
| P2 中 | 13 | 逻辑错误（通配符转义、时间格式混用、大小写不一致）、边界与并发问题 |
| P3 低 | 13 | 体验 / 性能 / 防御性编码问题 |
| **合计** | **32** | |

---

## P1 高严重级别

### B-01 同步墓碑跨时区比较：另一台设备的「删除后重收」会被误删（时区错误 / 数据丢失）
- **位置**：`src/lib/sync.ts:134,146,165,219`；根源在 schema —— `src-tauri/src/lib.rs:23`（`added_at DEFAULT (datetime('now','localtime'))`）与 `src/lib/db.ts:515,560`（`deleted_at` 用本地时间）
- **类别**：时区比较错误 / 同步数据丢失
- **详细描述**：`added_at`、`deleted_at` 都是**机器本地时间**字符串（`YYYY-MM-DD HH:MM:SS`），同步合并时跨机器做纯字典序比较（`(local.added_at ?? "") >= t.deleted_at`、`t.deleted_at > localTomb`）。两台设备时区不同（如东八区 vs 西八区）时，同一物理时刻的本地字符串完全不同，「重收晚于删除」的判定会颠倒方向。
- **触发场景**：设备 A（UTC+8）删除词 W（本地 06-10 08:00，即 UTC 00:00）；设备 B（UTC-8）在本地 06-10 07:00（UTC 15:00，**晚于** A 的删除）重新收集 W，其 `added_at` 字符串 `"2025-06-10 07:00"` **小于** A 的 `"2025-06-10 08:00"` → B 端同步时把本地刚收的 W 当「删除前旧卡」删掉，且 tombstone 被更新为较新时间，W 无法被任何后续同步救回（数据永久丢失）。
- **建议修复**：删除/创建时间统一存 UTC（`datetime('now')` 或 JS `toISOString()` 同格式），或在备份格式中带上时区偏移，比较前归一化到同一基准。

### B-02 评分写库非原子 + 双窗口并发评分覆盖：FSRS 状态损坏、复习记录半写（竞态 / 数据安全）
- **位置**：`src/lib/db.ts:390-409`（`applyReview`）
- **类别**：事务缺失 / 并发竞态
- **详细描述**：
  1. `UPDATE cards` 与 `INSERT INTO reviews` 是两条独立 autocommit 语句，无事务包裹：第二条失败（磁盘满/锁超时）时卡状态已更新而复习记录丢失，`doneToday`/`newQuotaLeft`/热力图全部漂移。
  2. 主窗与快速窗口是各自独立打开的 sqlite 连接（`src/lib/db.ts:14-15` 每窗口一次 `Database.load`），窗口 A、B 可同时对同一张卡评分：B 的 `item.card` 是**自己加载时的旧快照**，`applyReview` 会用陈旧 stability/difficulty/reps 覆盖 A 刚写入的新状态 → 同一张卡在同一秒被 FSRS 调度两次，`reps`/`lapses` 虚增、间隔断裂。
- **触发场景**：快速收词小窗与主窗复习页同时打开，或用户在两处顺序复习同一批到期词；`getQueue`（db.ts:355）每窗口各取一份相同队列。
- **建议修复**：`applyReview` 包 `BEGIN…COMMIT`；评分前按 `id` 重读当前行做 CAS（比较 `due`/`reps` 未被他人写过），或引入 per-card 内存/DB 锁（如 `UPDATE … WHERE state = ? AND reps = ?` 校验行数），并级联应用到 `getQueue` 的「同队列双窗领取」。

### B-03 划词捕获：enigo 模拟复制失败时修饰键永不释放，全局键盘卡键（Rust 错误处理）
- **位置**：`src-tauri/src/lib.rs:488-495`
- **类别**：Rust 资源清理 / 系统性输入故障
- **详细描述**：`enigo.key(modifier, Direction::Press)` 成功后，若「按 C / Click / Release」任一步返回 Err，`?` 直接短路返回，Ctrl（Windows）/⌘（macOS）**始终保持按下状态**——之后系统内所有按键都变成带修饰键组合，用户必须手动再按一次修饰键才能恢复。
- **触发场景**：目标应用抢占比按键、窗口失焦、Enigo 驱动报错（驱动不兼容的键盘/输入法）。
- **建议修复**：用 RAII guard（Drop 内确保 Release），或把三段按键包在闭包里 `finally` 释放；Release 失败也记录日志。

### B-04 备份/云同步合并全程无事务：中途崩溃留下半导入状态（事务缺失）
- **位置**：`src/lib/sync.ts:117-278`（`mergeIntoLocal`）
- **类别**：事务缺失 / 数据安全
- **详细描述**：墓碑应用、卡插入/更新、复习补插、source 去重插入等数十条 execute 全部 autocommit。任一步抛错（唯一约束、磁盘、锁）或进程被杀，本地会残留「部分卡已插入、部分复习未补、墓碑已应用但词还在」的中间态；且 `importData` 的 catch 只是返回错误文案，不提供回滚。
- **触发场景**：大文件导入时中断、同步与本地复习并发时 SQLITE_BUSY。
- **建议修复**：整个合并包进单个事务（`BEGIN IMMEDIATE`）；把 tombstone 应用、卡合并、复习补插分阶段各自提交并在失败时回滚，或至少把「应用的墓碑」做成可回滚。

### B-05 `cards.word` UNIQUE 大小写敏感：并发/异大小写插入产生双卡，进度与同步分裂（数据完整性）
- **位置**：`src-tauri/src/lib.rs:12`（`word TEXT NOT NULL UNIQUE`）；`src/lib/db.ts:250-290`（addCard）；`src/lib/neath.ts:61`（INSERT 无 ON CONFLICT）
- **类别**：唯一约束语义 / 并发去重
- **详细描述**：唯一索引区分大小写，而所有查询都走 `COLLATE NOCASE`。`addCard` 的查重是「NOCASE 查到就跳过」，但**两个写入方并发**（主窗 + 小窗、或匿词同步与收词同时）都能通过查重：`"Apple"` 与 `"apple"` 各自 INSERT 成功 → 库中同词两条卡。之后 `getQueue`/`getTodayStats`（NOCASE JOIN）把它们当成两张卡，复习调度重复、`deleteCard(id)` 只删一条、备份导出出现同词两行、同步合并 `existing[0]` 只更新其中一条，数据永久分裂。`neath.ts:61` 的裸 `INSERT INTO cards` 连 `ON CONFLICT` 都没有，同词直接抛 SQLITE_CONSTRAINT 崩掉整次匿词同步。
- **触发场景**：两窗口同时收同一词的不同大小写；匿词收藏里同一词大小写变体。
- **建议修复**：将 `cards.word` 的 UNIQUE 改成表达式/COLLATE NOCASE 唯一（迁移重建表），所有插入统一 `ON CONFLICT(word COLLATE NOCASE) DO NOTHING` 并校验 rowsAffected 后回读；`neath.ts` 加 ON CONFLICT 兜底。

### B-06 删除操作多语句无事务 + SQLite 外键默认关闭：崩溃/中断留下孤儿数据与半删词（事务缺失 / FK 约束）
- **位置**：`src/lib/db.ts:502-518`（deleteCard）、`533-584`（deleteDeck）；schema `src-tauri/src/lib.rs:10-53`
- **类别**：事务缺失 / 外键约束
- **详细描述**：两张删除流程都是「删 reviews → 删 deck_words → 置空 source_id → 清孤儿 sources → 删卡 → 写墓碑」多语句串行执行，且从未开启 `PRAGMA foreign_keys=ON`（`reviews.card_id REFERENCES cards(id)` 不生效）。中途失败/崩掉时可能：卡已删而 reviews 残留（外键不拦）、sources 被清而卡还在、emptyset 用例中墓碑写了但卡没删——下次同步会把半状态当权威推给远端。`deleteDeck` 的孤儿判定与批量删除同样无事务包裹，大词书（数千词、分 chunk）中途断电即产生半本书残留。
- **触发场景**：删除大词书/大词库时切换电源或杀进程；`DELETE FROM sources WHERE id NOT IN (…)` 与另一窗口 `setCardContextIfEmpty` 的插入并发（先插后删导致新 source 被误清）。
- **建议修复**：每张卡/每个 chunk 一个事务；迁移中 `PRAGMA foreign_keys=ON`；孤儿 source 清理改为「只清本次操作涉及的 source_id 集合」而非全局 NOT IN。

---

## P2 中严重级别

### B-07 SQL LIKE 通配符未转义（`%`、`_` 作为字面量被当通配符）
- **位置**：`src/lib/db.ts:162,174`（lookup）、`src/lib/db.ts:444-446`（getLibrary `word LIKE ?`）
- **类别**：边界条件 / SQL 语义
- **详细描述**：查询词直接拼进 LIKE 模式（`q + "%"`、`'%' || ? || '%'`），未转义 `%`/`_`。用户搜 `a%`、`_`、`100%` 时模式被通配展开，返回大量无关词；`getLibrary` 里搜 `%` 会返回几乎全库。不是注入（参数化安全），但结果完全错误。
- **触发场景**：在查词页/词库搜索框输入含 `%`、`_` 的词。
- **建议修复**：`q.replace(/[%_]/g, (c) => "\\" + c)` 并配合 `LIKE … ESCAPE '\'`；对 `getLibrary` 同样处理。

### B-08 时间格式混用：`due` 用 UTC ISO 而 `added_at/reviewed_at` 用本地时间，少量旧数据路径混用字典序比较
- **位置**：`src/lib/db.ts:329,363`（`due <= toISOString()`）、`fsrs.ts:42-43`、`sync.ts:242-244`（last_review 比较）
- **类别**：时区/格式一致性
- **详细描述**：`applyReview` 写 `due`、`last_review` 为 `toISOString()`（UTC，带 `T…Z`），`reviews.reviewed_at`/`cards.added_at` 为 SQLite `datetime('now','localtime')`（空格分隔、无时区）。正常新建库内部一致，但：v1 备份合并来的 `due`/`last_review` 若是本地格式，`c.due <= now` 与 `inTime > loTime` 的字典序比较结果取决于字符串中空格(0x20) vs `T`(0x54) 的排序，会出现「明明未到期却判为到期」「明明较旧却判为较新」，跨时区用户更明显。`toCard` 对 `due` 为 NULL 的已学卡 `new Date(null)` 得到 1970-01-01（见 B-16）。
- **触发场景**：导入旧版备份、两台时区不同设备同步后互评。
- **建议修复**：统一落库格式（全部 UTC ISO）；比较前显式 `new Date(x).getTime()` 而非字符串比较；`toCard` 对 NULL due 做防御（跳过/按 now）。

### B-09 词库无限滚动：IO 回调可对同一 page 重复发起加载，产生重复行
- **位置**：`src/views/Library.tsx:88-101`
- **类别**：竞态与异步
- **详细描述**：`IntersectionObserver` 连续触发（快速滚动/多帧命中）时，`load(deck, filter, q, page + 1)` 用**闭包里的 page**，两次调用 page 相同；`load` 里 `pg > 0` 只校验 `loadedListKey`（已满足）不校验「该页是否已在加载」，`setLoading(true)` 是异步状态未必及时拦住第二次 → 同一页数据 `[...cs, ...rows]` 追加两次，词书列表出现重复行；后续分页 OFFSET 也随重复错位。
- **触发场景**：词书页快速滚到底部/触底瞬间触发两次。
- **建议修复**：`load` 内维护 `loadingPage` Set 或在回调里用函数式取当前 page，重复请求直接 return；追加前按 `id` 去重。

### B-10 词书过滤 `dw.word = c.word` 大小写敏感：异大小写标签的卡在词书页签里失联
- **位置**：`src/lib/db.ts:124`（deckClause）
- **类别**：大小写一致性 / 逻辑错误
- **详细描述**：迁移 7（lib.rs:119-136）已把 `deck_words` 主键建成 NOCASE，但 `deckClause` 的子查询仍用裸 `dw.word = c.word`（无 COLLATE）。若卡词与前缀标签大小写不一致（另一台设备的备份插入、`addWordToDeck` 传了不同大小写），`EXISTS` 匹配不到 → 该词在本词书视图中消失（「全部」里却还在），`getTodayStats`/`getQueue` 的按词书统计全部偏差。
- **触发场景**：设备 A 以 `Apple` 收录，同步到设备 B 后 B 的 `deck_words` 里是 `apple`。
- **建议修复**：`dw.word = c.word COLLATE NOCASE`（或互用 NOCASE 比较）。

### B-11 本地重建已删除词书不清除 `deck_removals`：该书的标签永远无法再同步
- **位置**：`src/lib/db.ts:486-494`（addWordToDeck）、`src/lib/sync.ts:87-92`（restoreDeckWords 按 deck_removals 过滤）、对比 `src/lib/books.ts:39`（importBook 会 `DELETE FROM deck_removals`）
- **类别**：同步语义不一致
- **详细描述**：`deleteDeck` 在 `deck_removals` 记一条「整本移除」记录，同步合并据此拒绝灌入该书标签。但用户**本地重新建同名词书**（`addWordToDeck`/`addCard` 传入同名词书名）时不会清这条记录——`importBook` 会清、用户自建不会，两套路径语义不一致。结果：重建成的新书标签只在本机可见，远端设备永远补不回来；而本机新加的标签也因过滤被同步拒绝，双向不同步。
- **触发场景**：A 机移除「考研词」书 → A 机重新给新词挂「考研词」标签 → 与 B 机同步。
- **建议修复**：`addWordToDeck`/`addCard` 判定「该 deck 名在 deck_removals 中」时同步清除记录（与 importBook 一致）。

### B-12 快速收词：`setTimeout(hideQuick, 900)` 无取消，二次操作被旧定时器打断
- **位置**：`src/QuickCapture.tsx:146`
- **类别**：竞态与异步
- **详细描述**：收词成功后 900ms 定时收起小窗。`finally` 里 `setBusy(false)` 立即复位，若用户在 900ms 内继续输入并回车收第二个词，**第一次的定时器照样触发**，把正在进行的第二次操作连同窗口一起收起/隐藏，第二次的状态提示瞬间消失。
- **触发场景**：连续快收两个词。
- **建议修复**：hide 定时器存 ref，第二次 prepare/add/输入时 `clearTimeout`；收起前再校验 busy。

### B-13 快速收词：焦点事件循环会让 `prepare()` 用剪贴板旧内容覆盖用户正在输入的内容
- **位置**：`src/QuickCapture.tsx:110-122`（`onFocusChanged` 每次 focused 都 `prepare()`；`prepare` 内 `setWord/setContext`）
- **类别**：状态更新竞态
- **详细描述**：`prepare()` 在每次获得焦点时用剪贴板/交接内容整体重置 `word`/`context`/`deck`。窗口因任何原因短暂失焦再聚焦（误触窗口外、系统弹窗、切输入法窗口），用户已输入但未提交的词会被覆盖成剪贴板内容；`lastHandover` 的 1500ms 窗口只挡「交接过整句」的场景，挡不住普通输入。
- **触发场景**：输入一半时点击系统托盘/其他窗口再点回小窗。
- **建议修复**：仅在窗口「从完全隐藏→显示」或收到 `quick-show` 事件时 prepare；纯焦点变化且输入框非空/未被清空时跳过，或先比对输入框内容。

### B-14 内置词典释放仅按文件大小判断新旧，同大小不同内容不更新
- **位置**：`src-tauri/src/lib.rs:681-682`
- **类别**：逻辑错误
- **详细描述**：`metadata(target).len() != metadata(res).len()` 判定「过时」。若新版词典与旧版恰好同字节数（词条一增一减、压缩后同尺寸），永远不覆盖，用户持续使用旧词库；`unwrap_or(1)` 让「统计失败」被当作「过时」进而走 copy，错误路径还能自愈，但内容比较是完全缺失的。
- **触发场景**：应用更新后资源字典与旧版同大小。
- **建议修复**：比较内容哈希（或版本文件），或在 resources 里固定词典版本号随版本升级强制覆盖。

### B-15 `gist_http` 响应无大小上限：恶意/异常 Gist 拖垮内存
- **位置**：`src-tauri/src/lib.rs:572-583`
- **类别**：边界条件
- **详细描述**：`resp.text().await` 把整个响应读进内存再塞进 IPC 返回字符串。远端 Gist 若被人为写入几十 MB 内容（令牌泄露、误操作、恶意注入），前端 `JSON.parse` 直接超大内存占用甚至 OOM；下载耗时也逼近 120s 总超时上限。
- **触发场景**：Gist 内容异常膨胀。
- **建议修复**：限制响应长度（如 content-length 检查 + 流式截断 10MB），超过即报错「云端备份过大」。

### B-16 `toCard` 对 NULL `due` 的已学卡生成 1970 年到期，进入无限复习循环
- **位置**：`src/lib/fsrs.ts:42-43`
- **类别**：边界条件
- **详细描述**：`state !== New` 时直接 `new Date(row.due!)`。旧备份/异常数据里 `due` 为 NULL（v1 备份缺 due 字段、半写状态）→ `new Date(null)` = 1970-01-01。该卡在 `f.repeat` 里被当作超期千年的卡重新调度，`getQueue` 每轮都把它拉出来（`c.due <= now` 恒真），用户每次复习都见到它，且 `applyReview` 写回的 due 正常后即自愈——但在此之前是「幽灵卡」。
- **触发场景**：导入缺 due 的历史备份；B-06 半写状态残留。
- **建议修复**：`row.due` 为 NULL 时按 `last_review ?? now` 兜底，或直接跳过该卡并标记需修复。

### B-17 云同步「拉取→合并→全量推回」窗口内远端被其他设备更新则互相覆盖
- **位置**：`src/lib/cloud.ts:92-130`
- **类别**：并发同步
- **详细描述**：两台设备同时同步时，A 在「合并后、推回前」的窗口内 B 已完成推回，A 随后用旧快照 + 自己本地的全量 PATCH 覆盖 B 刚推的内容；B 端刚同步进来的记录在 server 上丢失，直到下一轮 A/B 再次拉取时靠 `last_review 新者胜` 与 review 指纹去重**部分**恢复——但并发轮次多时可能出现反复回退。属 last-writer-wins，无乐观版本号。
- **触发场景**：两台设备同时设了自动同步且都在线。
- **建议修复**：推回前带上「基于哪个 gist 版本」条件更新（GitHub API 支持 ETag/If-Match 弱校验），冲突时下一轮再拉取合并。

### B-18 首页切换词书竞态：快速连点两个词书，统计显示可能错位
- **位置**：`src/views/Home.tsx:53-57`（pickDeck）
- **类别**：状态更新竞态
- **详细描述**：`pickDeck` 无请求序号：连点「四级」「考研」时两个 `getTodayStats` 并发，**后返回者覆盖前者**，界面显示的统计可能属于上一个词书（`deck` state 却是最新的）。
- **触发场景**：快速连续切换词书下拉项。
- **建议修复**：仿 Search.tsx 用递增 id 丢弃过期响应，或 `await` 链式串行。

### B-19 复习队列硬上限 500：大词库当天到期超过 500 张时，余下永不进入本轮
- **位置**：`src/lib/db.ts:364`（`ORDER BY c.due LIMIT 500`）
- **类别**：边界条件 / 功能限制
- **详细描述**：`getQueue` 每次只取 500 张到期卡，队列是一次快照，本轮复习循环只在队列内推进。到期卡 > 500 时，第 501+ 张当天不会出现（除非重新挂载 Review 再次取前 500，仍取同样前 500）。对「今天到期的 >500」的活跃大库用户，实际复习量被截断到 500。
- **触发场景**：库中 800 张卡同一天到期。
- **建议修复**：分页续取（队列耗尽后按 due 游标再取），或去掉上限改为惰性加载。

---

## P3 低严重级别

### B-20 四选一选项依赖 `queue` 变量重建：队列里插入重试卡时选项当场重排
- **位置**：`src/views/Review.tsx:187-202`
- **类别**：React 依赖 / 状态一致性
- **详细描述**：`choice` memo 依赖 `[item, mode, queue]`，任何其他词的 `Again` 重试卡插入队列都会触发重算并 `shuffle` 出新选项。用户正看着未作答的四选一题目时，选项顺序会在下一次渲染中被打乱（概率性）。
- **触发场景**：四选一作答过程中另一张卡因 Again 被插队（队列更新）。
- **建议修复**：依赖只用 `item.id`+`mode`，把「当前快照的选项」缓存下来。

### B-21 清洗词不彻底：多词短语/UTF-16 截断被整条入库成「单词」
- **位置**：`src/lib/capture.ts:15-20`（cleanWord）、`src/App.tsx:48-52`（≥3 词才分流，2 词直接收）
- **类别**：边界条件
- **详细描述**：`cleanWord` 保留空格（`\s+` 归并为单个空格），2 词选区（如 `big data`）直接被当「一个词」建卡；`slice(0, 48)` 按 UTF-16 码元截断，含代理对（emoji/生僻字）时可能截出半个字符、破坏词形。
- **触发场景**：选中两个词划词直加；超长含 emoji 的选区。
- **建议修复**：2+ 词的选区也按「超过 1 词即走小窗/提示」处理；截断用 `Array.from` 按码点。

### B-22 统计页每次挂载全表扫描 reviews 并全部 `new Date()` 解析
- **位置**：`src/views/Stats.tsx:11-23`
- **类别**：性能
- **详细描述**：`loadReviewDays` 拉全部 `reviewed_at` 逐条解析建 Map，数万条记录时每次进统计页卡顿；且与 `doneToday` 的 SQLite 端聚合重复做功。
- **触发场景**：长年使用、reviews 6+ 万条。
- **建议修复**：SQL 端按 `date(reviewed_at)` 分日聚合，前端只聚合日粒度。

### B-23 复习去重指纹（词+时间+评分）跨机误判：同词同时刻同分被当成同一条
- **位置**：`src/lib/sync.ts:173-179,258-260`
- **类别**：去重错误
- **详细描述**：指纹 `word|reviewed_at|rating`。两台设备在同一本地墙钟秒复习同一词同评分（跨时区极端对齐）时，其中一条记录被认为重复而丢弃；同机同秒两次 Again 也会被吞掉一条。
- **触发场景**：双设备同一秒对同一词打同分；同机连点重试。
- **建议修复**：指纹加入 `duration_ms` 或毫秒精度/自增序号。

### B-24 远端复习记录只随 `data.cards` 循环合并：卡已被删则其复习记录永远不落地
- **位置**：`src/lib/sync.ts:214-272`（reviews 补插在 cards 循环内）
- **类别**：同步完整性
- **详细描述**：`reviewsByWord` 只在遍历 `data.cards` 时消费；备份里存在 reviews 但其词在 `data.cards` 中缺失（已被远端删除、被墓碑过滤、或截断）时，这些复习记录静默丢弃——统计与连续天数随之丢失。
- **触发场景**：A 机删除词前 B 机仍有过该卡的历史复习，同步后 B 机历史减少。
- **建议修复**：先插卡/保留墓碑词为占位后仍补插 reviews，或至少统计丢弃条数提示用户。

### B-25 保存每日新词量的「已保存」提示定时器未清理
- **位置**：`src/views/Settings.tsx:217-223`
- **类别**：React 清理
- **详细描述**：`setTimeout(() => setSaved(false), 1500)` 未存 ref 且无卸载清理；快速连点「保存」堆积多个定时器，卸载后仍触发 setState。
- **触发场景**：连续点击保存后立即离开设置页。
- **建议修复**：定时器入 ref，卸载时 clearTimeout，重复保存先清旧的。

### B-26 热键修改 invoke 无串行锁：连点两次热键导致最终设置与后端不一致
- **位置**：`src/views/Settings.tsx:178-201`（changeHotkey）
- **类别**：竞态
- **详细描述**：`changeHotkey` 是 async 且无 busy 标记，连续改动两次时两个 `invoke("set_quick_hotkeys")` 并发，后到的 invoke 用的是另一个热键当时的旧值，完成顺序不确定 → 落库值与后端实际注册值不一致（界面显示的键可能不是真实生效键）。
- **触发场景**：设置页快速连改「划词直加」与「查词小窗」两个热键。
- **建议修复**：串行队列（promise 链）或禁用按钮直到完成。

### B-27 自动云同步节流失败后 5 分钟不重试
- **位置**：`src/lib/cloud.ts:185-196`
- **类别**：逻辑错误
- **详细描述**：`lastAutoSyncAt = Date.now()` 在**发起前**置位；网络失败/Token 失效后，5 分钟内自动同步静默跳过，用户需手动同步或重开。
- **触发场景**：离线启动 → 联网后 5 分钟内不自动同步。
- **建议修复**：成功后才更新时间戳，或失败后缩短节流窗口。

### B-28 托盘图标 `expect` 会在缺资源时直接 panic 起不来
- **位置**：`src-tauri/src/lib.rs:651`
- **类别**：Rust 崩溃点
- **详细描述**：`app.default_window_icon().expect("缺默认图标")`——安装包损坏/开发环境缺 icon 资源时 setup 直接 panic，应用整体无法启动（本应是「能启动只是没托盘图标」）。
- **触发场景**：打包配置错误或资源缺失。
- **建议修复**：改为 `if let Some(icon) = …`，无图标则跳过托盘构建并 eprintln。

### B-29 Scramble 组件 `onResult` 依赖缺失，存在陈旧闭包调用
- **位置**：`src/views/Review.tsx:62-65`
- **类别**：React stale closure
- **详细描述**：effect 只依赖 `[done]`（eslint-disable），捕获的 `onResult`（answerScramble，依赖 `[item, phase]`）可能是旧渲染的函数；拼完瞬间若 `item` 刚切换（队列插队），可能对旧单词判分。当前实现因 `key={seqKey}` 重置组件、影响极小，但依赖缺失保持隐患。
- **触发场景**：拼句完成与新卡切换同帧发生。
- **建议修复**：把 `onResult` 纳入依赖或改为在点击事件里判分（不用 effect）。

### B-30 `addCard` 建 sources 后卡插入失败残留孤儿 source
- **位置**：`src/lib/db.ts:272-283`
- **类别**：数据残留
- **详细描述**：先 `INSERT INTO sources` 拿到 id，再插卡；若插卡因并发冲突/约束失败，source 已落库且无人引用（孤儿），只能等删除操作顺带清理，可能长期滞留。
- **触发场景**：两窗口同时收同一词且带原句。
- **建议修复**：先查重卡，再在同一事务里插 source + 卡；或失败时回查清理。

### B-31 `useCountUp` 对非有限 target 不回落、保持旧值
- **位置**：`src/lib/useCountUp.ts:7`
- **类别**：边界条件
- **详细描述**：`target` 为 NaN/Infinity 时 effect 直接 return，动画值停留在上一个有效值；若上一次也是异常值则显示 0 与最终目标不一致。
- **触发场景**：stats 加载出错时 Home 的 `total=0` 正常，但异常分支下数值静止。
- **建议修复**：非有限时直接 `setValue(0)` 或不做动画直接落到目标。

### B-32 `addWordToDeck` 允许空串/纯空格词书名，污染词书列表
- **位置**：`src/lib/db.ts:486-494`、`src/views/Library.tsx:133-139`
- **类别**：边界条件
- **详细描述**：`deck.trim()` 后为空串时仍执行 `INSERT OR IGNORE`，产生 `deck = ''` 的标签；词书页签/选择器/同步备份都会出现一个空名词书。
- **触发场景**：词书中「自建」输入框只敲空格点创建（前端按钮 `disabled={!newBook.trim()}` 已挡主路，但 QuickCapture 的 quick_deck 设置值、同步导入路径未挡）。
- **建议修复**：入库前统一 `if (!deck.trim()) return`。

---

## 按严重级别排序的快速清单

**P0（0 项）**：无。

**P1（6 项）**
1. B-01 同步墓碑跨时区比较误删重收词（sync.ts:134/146/165/219）
2. B-02 评分写库无事务 + 双窗并发评分覆盖 FSRS 状态（db.ts:390-409）
3. B-03 enigo 复制失败修饰键不释放导致全局卡键（lib.rs:488-495）
4. B-04 合并导入全程无事务，中断半写（sync.ts:117-278）
5. B-05 cards.word UNIQUE 大小写敏感，并发插入双卡（lib.rs:12 / db.ts:250-290 / neath.ts:61）
6. B-06 删除操作无事务 + 外键未开启，孤儿数据与半删（db.ts:502-518/533-584）

**P2（13 项）**
7. B-07 SQL LIKE `%`/`_` 通配符未转义（db.ts:162/174/444）
8. B-08 due/reviewed_at/added_at 格式混用字典序比较（db.ts:329/363、fsrs.ts:42、sync.ts:242）
9. B-09 词库无限滚动重复请求产生重复行（Library.tsx:88-101）
10. B-10 词书过滤大小写敏感致标签失联（db.ts:124）
11. B-11 本地重建词书不清 deck_removals，标签无法再同步（db.ts:486 / sync.ts:87 / books.ts:39）
12. B-12 小窗 900ms 隐藏定时器打断二次收词（QuickCapture.tsx:146）
13. B-13 小窗 focus 事件用剪贴板覆盖正在输入的内容（QuickCapture.tsx:110-122）
14. B-14 词典仅按文件大小判新旧（lib.rs:681）
15. B-15 gist_http 无响应大小上限（lib.rs:572-583）
16. B-16 toCard 对 NULL due 生成 1970 幽灵卡（fsrs.ts:42）
17. B-17 云同步并发推回窗口期互相覆盖（cloud.ts:92-130）
18. B-18 首页切词书统计竞态错位（Home.tsx:53-57）
19. B-19 复习队列 500 上限截断当日复习量（db.ts:364）

**P3（13 项）**
20. B-20 四选一选项随队列重排（Review.tsx:187-202）
21. B-21 多词短语/截断词整条入库（capture.ts:15-20、App.tsx:48-52）
22. B-22 统计页全表扫描 reviews（Stats.tsx:11-23）
23. B-23 复习指纹去重误判跨机同刻记录（sync.ts:173-179）
24. B-24 远端已删词的复习记录丢弃（sync.ts:214-272）
25. B-25 「已保存」提示定时器未清理（Settings.tsx:217-223）
26. B-26 热键修改并发写入不一致（Settings.tsx:178-201）
27. B-27 自动同步失败后节流不重试（cloud.ts:185-196）
28. B-28 托盘图标 expect 崩溃点（lib.rs:651）
29. B-29 Scramble onResult 依赖缺失（Review.tsx:62-65）
30. B-30 收词失败残留孤儿 source（db.ts:272-283）
31. B-31 useCountUp 非有限目标保持旧值（useCountUp.ts:7）
32. B-32 空串词书名入库（db.ts:486-494）

---

## 附录：亮点（值得保持的设计）

- 复习队列用 `gradingItem` 引用锁防同一会话内键盘连发/连点重复评分，做法正确（Review.tsx:139/285-288）。
- 查词防抖用递增 reqRef 丢弃过期响应，且「清空输入也立即作废在途查询」的注释点很到位（Search.tsx:50-72）。
- 词库分页用 generation + key 双重守卫，翻页期间插入/删除不串数据（Library.tsx:49-79）。
- Rust 侧剪贴板序号判定（macOS changeCount / Windows GetClipboardSequenceNumber）有效避免了「读旧剪贴板当选区」的误收词；gist_http 走 reqwest 直连绕开 IPC 体积问题，方案合理。
- macOS 辅助功能权限前置检查 + 每进程只弹一次引导，处理细致。