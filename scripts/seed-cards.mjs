// 词库灌入/归队脚本
// 用法：
//   node scripts/seed-cards.mjs [数量=30] [标签=cet4]   按考试标签灌词（自动归入对应词库）
//   node scripts/seed-cards.mjs retag                    把「生词本」里手动脚本灌的词按词典标签重新归队
// 标签→词库：zk中考 gk高考 cet4四级 cet6六级 ky考研 toefl托福 ielts雅思 gre GRE
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
  deck TEXT NOT NULL DEFAULT '生词本',
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

const TAG2DECK = {
  zk: "中考",
  gk: "高考",
  cet4: "四级",
  cet6: "六级",
  ky: "考研",
  toefl: "托福",
  ielts: "雅思",
  gre: "GRE",
};

const arg = process.argv[2] ?? "30";

// --- retag：把无来源的「生词本」卡按词典标签归队 ---
if (arg === "retag") {
  const tags = new Map(
    dictDb.prepare("SELECT word, tag FROM dict WHERE tag != ''").all().map((r) => [r.word, r.tag]),
  );
  const cards = appDb
    .prepare("SELECT id, word FROM cards WHERE deck = '生词本' AND source_id IS NULL")
    .all();
  const update = appDb.prepare("UPDATE cards SET deck = ? WHERE id = ?");
  const order = ["cet4", "cet6", "ky", "toefl", "ielts", "gre", "gk", "zk"];
  let moved = 0;
  for (const c of cards) {
    const tag = tags.get(c.word) ?? "";
    const hit = order.find((t) => tag.split(" ").includes(t));
    if (hit) {
      update.run(TAG2DECK[hit], c.id);
      moved++;
    }
  }
  console.log(`retag 完成：${moved} 张卡按词典标签归入对应词库`);
  process.exit(0);
}

// --- 按标签灌词 ---
const limit = Number(arg) || 30;
const tag = process.argv[3] ?? "cet4";
const deck = TAG2DECK[tag] ?? tag;

const words = dictDb
  .prepare(
    `SELECT word FROM dict WHERE tag LIKE ? AND bnc > 0 AND word NOT LIKE '% %'
     ORDER BY bnc LIMIT ?`,
  )
  .all(`%${tag}%`, limit * 3) // 多取一些，跳过与已有词库重复的
  .map((r) => r.word);

const insert = appDb.prepare(
  "INSERT INTO cards (word, deck) VALUES (?, ?) ON CONFLICT(word) DO NOTHING",
);
let added = 0;
for (const w of words) {
  if (insert.run(w, deck).changes > 0) added++;
  if (added >= limit) break;
}

const total = appDb.prepare("SELECT COUNT(*) c FROM cards").get().c;
const decks = appDb.prepare("SELECT deck, COUNT(*) n FROM cards GROUP BY deck ORDER BY n DESC").all();
console.log(`「${deck}」新收 ${added} 词，词库现有 ${total} 张卡`);
for (const d of decks) console.log(`  ${d.deck}: ${d.n}`);
