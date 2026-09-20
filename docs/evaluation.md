# 浸词 immerso — 架构与质量评估报告

> 评审对象：`E:\immerso`（Tauri 2 + React 19 + TypeScript + Vite 桌面背单词应用，Windows / macOS）
> 评审方式：只读静态审查（源码逐文件通读 + 配置核对 + 依赖审计 + SQLite 资源检查），未运行应用、未修改任何代码。
> 评审范围：`src/`（前端 18 个源文件）、`src-tauri/src/`（Rust 后端）、`src-tauri/*.json`（Tauri 配置）、`Cargo.toml`、`package.json`、`vite.config.ts`、`tsconfig.json`、`dist/` 产物、脚本与 CI。
> 评审日期：2026-09（版本 v1.4.2 / v1.4.3 未发布 HEAD）

---

## 目录

1. [总体结论](#1-总体结论)
2. [架构合理性](#2-架构合理性)
3. [技术选型与依赖健康度](#3-技术选型与依赖健康度)
4. [代码组织与可维护性](#4-代码组织与可维护性)
5. [安全](#5-安全)
6. [性能与资源](#6-性能与资源)
7. [云同步设计](#7-云同步设计)
8. [可测试性](#8-可测试性)
9. [结论表](#9-结论表)

---

## 1. 总体结论

浸词是一个**功能完整、工程细节扎实、安全基线明显高于同类个人项目**的 Tauri 桌面应用。核心亮点集中在三处：

- 多窗口 + 全局热键 + 托盘常驻的桌面集成（划词直加、快速收词小窗）做了大量真实环境才踩得到的边界处理（剪贴板还原、Space 切换、辅助功能权限判定），代码注释详尽，读起来像一个"被真实用户打磨过"的产品；
- 云同步的合并模型（墓碑 + LWW + 复习指纹去重 + 任务合并防重入 + 自动节流）演进成熟，`CHANGELOG.md` 记录了清晰的迭代路径；
- 安全基线：capabilities 权限收敛、严格 CSP、SQL 全参数化、Rust 侧 URL 白名单，均高于"个人学习项目"的常规水平。

主要短板：**可测试性为零**（无任何测试文件，测试基建半途而废）、**两个大单文件**（Review.tsx 834 行 / db.ts 609 行）推高维护成本、**25MB 字体 + 85MB 词典库**拖累安装包与首启体验、以及**两个"前端可控任意路径"的 Rust 命令**构成安全边界缺口。

**综合成熟度评级：3.5 / 5**（详见 [结论表](#9-结论表)）。

---

## 2. 架构合理性

### 2.1 总体分层

```
┌─ WebView（前端）────────────────────────────────────────────┐
│  main.tsx ──按窗口 label 分流── App / QuickCapture           │
│  views/（Home/Search/Review/Settings/Stats/Library）         │
│  lib/（db/fsrs/sync/cloud/neath/capture/spell/exercises/…）  │
│        │ invoke() / plugin-sql / plugin-http / plugin-fs     │
└────────┼─────────────────────────────────────────────────────┘
         ▼
┌─ Rust（src-tauri/src/lib.rs，721 行）────────────────────────┐
│  8 个 command：热键/剪贴板/小窗交接/IPC 外 HTTP/备份文件读写   │
│  SQLite ×2（dict.db 只读词典 + immerso.db 用户库）             │
└──────────────────────────────────────────────────────────────┘
```

- **双数据库分离**是正确决策：`db.ts:14-15` 把 85MB 只读词典库（`sqlite:dict.db`）与用户库（`sqlite:immerso.db`）各自单例懒加载，词典查询不污染/不被用户数据拖累，备份只需导出一个 `immerso.db`。`src-tauri/src/lib.rs:674-693` 负责把打包的 dict.db 按"大小不同即新版"策略释放到数据目录，规避了 sqlx 对 Windows 绝对路径连接串的解析问题（注释交代清楚）。
- **职责划分清晰**：系统级能力（全局热键、模拟 ⌘C、托盘、窗口集合行为、跨进程 HTTP）留在 Rust（`lib.rs` 8 个 command，`lib.rs:619-628`）；业务规则（FSRS 调度、合并语义、收词复活、每日额度）留在前端 `lib/`，由 `@tauri-apps/plugin-sql` 直连 SQLite。这是 Tauri 生态的标准形态，前后端边界选择合理——避免了"把业务搬进 Rust 却仍要从前端传参"的双层重复。
- **数据流单向清晰**：UI → `lib/db.ts`（SQL 参数化调用）→ SQLite；跨窗口刷新靠 `emitTo("main","library-changed")`（`db.ts:18-20`，Library.tsx:115-121 监听）。没有 Router，视图切换是 `App.tsx:24-27` 的简单 state + 转场动画类，对 6 个静态视图足够。
- **State 管理**：无任何全局状态库（无 zustand/redux/jotai），全部组件本地 state + ref。对于"单用户单窗格交互"的应用这是合理的克制；但代价是 Review.tsx 约 15 个 useState/useRef 共存（见 §4），状态流转只能靠阅读钩子顺序理解。
- **瑕疵**：`main.tsx:11-12` 用 `getCurrentWebviewWindow().label` 分流两个根组件，耦合了"窗口名"与"应用入口"；当前只有 quick/main 两个标签尚可，若未来新增窗口（如设置小窗）会变脆。另一个小问题：`db.ts:233` 一行 `async function dictEntries(...) {  const map ...` 出现**行内紧贴两个声明**的排版错误（`{  const`），是代码卫生小瑕疵。

### 2.2 值得肯定的一致性约定

- 时间格式统一：卡片 `due/last_review/added_at` 用 JS `toISOString()`（UTC ISO），`reviews.reviewed_at` 与墓碑 `deleted_at` 用 SQLite `datetime('now','localtime')`，且所有跨格式比较都显式对齐（`db.ts:306-317`、`db.ts:514-516`、`sync.ts:134`），并注释说明为何不用字典序跨格式比较——这类"时间格式陷阱"能在一处约定、处处注释，是成熟的信号。
- 收词即复活、删除即墓碑、书移除即 `deck_removals`：三个互相关联的本地去重语义在 `addCard`/`deleteCard`/`deleteDeck`/`importBook` 各处一致复现（`db.ts:256-257`、`db.ts:514-517`、`db.ts:546-551`、`books.ts:32-39`）。

---

## 3. 技术选型与依赖健康度

### 3.1 前端依赖（package.json）

| 依赖 | 声明版本 | 实际安装 | 评价 |
|---|---|---|---|
| react / react-dom | ^19.1.0 | 19.2.8 | 当前主线，合理 |
| vite | ^8.0.16 | 8.2.2 | 很新，Tauri 官方模板已跟进 |
| typescript | ~6.0.3 | 6.0.3 | 非常激进（TS 6 主线），`tsc` 门禁在 `build` 脚本 |
| tailwindcss | ^4.3.3 | 4.x | v4 无 tailwind.config，CSS-first，与 Vite 插件组合干净 |
| ts-fsrs | ^5.4.2 | 5.4.2 | FSRS-5 标准实现，选型正确 |
| lucide + morphicons | ^1.41 / ^1.7 | — | 两套图标库并存（`Settings.tsx:4-5` 混用 `MorphIcon` 与 `Sun/Moon`），体积略冗余，可用一套收敛 |
| @tauri-apps/api + 8 个插件 | ^2.x | 2.x | 覆盖 clipboard/fs/http/sql/notification/opener，齐全 |

- **依赖卫生问题**：`package.json:27-36` 的 devDependencies **与 `package-lock.json` 记录不一致**——lockfile 根部还含 `vitest`、`@testing-library/react`、`@testing-library/jest-dom`、`@vitest/coverage-v8`、`happy-dom`、`@types/node` 等 6 项（已实际安装于 node_modules），但 `package.json` 中已删除。说明项目曾搭建过测试基建后被移除清单条目、锁文件未同步（或反方向：曾安装后未回收）。后果：`npm ci` 会回退到无测试工具的状态，而当前 node_modules 又能 import vitest——环境漂移，`npm audit` 却显示 0 漏洞（全量，含 dev，2026-09 复查）。

### 3.2 Rust 依赖（Cargo.toml + Cargo.lock）

- tauri 2.11.5、tauri-runtime 2.11.3、sqlx 0.8.6（经 tauri-plugin-sql）、serde/serde_json、enigo 0.6.1、reqwest——均为当前主流稳定版本，无高危/废弃 crate。
- **两版 reqwest 共存**（Cargo.lock 同时含 0.12.28 与 0.13.4，后者大概率由 plugin-http 传递引入），编译时间与最终体积略有浪费。
- macOS 专用依赖（`Cargo.toml:43-46`：core-foundation、objc2、objc2-app-kit）+ `macos-private-api` feature（`Cargo.toml:22`、`tauri.conf.json:13`）用于透明小窗与辅助功能检测，注释明确"tauri 已引入同版本，不新增编译量"，判断专业。
- `Cargo.toml:50-55` 发布优化齐全：`lto = true`、`codegen-units = 1`、`panic = "abort"`、`strip = true`。
- **审计结论**：`npm audit`（prod + dev 全量）0 漏洞；`cargo audit` 未在 CI/脚本中配置（见 §8），是唯一缺口。

### 3.3 构建链

- `vite.config.ts` 标准 Tauri 模板配置（固定 1420 端口、忽略 src-tauri 监听），`build = tsc && vite build` 带类型门禁。
- CI（`.github/workflows/release.yml`）：tag 触发 → npm ci → 生成词典资源 → tauri-action 双平台（Windows NSIS / macOS universal dmg），并自动从 CHANGELOG 提取发布说明。CI 成熟度良好。`ci.yml`（334 字节）作为轻量门禁在工作流中存在，但未看到测试步骤（与 §8 呼应——没有可跑的测试）。

---

## 4. 代码组织与可维护性

### 4.1 模块结构（合理部分）

- `lib/` 划分清晰：db（数据访问）、fsrs（调度封装）、sync/cloud（备份与云同步）、neath（匿词）、capture（收词管线）、spell（纯函数纠错）、exercises（练习模式纯函数）、books（词书导入）、theme/platform/useCountUp 工具。**纯逻辑与 React 组件分离良好**，7 个纯逻辑模块不依赖 React。
- `views/` 6 个视图 + App 导航 + TitleBar + components（Icon/DeckPicker）——目录语义明确。

### 4.2 三个"大文件"评估

| 文件 | 行数 | 内容 | 评估 |
|---|---|---|---|
| `views/Review.tsx` | 834 | 8 种练习模式 × 教学/间隔/评分/键盘状态机 | **高风险复杂度**：单一组件同时承担出题（self/dictation/choice_en/choice_zh/listen/cloze/scramble）、间隔式练习插入队列（`Review.tsx:251-272`）、忘记重试、键盘分发（`Review.tsx:400-462`，依赖数组 16 项）、评分锁防连发（`Review.tsx:139`、`285-289`）。逻辑内聚但不可单元测试、难回归定位。键盘 handler 的 16 项依赖数组是典型的"改一处难验证"区域。 |
| `lib/db.ts` | 609 | 双库连接 + 全部 SQL + 业务规则（收词复活/墓碑/词书/额度） | **数据访问与业务混合**：`deleteCard:502-518`、`deleteDeck:533-584` 内含多步业务编排（孤儿判定、批量墓碑、孤儿 sources 清理），已不是"DAO"而是一层业务服务；同时 `getTodayStats:323-353` 又揉进 5 条统计 SQL。建议抽出 `deckService`/`cardService`。 |
| `views/Settings.tsx` | 524 | 6 个 Section × 表单状态 | 20 个 useState 集中在单一渲染组件（`Settings.tsx:144-164`），Section 结构本身已组件化（Section/OptionRow/Segmented/Check/Switch），主组件偏"组合层"，可接受；但云同步块（`Settings.tsx:338-477`）约 140 行内联逻辑，可拆 `CloudSyncSection`。 |

### 4.3 重复代码

- `Translation` 组件重复定义 3 次：`Review.tsx:20-30`、`Search.tsx:14-24`，QuickCapture.tsx:199 又内联一遍——同一"ECDICT `\n` 字面拆分释义"逻辑三处拷贝，应提升为公共组件（e.g. `components/Translate.tsx`）。
- `shuffle` 实现两份：`exercises.ts:33-40`（Fisher-Yates）与 `Review.tsx:41-42`（sort-by-random）；`norm`（trim/toLowerCase）在 `Review.tsx:40`、`db.ts:130`、`capture.ts` 多处重复。
- ECDICT 常量字符 `"\\n"` 拆分的约定散落在 Review/Search/QuickCapture 与 `fsrs.ts:75-82` 的 interval 文案逻辑之外。

### 4.4 其它可维护性观察

- 无 i18n 抽象：全部文案硬编码中文（`index.html` 仍 `lang="en"` 与 `index.html:2` 不符），扩展到其他语言需全量重构文案层。
- 无 ESLint/Prettier 配置（package.json 无 lint 脚本），风格靠 TS 严格模式与人工；`db.ts:233` 的排版错误证明缺少格式化门禁。
- 注释质量是加分项：`lib.rs` 每段系统级 hack 都有"为什么"注释（如 `lib.rs:187-189` 惰性建窗原因、`lib.rs:496-506` 剪贴板序号判定），是维护性的重要补偿。

---

## 5. 安全

### 5.1 做得好的部分

1. **capabilities 权限最小化**（`src-tauri/capabilities/default.json`）：
   - `fs:` 仅限 `$HOME/.neath-api-key` 与 `$HOME/.immerso-gh-token` 两个点文件的读写（`default.json:22-32`），**无全盘读写**——CHANGELOG v1.4.2 明确记录从 `**` 收窄，是主动安全收口的实证。
   - `http:` 仅白名单 `neath.clingword.com`、`api.github.com`、`gist.githubusercontent.com`（`default.json:33-40`）。
   - 无 `shell`、无 `core:window` 的非必要项（仅最小化/最大化/关闭/拖拽/隐藏）。
2. **CSP 严格**（`tauri.conf.json:28`）：`script-src 'self'`（无 unsafe-eval）、`img-src 'self' data: blob:`、`connect-src 'self' ipc: http://ipc.localhost`。`style-src` 含 `'unsafe-inline'` 属 React 内联 style 的常规妥协，可接受的权衡。
3. **SQL 全参数化**：grep 全部查询均使用 `?` 占位符（`db.ts` 全程）；动态 SQL 段仅由内部常量拼接（`deckClause`、`chunk.map(()=>"?")`），用户输入永不进入 SQL 文本。**无注入面**。
4. **自定义命令面小**：Rust 侧仅 8 个 command（`lib.rs:619-628`），且 `gist_http` 在 Rust 侧校验 URL 白名单（`lib.rs:552-556`——`starts_with("https://api.github.com/")` 前缀匹配可挡 `api.github.com.evil.com` 类绕过，因为要求紧跟 `/`）。
5. **敏感操作不前置到前端 fs**：导出/导入改走 Rust 命令直写对话框路径（`lib.rs:586-597`），避免给前端全盘 fs 权限（sync.ts:281-282 注释说明了设计意图）。

### 5.2 风险点（按严重度）

1. **【高】`write_backup_file` / `read_backup_file` 接受任意路径且无任何校验**（`lib.rs:589-597`）。命令签名只有 `path: String`，由前端 `invoke` 传入（`sync.ts:293`、`sync.ts:309`）。对话框只是 UX 约束，**不是安全边界**——一旦前端被注入脚本（供应链 JS、XSS、未来加载远程内容），即可调用这两个命令**读写本机任意文件**（例如读取 `~/.ssh/id_rsa` 内容、覆盖用户文档），完全绕过 §5.1 中 fs 插件的路径白名单设计。修复方向：Rust 侧校验绝对路径位于系统临时/对话框返回目录，或限制扩展名/大小。
2. **【高】密钥明文落盘且无系统级保护**：GitHub Token 存 `~/.immerso-gh-token`、匿词 Key 存 `~/.neath-api-key`（`cloud.ts:13-30`、`neath.ts:35-37`），Windows 下为普通文件、无 ACL 限制，任何本机用户/进程可读；且无"读取后提醒权限范围"或定期校验失效的机制。代码注释（`cloud.ts:2`）明示这是"与本机其他工具同纪律"的取舍，但对持 `gist` 写权限的 Token 而言，泄露即数据可被篡改。建议迁移到系统凭据库（如 `keyring` crate / Windows Credential Manager）。
3. **【中】`core:webview:allow-internal-toggle-devtools`**（`default.json:13`）在生产构建仍开放 devtools 开关权限（虽无 devtools feature 时未必生效），属多余权限面，建议按平台/构建裁剪。
4. **【中】分发信任**：macOS 构建未签名（README.md:42 明示"未签名：首次打开右键→打开"），用户需自行绕过 Gatekeeper。
5. **【低】CSP `devCsp: null`**（`tauri.conf.json:29`）：开发模式无 CSP，若开发者机器被攻破则 dev 会话无防护（常见做法，可接受但值得记录）。

### 5.3 威胁模型小结

应用的威胁模型核心是"本机单用户 + 不加载远程内容 + 需要离线查词"，因此 WebView 注入向量有限。在此模型下，§5.2-1（任意路径读写）是**唯一能穿越权限模型边界**的实质缺口，其余属于纵深防御问题。

---

## 6. 性能与资源

### 6.1 资源体积

| 资源 | 大小 | 去向 | 影响 |
|---|---|---|---|
| `src/assets/fonts/NotoSerifSC-var.ttf` | **25,125,512 B ≈ 24MB** | `@font-face` 打包进 dist（`index.css:182-187`、dist 产物 25,125,512B） | 安装包增大 ~24MB；WebView 加载页面时按需取用（`font-display: swap`（index.css:186）缓解 FOIT，但 `word-serif` 首次渲染仍触发整份字体读取；**未 woff2 压缩**（可变字体 woff2 可压到约 1/3）**未子集化** |
| `src-tauri/resources/dict.db` | **89,395,200 B ≈ 85MB** | `tauri.conf.json:35` resources 打包 + 首启释放（lib.rs:674-693） | 安装包预计 >120MB（NSIS 压缩后约 60-80MB）；**首次启动复制 85MB** 到数据目录（按大小比较判新，`lib.rs:681-682`），慢盘/机械盘首启卡顿数秒 |
| `dist/assets/index-*.js` | 342,260 B | 单文件不分包 | react + lucide + morphicons 全量进首包；可 `manualChunks` 或按路由懒加载 |

字典库行数实测（sqlite3）：`dict` 表 770,611 行、`lemma` 表 78,177 行，结构含 `idx_dict_word_nocase` 唯一索引。

### 6.2 首屏冷启动路径（每次启动）

1. Rust `setup`：托盘、热键、dict.db 释放/比对（`lib.rs:672-697`）——日常启动只有一次 `metadata` 大小比对，开销小；**首启为 85MB 复制**。
2. WebView 加载 index → `main.tsx` 同步 `applyTheme`（防闪色）→ `App`。
3. `Home.tsx:28-51`：`getTodayStats`（串行 5-6 条 SQL，db.ts:323-353）+ `getDecks` +（首次自动云同步，5 分钟节流后若命中则一整趟 GitHub 往返）。
4. 进入主页后 `getCurrentDeck` 等设置读取各 +1 条 SQL。

### 6.3 可优化热点

1. **`suggestEntries` 的全量编辑距离扫描**（`db.ts:201-221`）：查询彻底无结果时，对**前 2 万常用词**逐一计算 Damerau-Levenshtein（`spell.ts:9-26` 是 O(len²) 动态规划），最坏数百毫秒；虽有长度剪枝（`spell.ts:12`、`db.ts:212`），仍建议限定抽样或预构建 BK-tree/SymSpell 索引。
2. **中文查词的 `LIKE '%…%'` 全表扫描**：`db.ts:146-158` 注释自认 ~110ms；本地单用户可接受，但若未来扩词典库或加"模糊音"查询需索引化（FTS5）。
3. **`Stats.tsx:11-23` 把整表 `reviews` SELECT 到前端再做日期分组**：累计复习记录上万后内存/GC 放大，且 `heatGrid` 每次进统计页全量重算；应下沉为 SQL 聚合（按日 GROUP BY）。
4. **逐词 N+1 查询**事务性路径（`neath.ts:46-71` 每词 1 查 1 插、`sync.ts:214-272` 每卡先 SELECT 再 UPDATE/INSERT）——同步/导入大数据时会有数千次 IPC 往返；`books.ts`/`deleteDeck` 已示范批量 chunk 写法，建议统一。

### 6.4 正面项

- `getQueue` 每批 LIMIT 500 + `dictEntries` 200/块批量取词（`db.ts:355-388`、`db.ts:233-246`），词典查询已避免逐词往返；
- 无限滚动列表分页固定 200/页（`LIB_PAGE_SIZE`，db.ts:425）且带请求代际防串台（Library.tsx:49-79）；
- `useCountUp` 尊重 `prefers-reduced-motion`（useCountUp.ts:8-10），动画性能无阻塞风险。

---

## 7. 云同步设计

### 7.1 架构

GitHub 私有 Gist 作为 KV 存储：`cloud.ts:92-130` 每次同步 = **拉远端 → 合并进本库 → 全量（超集）PATCH/POST 回传**。数据经 Rust 侧 `gist_http`（`lib.rs:546-584`，reqwest 直连、15s 连接/120s 总超时、强制 User-Agent），有意绕开 plugin-http 的 WebView IPC 字节数组放大问题（`cloud.ts:32-37` 注释解释——该决策避免了"请求取消但服务端已建 Gist"的死循环）。

### 7.2 冲突处理设计（`sync.ts:117-278`）

| 场景 | 策略 | 证据 |
|---|---|---|
| 双端同时学过一词 | `last_review` 字典序"新者胜"，相等则保留本机 | `sync.ts:240-254` |
| 一端删除 | 墓碑（`tombstones`）带时间戳的删除指令；合并先应用远端删除 | `sync.ts:122-153` |
| 删除后本机又重收 | `added_at >= deleted_at` 判定"重收优先"，清掉旧墓碑 | `sync.ts:162-169`、`sync.ts:217-223` |
| 复习记录重复 | （词,时间,评分）指纹集合去重补插 | `sync.ts:172-179`、`sync.ts:257-271` |
| 整本移除词书回流 | `deck_removals` 本机记录，并集只增不删时跳过 | `sync.ts:86-98`（配合 db.ts:546-551） |
| 同词异大小写 | 迁移 v7 重建 NOCASE 主键（`lib.rs:119-136`） | — |

这套"墓碑 + LWW + 指纹 + 本地移除记录"模型对"单人双设备"场景是**正确且克制**的：不引入 CRDT/向量时钟的复杂度，靠"全量超集回传"收敛分叉。CHANGELOG 显示经历了"复活 bug → 墓碑版本 → 重收优先"的完整修复链，成熟度值得肯定。

### 7.3 节流与并发

- **任务合并防重入**：`cloudSync` 单例化（`cloud.ts:80-90`），自动/手动/复习结束三种触发共享同一任务，避免并发各读旧 id 互建 Gist；`adoptGist` 显式排到在途任务之后（`cloud.ts:162-175`）。
- **自动同步 5 分钟节流**（`cloud.ts:182-196`），Home 每次挂载触发不至于反复全量同步。
- Gist >1MB 的 API 截断有兜底（`cloud.ts:54-76` 转 raw_url 读取）。

### 7.4 风险与改进

1. **【中】全量回传无增量**：每次同步都上传整个备份 JSON（含全部复习历史，CHANGELOG 提到"近 1MB"）。词库增长到数万词、两年复习记录后体积继续膨胀，GitHub Gist 单文件上限附近（约 1MB 截断阈值）将先撞上**写端**（PATCH 大文件可能 422/截断写坏）。建议引入增量或至少按 `last_cloud_sync` 过滤 `reviews` 的增量导出。
2. **【中】无冲突"报告"之外的用户可见分支**：合并冲突时只给一行文本（`sync.ts:274-277`），没有"保留哪台"的交互选择；对个人工具可接受，但若两台设备长时间离线后首次同步，用户无从知晓哪份 last_review 被覆盖。
3. **【低】错误处理方向正确但粒度粗**：全链 `throw Error(中文)` → UI 文本（`cloud.ts:57`、`117`、`123`），无重试/退避；网络抖动时用户只能再点一次。
4. **【低】Gist 泄露面**：若 Gist 被用户误设为公开，全量词库+原句（可能含个人语境原文）公之于众——`description: "immerso 同步数据（勿手动编辑）"`（`cloud.ts:109-111`）已有提醒，但创建时未强制校验 `public: false` 标志位（创建 Gist 默认私有，POST body 未显式声明 public 字段时 GitHub 默认私有，此处安全，但建议显式声明）。

---

## 8. 可测试性

### 8.1 现状：测试基建半途而废，测试数 = 0

- `glob **/*.{test,spec}.*`：项目自身**无任何测试文件**（仅 node_modules 内三方库自带）。
- `package.json` **无 `test` 脚本、无 vitest.config**。
- 但是：`package-lock.json` 根部记录着 `vitest ^5.0.1`、`@vitest/coverage-v8`、`@testing-library/react`、`@testing-library/jest-dom`、`happy-dom`（且 **node_modules 实际已安装**）——测试工具链"装了又删清单、没删产物"，处于漂移状态。
- Rust 侧同样无 `#[cfg(test)]`（lib.rs 全文无测试模块），`src-tauri` 无 tests/ 目录。

### 8.2 可测试性分层评估（代码本身质量中上）

| 层 | 可测性 | 说明 |
|---|---|---|
| `lib/spell.ts`（editDistance） | ★★★★★ | 纯函数零依赖，注释明示"node 可直测"（spell.ts:1-2）——但 scripts/ 下并无对应测试文件 |
| `lib/exercises.ts`（buildSequence/wordForms/blankWord/deferGap） | ★★★★★ | 纯函数，边界齐全（无原句、池不足 4、新词过滤） |
| `lib/cloud.ts`（parseGistId） | ★★★☆☆ | 纯函数可测；其余依赖 invoke/getSetting 全局单例 |
| `lib/fsrs.ts`（toCard/intervalText） | ★★★★☆ | 大部分纯函数；`toCard` 的 due/last_review 日期边界值得覆盖 |
| `lib/db.ts` / `lib/sync.ts`（mergeIntoLocal） | ★★☆☆☆ | 直接依赖 `@tauri-apps/plugin-sql` 的模块级单例 `Database`（db.ts:11-15），无接口层/DI；merge 是最需要回归保护的逻辑却最难测（需 mock 插件或真起 sqlite） |
| 视图组件 | ★☆☆☆☆ | 无 testing-library 用例；Review 的状态机几乎不可单测 |

### 8.3 建议优先级

1. 先接住 `mergeIntoLocal`（墓碑/复活/去重指纹是历史 bug 高发区，CHANGELOG 可证）：抽出 `BackupMerger` 纯逻辑（接受"查询/执行"函数接口而非全局 DB），配 happy-dom 无关的 node 单测。
2. `spell.ts`、`exercises.ts`、`fsrs.ts` 纯函数层补全会带来最高性价比（无依赖、边界丰富）。
3. 恢复 vitest 配置与 `npm test`/CI 步骤（unused: `ci.yml` 无 test job）。
4. 对 Rust `gist_http` 的 URL 白名单、`clipboard_seq` 平台分支加单元测试。

---

## 9. 结论表

| 维度 | 评级 | 一句话结论 |
|---|---|---|
| 架构合理性 | ★★★★☆ | 双库分离 + 前后端边界正确；state 管理克制得当 |
| 技术选型与依赖健康 | ★★★★☆ | 版本现代、audit 0 漏洞；package.json/lock 漂移、双 reqwest 是杂音 |
| 代码组织与可维护 | ★★★☆☆ | lib/ 分层好、注释佳；Review/db 两大文件 + 三处重复 Translation 拉低分数 |
| 安全 | ★★★★☆ | capabilities/CSP/SQL 参数化扎实；但 2 个任意路径命令是**实质边界缺口**；Token 明文落盘 |
| 性能与资源 | ★★★☆☆ | 25MB 字体 + 85MB 词典拖累安装包/首启；局部 N+1 与全表拉取待优化 |
| 云同步设计 | ★★★★☆ | 墓碑+LWW+去重指纹模型成熟，防重入/节流到位；全量回传与冲突可见性待改进 |
| 可测试性 | ★★☆☆☆ | 测试基建半途而废、0 测试文件；纯函数层本可低成本覆盖 |
| **综合成熟度** | **3.5 / 5** | 产品质量高于个人项目平均，短板集中在"验证与防护"而非"功能与体验" |

---

## 附：Top 5 优点 / Top 5 风险（按优先级）

### Top 5 优点

1. **安全基线扎实**：capabilities 收敛到两个点文件（`capabilities/default.json:22-32`）、CSP 无 unsafe-eval（`tauri.conf.json:28`）、SQL 全参数化、`gist_http` Rust 侧 URL 白名单（`lib.rs:552-556`）——同类项目中少见。
2. **同步合并模型成熟**：墓碑 + LWW + 指纹去重 + 防重入 + 节流（`sync.ts:117-278`、`cloud.ts:80-196`），且 CHANGELOG 记录了完整 bug 修复链，是"迭代出来的正确"。
3. **桌面集成工程细节到位**：剪贴板序号判定防错收（`lib.rs:497-521`）、图片剪贴板还原（`lib.rs:525-534`）、macOS Space/全屏集合行为（`lib.rs:300-339`）、主窗藏放焦点控制（`lib.rs:239-262`）——都是真实环境才踩得出的边界。
4. **双数据库分离 + 时间格式统一约定**：只读词典库/用户库隔离（`db.ts:14-15`），所有跨格式时间比较显式对齐并注释（`db.ts:306-317`、`sync.ts:134`）。
5. **本地数据自持与可迁移性**：离线可用、备份 = 单个 JSON/DB 文件、词书内容包按需导入、无账号依赖（README.md:3-16），配 CI 双平台自动发布。

### Top 5 风险 / 改进点（优先级排序）

| # | 优先级 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | **高** | `write_backup_file`/`read_backup_file` 任意路径无校验，前端可读写本机任意文件，绕过 fs 权限模型 | `lib.rs:589-597` | Rust 侧校验路径（限定临时目录/对话框源目录/扩展名白名单）；或改走受限 `tauri-plugin-fs` scope + dialog |
| 2 | **高** | GitHub Token / Neath Key 明文落盘、无 ACL、无失效检测 | `cloud.ts:13-30`、`neath.ts:35-37` | 迁系统凭据库（keyring/Credential Manager）；至少收紧文件 ACL 并做权限最小化提示 |
| 3 | **中** | 25MB 可变字体 + 85MB 词典库打包 → 安装包 >120MB、首启复制 85MB | `index.css:182-187`、`tauri.conf.json:35`、`lib.rs:674-693` | 字体转 woff2 + 子集化（可压至 ~1/3）；dict.db 换 `--vacuum`/压缩或首启后台流式释放 |
| 4 | **中** | 可测试性为零：0 测试文件、测试基建漂移、merge 逻辑无回归保护 | package.json 无 test、lockfile 残留 vitest、`sync.ts:117-278` | 恢复 vitest 配置与 `npm test`；先补 `mergeIntoLocal`/`spell`/`exercises`/`fsrs` 纯函数单测；CI 加 test job |
| 5 | **中** | Review.tsx 834 行状态机 + db.ts 609 行业务/DAO 混合 + 重复代码 3 处 | `Review.tsx:400-462`、`db.ts:502-584`、`Review.tsx:20`/`Search.tsx:14` | 拆 `useReviewFlow` hook / 子组件；抽 `Translate` 公共组件；db.ts 按 domain 拆 service |

**次要清单**：Stats 全表 reviews 拉前端（`Stats.tsx:11-23`）；suggest 全量 2 万词编辑距离（`db.ts:201-221`）；全量 Gist 回传接近 1MB 截断写端风险（`cloud.ts:107-127`）；无 i18n（`index.html:2` lang="en"）；devtools 权限多余（`default.json:13`）；package.json/lock 漂移；双 reqwest 版本。