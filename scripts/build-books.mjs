// 词书目录生成：public/books/*.json
// 来源：
//   1. ECDICT tag 列——六本考试书（cet4/cet6/ky/toefl/ielts/gre，按 BNC 词频排序）
//   2. scripts/data/ 外部词表——AWL.json（学术词表，CC0）、CSWL.json（计算机科学词表，CC0）
// 质量门槛：小写去重；丢纯缩写（全大写且 ≤5 字母）、含数字、单字符；
//           词典覆盖率校验——ECDICT 查不到的词直接丢弃（干词卡），并打印报告
import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "public", "books");
mkdirSync(outDir, { recursive: true });

const platformDataDir =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : join(process.env.APPDATA ?? join(homedir(), ".data"));
const dataDir = process.env.IMMERSO_DATA_DIR ?? join(platformDataDir, "com.returndm.immerso");
const dict = new DatabaseSync(join(dataDir, "dict.db"), { readOnly: true });
const dictWords = new Set(
  dict.prepare("SELECT word FROM dict").all().map((r) => r.word.toLowerCase()),
);

/** 清洗：返回收录词数组；打印丢弃报告 */
function clean(name, raw, { allowSpaces = false } = {}) {
  const seen = new Set();
  const out = [];
  let dup = 0;
  let abbr = 0;
  let dry = 0;
  for (const orig of raw) {
    const w = String(orig).trim().toLowerCase();
    if (!w) continue;
    if (seen.has(w)) {
      dup++;
      continue;
    }
    if (w.length < 2 || /\d/.test(w) || (!allowSpaces && w.includes(" "))) {
      abbr++;
      continue;
    }
    if (/^[A-Z]+$/.test(String(orig).trim()) && String(orig).trim().length <= 5) {
      abbr++;
      continue;
    }
    if (!dictWords.has(w)) {
      dry++;
      continue;
    }
    seen.add(w);
    out.push(w);
  }
  console.log(
    `[${name}] 收 ${out.length} · 去重 ${dup} · 缩写/格式 ${abbr} · 词典未收录 ${dry}`,
  );
  return out;
}

const books = [];

// —— 六本考试书：ECDICT tag，按 BNC 词频排序（与 seed-cards.mjs 同口径） ——
const EXAM = [
  { id: "cet4", name: "四级", desc: "大学英语四级考试词汇" },
  { id: "cet6", name: "六级", desc: "大学英语六级考试词汇" },
  { id: "ky", name: "考研", desc: "考研英语核心词汇" },
  { id: "toefl", name: "托福", desc: "TOEFL 核心词汇" },
  { id: "ielts", name: "雅思", desc: "IELTS 核心词汇" },
  { id: "gre", name: "GRE", desc: "GRE 核心词汇" },
];
for (const b of EXAM) {
  const rows = dict
    .prepare(
      "SELECT word FROM dict WHERE tag LIKE ? AND word NOT LIKE '% %' ORDER BY bnc DESC, word",
    )
    .all(`%${b.id}%`);
  const words = clean(b.name, rows.map((r) => r.word));
  books.push({ ...b, words });
}

// —— AWL：570 词族全部词形，按子表顺序 ——
const awl = JSON.parse(readFileSync(join(here, "data", "AWL.json"), "utf8"));
const awlWords = [];
for (const key of Object.keys(awl).sort()) {
  for (const [head, v] of Object.entries(awl[key])) {
    awlWords.push(head, ...(v.subwords ?? []));
  }
}
books.push({
  id: "awl",
  name: "学术词汇",
  desc: "Academic Word List · 570 词族，论文与文献高频词",
  words: clean("学术词汇", awlWords, { allowSpaces: true }),
});

// —— CSWL：计算机科学词表 ——
const cs = JSON.parse(readFileSync(join(here, "data", "CSWL.json"), "utf8"));
books.push({
  id: "cs",
  name: "计算机",
  desc: "Computer Science Word List · 读文档与论文的学术词",
  words: clean("计算机", [...cs.headwords, ...cs["multi-words"]], { allowSpaces: true }),
});

// —— 写出 ——
const catalog = [];
for (const b of books) {
  if (b.words.length < 50) {
    console.warn(`!! 「${b.name}」只有 ${b.words.length} 词，低于 50 门槛，不进目录`);
    continue;
  }
  const file = `${b.id}.json`;
  writeFileSync(join(outDir, file), JSON.stringify(b.words));
  catalog.push({ id: b.id, name: b.name, desc: b.desc, file, count: b.words.length });
}
writeFileSync(join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2));
console.log(`\n目录 ${catalog.length} 本：`);
for (const c of catalog) console.log(`  ${c.name}（${c.id}）: ${c.count} 词`);
