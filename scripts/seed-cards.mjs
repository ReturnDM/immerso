// 词书灌入/归队脚本
// 用法：
//   node scripts/seed-cards.mjs <标签>            全量灌入某考试词书（如 cet4 / cet6 / toefl / ielts / kaoyan / gk / zk / gre）
//   node scripts/seed-cards.mjs <数量> <标签>      只灌前 N 个（按词频）
//   node scripts/seed-cards.mjs retag             把无来源的「生词本」卡按词典标签重新归队
// 标签→词库：zk中考 gk高考 cet4四级 cet6六级 ky考研 toefl托福 ielts雅思 gre GRE
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

const platformDataDir =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : join(process.env.APPDATA ?? join(homedir(), ".data"));
const dataDir = process.env.IMMERSO_DATA_DIR ?? join(platformDataDir, "com.returndm.immerso");
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
CREATE TABLE IF NOT EXISTS deck_words (
  word TEXT NOT NULL,
  deck TEXT NOT NULL,
  PRIMARY KEY (word, deck)
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

const arg1 = process.argv[2] ?? "cet4";
const arg2 = process.argv[3];

// --- retag ---
if (arg1 === "retag") {
  const tags = new Map(
    dictDb.prepare("SELECT word, tag FROM dict WHERE tag != ''").all().map((r) => [r.word, r.tag]),
  );
  const cards = appDb
    .prepare("SELECT id, word FROM cards WHERE source_id IS NULL")
    .all();
  const update = appDb.prepare("UPDATE deck_words SET deck = ? WHERE word = ?");
  const order = ["cet4", "cet6", "ky", "toefl", "ielts", "gre", "gk", "zk"];
  let moved = 0;
  for (const c of cards) {
    const tag = tags.get(c.word) ?? "";
    const hit = order.find((t) => tag.split(" ").includes(t));
    if (hit) {
      update.run(TAG2DECK[hit], c.word);
      moved++;
    }
  }
  console.log(`retag 完成：${moved} 张卡按词典标签归入对应词库`);
  process.exit(0);
}

// --- 灌词：seed <数量> <标签> 或 seed <标签>（全量） ---
let limit = Infinity;
let tag = arg1;
if (/^\d+$/.test(arg1)) {
  limit = Number(arg1);
  tag = arg2 ?? "cet4";
}
const deck = TAG2DECK[tag] ?? tag;

const rows = limit === Infinity
  ? dictDb
      .prepare("SELECT word FROM dict WHERE tag LIKE ? AND word NOT LIKE '% %' ORDER BY bnc DESC, word")
      .all(`%${tag}%`)
  : dictDb
      .prepare("SELECT word FROM dict WHERE tag LIKE ? AND word NOT LIKE '% %' ORDER BY bnc DESC, word LIMIT ?")
      .all(`%${tag}%`, limit * 4);

const insertCard = appDb.prepare(
  "INSERT INTO cards (word, deck) VALUES (?, ?) ON CONFLICT(word) DO NOTHING",
);
const insertLink = appDb.prepare(
  "INSERT OR IGNORE INTO deck_words (word, deck) VALUES (?, ?)",
);
let added = 0;
let linked = 0;
for (const { word } of rows) {
  const r = insertCard.run(word, deck);
  if (r.changes > 0) added++;
  const lr = insertLink.run(word, deck);
  if (lr.changes > 0) linked++;
  if (linked >= limit) break;
}

const total = appDb.prepare("SELECT COUNT(*) c FROM cards").get().c;
const decks = appDb
  .prepare(
    "SELECT dw.deck AS name, COUNT(*) n FROM deck_words dw GROUP BY dw.deck ORDER BY n DESC",
  )
  .all();
console.log(`「${deck}」新增词条关联 ${linked} 个（其中新卡 ${added}），全库共 ${total} 张卡`);
for (const d of decks) console.log(`  ${d.name}: ${d.n}`);
