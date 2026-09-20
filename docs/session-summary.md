# 浸词 immerso — 本次会话工作总结

> 日期：2026-09-20 ｜ 模式：Agent 团队（评估 → Bug 查找 → 测试 → 修复 → 审核）
> 项目：Tauri 2 + React 19 + TypeScript 桌面背单词应用（v1.4.2）

---

## 一、总体流程

```
阶段 1 评估     arch-evaluator  ──► docs/evaluation.md   （架构/安全/性能 7 维度，评级 3.5/5）
阶段 2 挖 Bug   bug-hunter      ──► docs/bug-report.md   （逐行审查 5.3K 行 TS + 721 行 Rust，32 条 Bug）
阶段 3 测试     test-engineer   ──► docs/test-report.md  （vitest 从零搭建，83 用例 → 修复后 94）
阶段 4 修复     db-fixer / rust-fixer / ui-fixer ──► 6 个 P1 + 2 个高危安全项 + 3 个源码疑点
阶段 5 审核     Lead 逐行审 diff、抓接口契约 bug、补 3 处遗漏、全量验证
```

## 二、评估结论（docs/evaluation.md）

- **综合评级 3.5/5**：功能完整、工程细节扎实、安全基线高于同类个人项目；短板在可测试性与个别安全边界。
- **两大高危项**：
  1. Rust 备份命令 `write_backup_file`/`read_backup_file` 无路径校验（可被注入读走任意文件）→ **本轮已修**
  2. GitHub Token / Neath Key 明文落盘无 ACL → **未修（建议迁移系统凭据库）**
- **优点**：云同步模型成熟（墓碑+新者胜+指纹去重+防重入）；SQL 全参数化；CSP 严格；npm audit 0 漏洞。

## 三、Bug 报告（docs/bug-report.md）

共 **32 条**：P0=0、P1=6、P2=13、P3=13。本轮修复所有 **6 个 P1** + 部分 P2/P3：

| 编号 | 问题 | 严重度 | 状态 |
|---|---|---|---|
| B-01 | 跨时区同步误删「删除后重收」的词（数据永久丢失） | P1 | ✅ 已修 |
| B-02 | 评分写库非原子 + 双窗口并发 FSRS 状态损坏 | P1 | ✅ 已修 |
| B-03 | 划词失败 Ctrl/⌘ 永不释放（全局卡键） | P1 | ✅ 已修 |
| B-04 | 备份/云同步合并无事务（半导入残留） | P1 | ✅ 已修 |
| B-05 | `cards.word` UNIQUE 大小写敏感 → 双卡分裂 | P1 | ✅ 已修 |
| B-06 | 删除多语句无事务 + 外键未开 | P1 | ✅ 已修 |
| B-07 | SQL LIKE 通配符未转义 | P2 | ✅ 已修 |
| B-08 | 时间格式混用字典序比较 | P2 | ✅ 已修（并入 B-01 统一 UTC） |
| B-14 | 词典仅按文件大小判新旧 | P3 | ✅ 已修 |
| B-09/B-10/B-13 | 无限滚动/词书大小写/小窗焦点 | P2/P3 | ⏸ 评估后未修（见遗留） |

## 四、测试体系（docs/test-report.md + tests/）

- 从 **0 → 94 用例全绿**（books 9 / fsrs 22 / exercises 34 / spell 13 / sync-time 8 / useCountUp 8），覆盖率 96%+。
- 新增 `npm test` / `npm run test:coverage` 脚本、vitest.config.ts。
- 修复后新增 `tests/sync-time.test.ts`（8 用例）锁定跨时区比较行为。
- `npm run build`（tsc+vite）、`cargo check` 均通过。

## 五、修复明细（docs/fix-data.md / fix-rust.md / fix-ui.md）

