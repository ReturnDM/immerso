// 一次性导入脚本：把 ECDICT CSV 灌进只读词典库 dict.db
// 用法：node scripts/import-ecdict.mjs
// 产物：%APPDATA%\com.returndm.immerso\dict.db（可用 IMMERSO_DATA_DIR 覆盖）
// 词库来源：https://github.com/skywind3000/ECDICT（ecdict.csv，CC BY-NC 4.0）
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = process.env.ECDICT_CSV ?? join(root, ".cache", "ecdict.csv");
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

if (!existsSync(csvPath)) {
  console.error(`找不到 ${csvPath}，请先下载 ecdict.csv 到 .cache/`);
  process.exit(1);
}

// --- 极简 CSV 解析（处理引号内的逗号/换行） ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      if (field.endsWith("\r")) field = field.slice(0, -1);
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

console.log("解析 CSV 中（约 66MB，稍等）…");
const rows = parseCsv(readFileSync(csvPath, "utf8"));
const header = rows[0];
const col = Object.fromEntries(header.map((h, i) => [h, i]));
console.log(`共 ${rows.length - 1} 条记录，开始写入 ${dbPath}`);

mkdirSync(dataDir, { recursive: true });
if (existsSync(dbPath)) unlinkSync(dbPath);

const db = new DatabaseSync(dbPath);
db.exec(`
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE dict (
  word TEXT NOT NULL,
  phonetic TEXT NOT NULL DEFAULT '',
  definition TEXT NOT NULL DEFAULT '',
  translation TEXT NOT NULL DEFAULT '',
  pos TEXT NOT NULL DEFAULT '',
  tag TEXT NOT NULL DEFAULT '',
  collins INTEGER NOT NULL DEFAULT 0,
  oxford INTEGER NOT NULL DEFAULT 0,
  bnc INTEGER NOT NULL DEFAULT 0,
  frq INTEGER NOT NULL DEFAULT 0,
  exchange TEXT NOT NULL DEFAULT ''
);
BEGIN;
`);
const insert = db.prepare(
  "INSERT INTO dict (word, phonetic, definition, translation, pos, tag, collins, oxford, bnc, frq, exchange) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
);

let count = 0;
for (let r = 1; r < rows.length; r++) {
  const f = rows[r];
  if (f.length < 2 || !f[col.word]) continue;
  insert.run(
    f[col.word],
    f[col.phonetic] ?? "",
    f[col.definition] ?? "",
    f[col.translation] ?? "",
    f[col.pos] ?? "",
    f[col.tag] ?? "",
    parseInt(f[col.collins]) || 0,
    parseInt(f[col.oxford]) || 0,
    parseInt(f[col.bnc]) || 0,
    parseInt(f[col.frq]) || 0,
    f[col.exchange] ?? ""
  );
  count++;
  if (count % 100000 === 0) console.log(`  已写入 ${count}`);
}
db.exec("COMMIT;");
db.exec("CREATE UNIQUE INDEX idx_dict_word_nocase ON dict(word COLLATE NOCASE);");
db.exec("ANALYZE;");
db.close();
console.log(`完成：${count} 词 → ${dbPath}（${(statSync(dbPath).size / 1024 / 1024).toFixed(1)} MB）`);
