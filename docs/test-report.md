# Immerso 单元测试体系搭建报告

- 日期：2026-09-20
- 范围：前端纯逻辑模块单元测试（Vitest + Node），不含 Tauri 集成
- 结果：**83/83 测试通过**，覆盖率 96.22% 语句 / 96.51% 分支，`npm run build` 通过，`cargo check` 通过

---

## 1. 搭建的配置

### 1.1 依赖（devDependencies 新增）

| 包 | 版本 | 用途 |
|---|---|---|
| `vitest` | ^5.0.1 | 测试框架 |
| `@vitest/coverage-v8` | ^5.0.1 | v8 覆盖率统计 |
| `@testing-library/react` | ^16.3.3 | useCountUp Hook 测试 |
| `happy-dom` | ^20.14.5 | Hook 测试的 DOM 环境 |
| `@testing-library/jest-dom` | ^7.0.1 | (备用，当前断言未使用) |
| `@types/node` | ^26.6.2 | Node 类型 |

安装命令：`npm install -D vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom happy-dom @types/node`（网络正常，无需重试）。

### 1.2 配置文件

- **`vitest.config.ts`**（新建，独立于 `vite.config.ts`，避免引入 React/Tailwind 插件）：
  - `test.environment = "node"`（纯逻辑模块无需 DOM）
  - `include: ["tests/**/*.test.{ts,tsx}"]`
  - `coverage`：v8 provider，只统计 src/lib 下 5 个纯逻辑模块，输出 text/json/html 到 `coverage/`
- **`useCountUp.test.tsx`** 通过文件头 `// @vitest-environment happy-dom` 注释单独启用 DOM 环境，其余测试沿用 node 环境

### 1.3 package.json 脚本（新增）

```json
"test": "vitest run",
"test:coverage": "vitest run --coverage"
```

---

## 2. 测试文件与用例

| 测试文件 | 用例数 | 覆盖模块 | 说明 |
|---|---|---|---|
| `tests/fsrs.test.ts` | 22 | `src/lib/fsrs.ts` | FSRS-5 调度 |
| `tests/spell.test.ts` | 13 | `src/lib/spell.ts` | 拼写纠错编辑距离 |
| `tests/exercises.test.ts` | 32 | `src/lib/exercises.ts` | 练习模式调度/挖空/词形 |
| `tests/books.test.ts` | 9 | `src/lib/books.ts` | 词书目录与导入 |
| `tests/useCountUp.test.tsx` | 7 | `src/lib/useCountUp.ts` | 数字递增动画 Hook |
| **合计** | **83** | | **通过率 100%** |

### 2.1 fsrs.test.ts（22 用例）

- `GRADES`/`GRADE_META`：四档 1..4 与标签/快捷键映射
- `toCard`：新卡（state=0）→ `createEmptyCard()`；复习卡 elapsed_days/scheduled_days 换算；last_review 为空时的归零行为
- 新卡首次评分：Again→Learning（≤2 分钟）、Easy→Review（≈8 天）、四档到期时间梯度、学习链 Again→Good→Good 最终 Review
- 复习卡：Again→Relearning；Hard/Good/Easy 保持 Review；重复 Good 后 stability>0、difficulty 在 [1,10]；limits 边界（lapses 递增）
- `previewOptions`：4 个选项、文本与调度同源（所见即所得）、Easy 显示"天"
- `intervalText`：1 分钟内/分钟/小时/天各档边界（0、负数、60s、59min、61min、24h、2 天）
- `stateLabel`：新词/复习/巩固中（含未知状态兜底）

注：ts-fsrs v5.4.2 的 fuzz 为确定性随机（同卡+同 rating+同 now → 同结果），repeat 与 next 结果一致，故"预览与实际评分一致"断言可靠。

### 2.2 spell.test.ts（13 用例）

全部围绕 `editDistance`（Damerau-Levenshtein）：相等=0、空串、相邻换位=1（receive/recieve）、替换=1、kitten→sitting=3、文档示例 recived→receive=2、多编辑累加、**长度差>2 剪枝直接返回长度差**（内部实现细节）、长度差=2 时仍走完整 DP、大小写敏感、换位+编辑组合、长词剪枝。

### 2.3 exercises.test.ts（32 用例）

