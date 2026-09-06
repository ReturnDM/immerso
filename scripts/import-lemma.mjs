// 一次性导入脚本：把 ECDICT 词形还原表（lemma.en.txt）反转成 变形→词基 灌进 dict.db 的 lemma 表
// 用法：node scripts/import-lemma.mjs
// 前提：dict.db 已存在（先跑 import-ecdict.mjs）；词表 https://github.com/skywind3000/ECDICT（lemma.en.txt）
// 格式：每行「词基/词频 -> 变形1,变形2,…」，反转后首见（词频最高）者优先
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lemmaPath = process.env.LEMMA_TXT ?? join(root, ".cache", "lemma.en.txt");
const dataDir =
  process.env.IMMERSO_DATA_DIR ??
  join(
    process.env.APPDATA ??
      (process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : join(homedir(), ".local", "share")),
    "com.returndm.immerso",
  );
const dbPath = join(dataDir, "dict.db");

if (!existsSync(lemmaPath)) {
  console.error(`找不到 ${lemmaPath}，请先下载 lemma.en.txt 到 .cache/`);
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`找不到 ${dbPath}，请先跑 import-ecdict.mjs`);
  process.exit(1);
}

const lines = readFileSync(lemmaPath, "utf8").split(/\r?\n/);
const db = new DatabaseSync(dbPath);
db.exec(`
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
DROP TABLE IF EXISTS lemma;
CREATE TABLE lemma (
  en TEXT NOT NULL PRIMARY KEY,
  base TEXT NOT NULL
);
BEGIN;
`);
const insert = db.prepare("INSERT OR IGNORE INTO lemma (en, base) VALUES (?, ?)");

let pairs = 0;
for (const line of lines) {
  if (!line || line.startsWith(";")) continue;
  const m = line.match(/^([^/\s]+)\/\d+\s*->\s*(.+)$/);
  if (!m) continue;
  const base = m[1].trim().toLowerCase();
  for (const infl of m[2].split(",")) {
    const w = infl.trim().toLowerCase();
    if (!w || w === base) continue;
    insert.run(w, base);
    pairs++;
  }
}
db.exec("COMMIT;");
db.exec("ANALYZE;");
db.close();
console.log(`完成：${pairs} 条 变形→词基 → ${dbPath}（${(statSync(dbPath).size / 1024 / 1024).toFixed(1)} MB）`);