### 数据层 / 同步（db-fixer）
- **B-01**：全库时间统一 UTC `YYYY-MM-DD HH:MM:SS`（新增 `fmtDbTime()`）；`due/last_review/reviewed_at/deleted_at` 同格式；同步比较抽纯函数 `timeGte/timeGt/timeLt` + 单测。
- **B-02**：评分三层防御——Rust `execute_tx` 事务（单连接 BEGIN IMMEDIATE→COMMIT/ROLLBACK）+ CAS 快照冲突检测（抛 `STALE_CARD`）+ 进程内串行锁。
- **B-04**：合并流程墓碑段/复习补插段进事务，失败提示重试。
- **B-05**：`addCard` 冲突兜底（rowsAffected=0 视为已存在）。
- **B-07**：`escapeLike()` 转义 + `ESCAPE '\'`。

### Rust 端（rust-fixer）
- **B-03**：RAII `ModifierGuard`，Drop 必然释放修饰键。
- **安全**：备份命令改为 **Rust 侧自弹对话框**（不再信任前端 path），补 `.json` 校验 + 20MB 上限；契约 `Ok("cancelled")` / `Ok("ok:<path>")` / `Ok(内容)`。
- **schema**：DEFAULT 全改 UTC；CORE_SCHEMA 的 `cards.word` 改 `COLLATE NOCASE UNIQUE`。
- **migration v8**：重建 cards 表收敛大小写双卡（实测定：Apple/apple → 保留先插行）。
- **execute_tx**：自建单连接池 + busy_timeout(5s) 原生存事务；Cargo.toml 加 sqlx 0.8。
- **B-14**：dict.db 判新旧 = 大小不同 OR 文件头 4096 字节不同。

### 前端逻辑（ui-fixer）
- exercises 死条件消除（默写/听写拦截前移）、`blankWord` 改 lookaround 边界（C++ 类词可挖空）。
- useCountUp `duration<=0` 除零防御。
- neath 裸 INSERT 加 `ON CONFLICT DO NOTHING` + 孤儿 source 清理。

### Lead 审核补修（3 处）
1. **契约 bug**：Rust 返回 `Ok("cancelled")`（truthy），前端原判断 `!result` 会误走成功分支 → sync.ts 已显式识别。
2. **fsrs.ts `toCard`**：`new Date("YYYY-MM-DD HH:MM:SS")` 按本地时区解析丢 UTC → 新增 `parseDbTime`（兼容三种存量格式）。
3. **Review.tsx**：`STALE_CARD` 友好提示并跳过该卡。

## 六、验证结果（全部实测）

| 验证项 | 结果 |
|---|---|
| `npm run build`（tsc + vite） | ✅ 通过 |
| `npm test`（vitest） | ✅ 94/94 通过 |
| `cargo check` | ✅ 0 error / 0 warning |
| migration v8 真实 SQLite 收敛 | ✅ Apple/apple → 保留先插行，NOCASE 拦截生效，reviews 引用完好 |

## 七、遗留事项（未修）

1. **存量旧数据**：本地时间无时区标记，无法完美迁移（新数据已收敛正确）。
2. **B-10** 词书 deck 名大小写（P2）：应用侧写入自洽、无用户入口，schema 重建风险高，暂缓。
3. **B-09 / B-13**：逻辑守卫链完整或无安全结论，未改（记录在案）。
4. **密钥明文落盘**：建议迁移系统凭据库（Windows Credential Manager / macOS Keychain）。
5. **gen/schemas**：需跑一次 `tauri build` 重新生成（未做，成本高）。
6. **GUI 端到端手测**：划词失败路径、备份对话框取消/成功、>20MB 拒读（无 GUI 环境未做）。

## 八、Git 状态说明（重要）

- 开发过程中，成员/环境产生过**自动 git 提交**（提交信息为系统生成的 "Ai-coding：..." 占位文本，其中一批还捎带了 `coverage/` 测试产物）。
- 已做处理：`coverage/` 已清理并加入 `.gitignore`；成员那批自动提交链已 reset 清除。
- **当前 HEAD = 33395bd（你的原始提交）之后新增了一个环境自动提交 91112a9**，内容恰为本次全部 26 个文件（源码/配置/文档/测试）的完整快照，不含垃圾文件。
- 磁盘上的文件内容 = 最新修复版本（grep 验证 `fmtDbTime`/`parseDbTime`/`execute_tx` 等均已在源码中）。
- 如需"未提交、自己 review 后提交"的状态，可再 `git reset --soft 33395bd`；如需有意义的提交历史，可 amend 提交信息。