- 常量完整性（7 种模式唯一、DEFAULT_MODES 不含 listen）
- `parseModes`/`serializeModes`：null/空/全非法回退默认、合法过滤、往返一致
- `buildSequence`：新词跳过默写/听写、self 固定首位、无原句排除 cloze/scramble、poolSize<4 排除四选一、过滤后为空回退 `['self']`、非新词保留全部
- `deferGap`：答错恒 2、答对随轮次递增、上限 8~9、最小值单调不降
- `wordForms`：null/空→[]、形代码过滤、去重、trim、>48 字符过滤
- `blankWord`：原形命中、词形命中变体（went→go）、大小写不敏感、词边界（going 不挖 go）、无命中返回原文、正则转义（3.14、e-mail）、多次出现替换首个

### 2.4 books.test.ts（9 用例）

通过 `vi.mock("../src/lib/db")` 整模块 mock 掉 Tauri 依赖（db.ts 顶层 import @tauri-apps/plugin-sql，Node 不可加载），`getAppMock` 提供 fake db（select/execute 记录调用）；fetch 用 `vi.stubGlobal` 注入假响应：

- `fetchCatalog`：成功解析、非 2xx 抛状态码错误、网络异常传播
- `importBook`：空词表（fresh=0→"词都已在库"分支，仅清 deck_removals）、全部已在库大小写不敏感去重、混合新词建卡（参数断言）、**>300 词分批 INSERT（3 批 300/300/48）**、tombstones 分批、deck_words 按 400 分批、词书内容 404 抛错、getApp 失败传播

### 2.5 useCountUp.test.tsx（7 用例，happy-dom）

通过受控 rAF 驱动 + 模拟 `performance.now`，完全确定性地推进动画帧：

- 初始 0 → 进度 50% 时值为 94（easeOutQuart 精确值）、100% 时 100 并停止调度
- 完成后不再触发多余帧
- `prefers-reduced-motion` → 立即跳目标值、不启动动画
- target 为 NaN/Infinity → 不启动动画、保持 0
- 卸载时 `cancelAnimationFrame` 被调用
- target 变化触发重跑（首帧前保留旧值，首帧回落到 0 再涨）
- **duration=0 边界探针**：产生 NaN（疑点 4，见 §5）

---

## 3. 覆盖率概览（vitest --coverage，v8）

| 文件 | % Stmts | % Branch | % Funcs | % Lines | 未覆盖行 |
|---|---|---|---|---|---|
| books.ts | 100 | 100 | 100 | 100 | — |
| spell.ts | 100 | 100 | 100 | 100 | — |
| useCountUp.ts | 100 | 100 | 100 | 100 | — |
| exercises.ts | 96.07 | 93.02 | 100 | 100 | 58, 103 |
| fsrs.ts | 87.5 | 100 | 85.71 | 84 | 93-96 |
| **合计** | **96.22** | **96.51** | **97.05** | **96.55** | |

- exercises.ts 未覆盖：58 行（deferGap 随机 ±1 的其中一支）、103 行（blankWord 空形跳过支）
- fsrs.ts 未覆盖 93-96：`speak()` 依赖浏览器 `SpeechSynthesisUtterance`/`speechSynthesis`，Node 环境不可测（属预期可测性边界，见 §4）
- coverage/ 下生成 text/json/html 三类报告

---

## 4. 构建与类型检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `npm test` | ✅ 5 文件 / 83 用例全部通过（489ms） |
| 覆盖率 | `npm run test:coverage` | ✅ 通过，覆盖率如上 |
| 前端构建 | `npm run build`（tsc && vite build） | ✅ 通过，1875 modules，dist 输出正常（1.83s） |
| Rust 编译 | `cd src-tauri && cargo check` | ✅ 通过（dev profile，1.65s） |

测试文件在 `tests/` 下，不在 `tsconfig.json` 的 `include: ["src"]` 范围内，不影响 tsc 构建；`tsc` 类型检查零错误。

---

## 5. 发现的源码疑点（供 bug-hunter 核对）

### 疑点 1：buildSequence 中"新词跳过默写/听写"存在死条件

`src/lib/exercises.ts:56-58`：

```ts
if (isNew && !NEW_WORD_MODES.includes(m)) return false;          // ①
if ((m === "dictation" || m === "listen") && isNew && reps === 0) return false;  // ②
```

