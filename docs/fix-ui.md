# UI 逻辑层缺陷修复记录（ui-fixer）

范围：`src/lib/neath.ts`、`src/lib/exercises.ts`、`src/lib/useCountUp.ts`（以及为随实现变更的测试期望同步更新 `tests/exercises.test.ts`、`tests/useCountUp.test.tsx`）。未触碰 `src/lib/db.ts`、`src/lib/sync.ts`、`src/lib/cloud.ts`、`src-tauri/`。

验证：`npm run build`（tsc + vite）通过；`npm test` 5 个文件 86 例全绿。

---

## 1. exercises.ts：buildSequence 第 58 行死条件（tests 锁定）

**原代码**：

```ts
if (isNew && !NEW_WORD_MODES.includes(m)) return false;                       // 先执行
if ((m === "dictation" || m === "listen") && isNew && reps === 0) return false; // 永不执行
```

`NEW_WORD_MODES` 不含 `dictation/listen`，57 行已把所有新词的这两项滤掉，58 行的 `reps === 0` 判断永远走不到（死代码），`reps` 参数形同虚设。

**修复**：把「默写/听写对全新词（reps=0）先拦截」提到 `NEW_WORD_MODES` 过滤之前，两条过滤都保留：

```ts
// 默写/听写对全新词（reps=0）一律先拦：先认识后默写。必须先于下方
// NEW_WORD_MODES 过滤执行——否则 reps 参数在此永远派不上用场（死条件）。
if ((m === "dictation" || m === "listen") && isNew && reps === 0) return false;
// NEW_WORD_MODES 不含默写/听写：新词仍然默认不带这两项
// （reps>0 的放行口被它收住，当前产品语义 = 新词永不做默写/听写；
//  将来要放开只需把这两项加入 NEW_WORD_MODES 或放宽本行）。
if (isNew && !NEW_WORD_MODES.includes(m)) return false;
```

**语义说明**：本修复**保持等价行为**——新词（`isNew`）始终不会进入默写/听写模式。第 58 行不再是「被遮蔽的死代码」，`reps` 参数恢复了实际意义（全新词 reps=0 的显式拦截先于通用过滤执行）。若产品将来想让「练过一轮的新词（reps>0）」做默写/听写，只需在此处放开第二行（或把 dictation/listen 加入 `NEW_WORD_MODES`），第 58 行已铺好放行口。函数与行内注释均写清该语义。

**测试差异**：`tests/exercises.test.ts` 全部 32 个原有用例（含「新词无默写」「新词练过仍无默写」）在等价语义下原样通过，未改动断言。

## 2. exercises.ts：blankWord 对 C++ 类非字母收尾词失效（tests 锁定）

**原代码**：`new RegExp(\`\\b${esc(w)}\\b\`, "i")`。

**问题**：`\b` 只把 `[A-Za-z0-9_]` 当词字符。`"C++"` 的尾字符 `+` 非 `\w`，其后若接空格/字符串尾，两侧都非词字符，`\b` 不成立 → 永远匹配失败，cloze 挖空对这类词失效。

**修复**：用等价的自定义 lookaround 边界替代 `\b`：

```ts
const re = new RegExp(`(?<![A-Za-z0-9_])${esc(w)}(?![A-Za-z0-9_])`, "i");
```

命中串前后都不是字母/数字/下划线才算边界；与 `\b` 的词字符集合一致（含 lookbehind 对中文/emoji 视为非词字符的语义），但不再要求边界两侧存在 `\w`，因此 `c++`、`3.14`、`e-mail` 等均可命中。需要现代 JS 引擎的 lookbehind，Vite 构建目标与 WebView2/Electron 均支持。

**测试差异**：原「疑点」用例本就是锁定 bug 行为（`found=false`）的记录，修复后期望反转，更新为：

```ts
const r = blankWord("It's C# and C++", "c++");
expect(r.found).toBe(true);
expect(r.text).toBe("It's C# and _____");
```

并新增两例：`"C++ is hard"` 行首命中、`prego` 不挖 `go`（验证新边界仍拦截部分匹配）。其余既有用例（普通词、大小写、词形、`3.14`/`e-mail` 特殊字符）不变全过。

## 3. useCountUp.ts：duration=0 除零产生 NaN（tests 锁定）

**原代码**：`const p = Math.min(1, (now - t0) / duration);`，`duration=0` 且首帧 `now === t0` 时 `0/0 = NaN`，`setValue(NaN)` 让统计数字显示成 `NaN`。

**修复**：effect 开头加防御，无动画时长即无运动过程，直接落位：

