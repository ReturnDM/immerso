# 浸词 immerso

桌面背单词应用：**完整自建复习闭环**——词典、收词、FSRS 复习、统计全部本地自持，无账号无云端。Windows 桌面端（Tauri 2）。

## 功能

- **离线词典**：ECDICT 77 万词条，音标 / 双语释义 / 英文释义 / 词频，精确匹配 + 前缀模糊，系统 TTS 发音
- **复习闭环**：ts-fsrs（FSRS-5）调度；全屏沉浸单卡，正面只有单词，空格翻面，认知自评四档（忘记 / 困难 / 良好 / 简单）带间隔预览；键盘流 1-4 评分
- **每日队列**：到期复习卡 + 新词按每日配额入队（设置页可调）
- **收词**：
  - 应用内查词，可带**收词时的原句**（原句会出现在复习卡背面——语境记词）
  - 同步 [匿词 Neath](https://neath.clingword.com) 收藏（只读拉取 API，新词带原句流入队列）
  - 脚本批量导入（`scripts/seed-cards.mjs`）
- **统计**：今日进度环、连续学习天数、累计复习次数、GitHub 式 17 周热力图
- **沉浸**：无边框窗口、深色主题、翻面自动发音、卡片动效
- **数据自主**：SQLite 双文件（只读词典库 + 用户库），备份 = 复制一个 `immerso.db`

## 开发

```bash
# 环境要求：Node 20+、Rust (stable-msvc)、WebView2
npm install
npm run tauri dev        # 开发运行
npm run tauri build      # 产出 NSIS 安装包
```

词典数据（约 66MB CSV）不进仓库，需一次性导入：

```bash
# 下载 ECDICT 的 ecdict.csv 到 .cache/ 后：
node scripts/import-ecdict.mjs   # 生成 %APPDATA%\com.returndm.immerso\dict.db
node scripts/seed-cards.mjs 30   # 可选：灌 30 个 CET4 高频词试玩
```

匿名同步需在用户主目录放置 `.neath-api-key`（匿词 API Key，勿提交）。

## 平台

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `immerso_x.y.z_x64-setup.exe`（NSIS） | 双击安装 |
| macOS 12+（Apple Silicon / Intel 通用） | `immerso_x.y.z_aarch64.dmg` | 未签名：首次打开右键 → 打开，或 `xattr -cr "/Applications/浸词.app"` |

两个安装包由 GitHub Actions 在推送 `v*` 标签时自动构建，统一发布到 [Releases](https://github.com/ReturnDM/immerso/releases)。一套代码双端构建（Tauri），无平台分支代码；macOS 窗口使用系统红绿灯，Windows 使用自绘控制键。

Mac 本地开发需 Xcode Command Line Tools 与 `rustup target add aarch64-apple-darwin x86_64-apple-darwin`。

## 致谢

- 词典数据：[ECDICT](https://github.com/skywind3000/ECDICT)（CC BY-NC 4.0，仅个人学习用途）
- 记忆算法：[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)（FSRS-5）
- 桌面框架：[Tauri 2](https://tauri.app/)

---

个人学习项目，按夜间冲刺节奏开发，慢慢打磨。