`NEW_WORD_MODES = ["self", "choice_en", "choice_zh", "cloze", "scramble"]` **硬编码不含 dictation/listen**，所以 isNew 时 ① 已排除二者，② 是永远不产生独立效果的死条件。注释语义"新词跳过默写/听写（先认识后练）"，但**即使新词已练过（reps>0）也永远不会带默写/听写**——若产品意图是"练过的新词可以默写"，此处实现与注释不一致。测试按当前实际行为锁定（`tests/exercises.test.ts` "新词但已练过"用例）。

### 疑点 2：blankWord 对以非单词字符结尾的词（如 "c++"）无法挖空

`src/lib/exercises.ts:104-105` 使用 `\b${esc(w)}\b` 词边界。对 `c++`：尾字符 `+` 非 `\w`，串尾处 `\b` 不成立 → 匹配失败，返回 `found: false`。测试已按实际行为锁定（"疑点：C++ 无法命中"用例）。影响面：词库中如收录 "e-mail"（尾字符字母，可正常挖空）；以非字母收尾的词（缩写、符号词）会失效。若出现此类词，建议对非 `\w` 尾字符特判。

### 疑点 3：importBook 复活语义只覆盖 fresh 词，全已在库时不复活

`src/lib/books.ts:32-37` tombstone 清理循环遍历 `fresh`（新词）。当整本书词都已在库时（fresh=0），**不清理任何删除墓碑**——若某在库词带删除墓碑，重新导入不会复活它，与注释"收词即复活"的语义存在边界差（deck_removals 仍会清空，标签可恢复）。已在测试中锁定（books.test.ts 断言 tombstones 不执行）。

### 疑点 4：useCountUp duration=0 时产生 NaN 动画值

`src/lib/useCountUp.ts:15-17`：`p = Math.min(1, (now - t0) / duration)`，duration=0 时 `(0-0)/0 = NaN` → `eased=NaN` → `setValue(NaN)`。调用方目前只传默认 900ms 无触发路径，但属于未防护的边界缺陷（若接入 duration 可配的 UI 即暴露）。测试以"边界探针"用例锁定（断言 `Number.isFinite(result.current) === false`）。

### 疑点 5（轻微）：toCard 对 state≠New 但 due 为 null 的防御不足

`src/lib/fsrs.ts:42`：`const due = new Date(row.due!)`，若 DB 行 state>0 而 due 为 NULL（异常数据），会得到 1970 年 epoch 时间而非报错或兜底，可能让卡片显示为"已过期很久"。正常写入路径不会产生此数据，属防御性编码建议。

---

## 6. 可测性评估（Tauri 依赖模块）

以下模块顶层依赖 `@tauri-apps/plugin-sql` / `@tauri-apps/api/*`，Node 环境无法加载，**未做硬测**（与任务预期一致）：

| 模块 | 依赖 | 建议 |
|---|---|---|
| `src/lib/db.ts` | plugin-sql（Database.load）、api/event（emitTo） | 需 Tauri 集成测试或 SQL mock 层 |
| `src/lib/sync.ts` / `src/lib/cloud.ts` | plugin-http / plugin-sql | 需网络 mock + 集成环境 |
| `src/lib/neath.ts` | plugin-http 等 | 同上 |
| `src/lib/capture.ts` | plugin-clipboard 等桌面 API | 需桌面环境 |
| `src/lib/books.ts` | **本身纯逻辑**，仅经 `./db` 间接触达 Tauri | ✅ 已通过 vi.mock 全量覆盖 |

其中 `books.ts` 的 `fetchCatalog`/`importBook` 本可直测，唯 `importBook` 引用 `getApp()`；测试已用模块 mock 隔离，覆盖率 100%。

---

## 7. 总结

- ✅ 测试基础设施就绪：Vitest 5 + 覆盖率 + Hook 测试环境，脚本 `npm test` / `npm run test:coverage`
- ✅ 83 个用例全部通过，纯逻辑模块覆盖率 96.22%（语句）/ 96.51%（分支）
- ✅ `npm run build`（tsc && vite build）通过，`cargo check` 通过
- 🔍 记录 5 处源码疑点（2 处实现与注释不一致、1 处正则边界缺陷、1 处除零边界、1 处防御性建议），均已由测试锁定实际行为，供 bug-hunter 核对