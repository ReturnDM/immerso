// 夜 2 测试用：从 dict.db 挑一批高频词灌进 immerso.db 的 cards 表
// 用法：node scripts/seed-cards.mjs [数量=30]
// 幂等：重复运行不会重复插。表结构与 src-tauri/src/lib.rs 的迁移 v1 保持一致。
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const dataDir =
  process.env.IMMERSO_DATA_DIR ??
  join(process.env.APPDATA ?? ".data", "com.returndm.immerso");
const dictDb = new DatabaseSync(join(dataDir, "dict.db"), { readOnly: true });
const appDb = new DatabaseSync(join(dataDir, "immerso.db"));

appDb.exec(`
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
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'manual',
  context TEXT,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);

const limit = Number(process.argv[2] ?? 30);
const words = dictDb
  .prepare(
    `SELECT word FROM dict WHERE tag LIKE '%cet4%' AND bnc > 0 AND word NOT LIKE '% %'
     ORDER BY bnc LIMIT ?`,
  )
  .all(limit)
  .map((r) => r.word);

if (words.length === 0) {
  console.error("dict.db 里没挑到词，确认已导入词库");
  process.exit(1);
}

const insert = appDb.prepare("INSERT INTO cards (word) VALUES (?) ON CONFLICT(word) DO NOTHING");
let added = 0;
for (const w of words) if (insert.run(w).changes > 0) added++;

const total = appDb.prepare("SELECT COUNT(*) c FROM cards").get().c;
console.log(`新收 ${added} 词（ CET4 高频前 ${words.length} ），词库现有 ${total} 张卡`);