```ts
// duration<=0：没有动画时长就没有运动过程，直接落到目标值。
// 否则 (now - t0) / 0 在首帧（now===t0）产生 0/0=NaN，setValue(NaN) 会让数字显示成 NaN。
if (duration <= 0) {
  setValue(target);
  return;
}
```

（位于 reduced-motion 检查之后；两者效果同为直接落位，互不冲突。）

**测试差异**：`tests/useCountUp.test.tsx` 原有的 duration=0「边界探针」用例专为记录 NaN bug 行为而写（断言 `Number.isFinite(result.current) === false`），修复后期望随实现变更，更新为断言直接落到 42 且不调度动画帧，并新增负数 duration 同路径用例。其余 6 个用例不变全过。

## 4. neath.ts：裸 INSERT 撞唯一约束会崩同步

**原代码**：

```ts
await db.execute("INSERT INTO cards (word, source_id) VALUES (?, ?)", [it.word, src.lastInsertId]);
```

**问题**：前面 NOCASE 查重通过后、此条执行前，若并发收词/另一轮同步插入了同词，会撞 `cards.word` 的 UNIQUE 约束抛 `SQLITE_CONSTRAINT`，整次匿词同步中途失败；先建的 `sources` 记录也随之变成无人引用的孤儿。

**修复**：幂等插入 + 冲突时清理孤儿并计数：

```ts
const r = await db.execute(
  "INSERT INTO cards (word, source_id) VALUES (?, ?) ON CONFLICT(word) DO NOTHING",
  [it.word, src.lastInsertId],
);
if ((r.rowsAffected ?? 0) === 0) {
  await db.execute("DELETE FROM sources WHERE id = ?", [src.lastInsertId]);
  existing++;
  continue;
}
```

`deck_words` 的 `INSERT OR IGNORE` 保留不动。注意 `cards.word` 唯一约束是 BINARY collation（见 `src-tauri` CORE_SCHEMA），NOCASE 查重与精确冲突两套语义互不干扰：大小写变体仍按旧语义走查重跳过，`ON CONFLICT` 只兜并发下的精确重复。

## 5. B-10 词书过滤大小写失联（按需评估）

**结论：跳过，移交 db-fixer/相应成员。**

- 排查了 `src/views/` 全部组件与 `src/lib/capture.ts`：deck 名均取自 `getAllDeckNames()/getDecks()` 的真实库值，选中后原样回传，自洽。「生词本」三处硬编码（`db.ts` DEFAULT_DECK、`neath.ts`、`QuickCapture/Search` 字面量）完全一致，中文无大小写问题，视图层无字面量不匹配。
- 失联根因在数据层：`deck_words.deck` 列是 BINARY collation（migration 7 只给 `word` 列加 NOCASE），`deckClause`（db.ts）与 `getWordDecks` 的 `dw.deck = ?` 逐字节比较；他机以不同大小写写入同名书（如 `CET-4` vs `cet-4`）时，两套标签并存，过滤只命中其中之一。这属于 db.ts/sync.ts 的写入归一化问题，视图层无法在不越界改动的前提下稳妥修复 → 按计划跳过，报告 Lead 转 db-fixer 处理。

## 6. B-09 无限滚动重复加载 / B-13 小窗 focus 覆盖输入（评估）

- **B-09（Library.tsx 分页）**：未发现明确 bug，跳过。守卫链完整：`activeListKey`（筛选键已变则丢弃）、`loadedListKey`（追加页前置条件：须已加载过该 key 的第 0 页）、`generation` 计数器（page 0 重置会使所有在途旧请求失效）、`loading` 与 `hasMore` 互斥（触底回调不会叠发）。筛选变化与 library-changed 刷新的双路线都由 generation 兜底，不存在重复加载同一页的路径。剩余理论风险（同页并发重复）被上述守卫覆盖到不可达。
- **B-13（QuickCapture.tsx 焦点覆盖）**：未发现安全的小修复，跳过。焦点恢复触发 `prepare()` 会用剪贴板覆盖正在输入的内容，但这与「呼出即取剪贴板」的设计同源，且已有 `lastPrep`（200ms 去重）与 `lastHandover`（1.5s 短窗不读剪贴板）两道防线；区分「呼出」与「用户点回继续输入」需要产品语义上的取舍，改动易引入新副作用，量力而行放弃，记录在案。

## 验证

```
> npm run build        # tsc && vite build 通过（1875 modules）
> npm test             # vitest run —— 5 文件 86 例全部通过
  ✓ tests/books.test.ts       (9 tests)
  ✓ tests/exercises.test.ts   (34 tests)
  ✓ tests/fsrs.test.ts        (22 tests)
  ✓ tests/spell.test.ts       (13 tests)
  ✓ tests/useCountUp.test.tsx (8 tests)
```