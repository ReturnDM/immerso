// 准备要打进安装包的词典资源：src-tauri/resources/dict.db
// 用法：node scripts/prepare-dict-resource.mjs
// 数据源：ECDICT master（ecdict.csv + lemma.en.txt，本地 .cache 有缓存则不重复下载）
// 产物与用户手跑 import-ecdict.mjs + import-lemma.mjs 完全一致
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(root, ".cache");
const csv = join(cache, "ecdict.csv");
const lemma = join(cache, "lemma.en.txt");
const resources = join(root, "src-tauri", "resources");

const ECDICT_CSV = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv";
const ECDICT_LEMMA = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/lemma.en.txt";

function download(url, to) {
  if (existsSync(to) && statSync(to).size > 1_000_000) {
    console.log(`缓存命中 ${to}`);
    return;
  }
  mkdirSync(cache, { recursive: true });
  console.log(`下载 ${url}`);
  const r = spawnSync("curl", ["-sL", "--max-time", "600", "-o", to, url], { stdio: "inherit" });
  if (r.status !== 0 || !existsSync(to) || statSync(to).size < 1_000_000) {
    console.error(`下载失败：${url}`);
    process.exit(1);
  }
}

download(ECDICT_CSV, csv);
download(ECDICT_LEMMA, lemma);

mkdirSync(resources, { recursive: true });
const env = { ...process.env, ECDICT_CSV: csv, LEMMA_TXT: lemma, IMMERSO_DATA_DIR: resources };

for (const script of ["scripts/import-ecdict.mjs", "scripts/import-lemma.mjs"]) {
  const r = spawnSync("node", [script], { env, stdio: "inherit", cwd: root });
  if (r.status !== 0) {
    console.error(`${script} 失败`);
    process.exit(1);
  }
}
console.log(`资源就绪：${join(resources, "dict.db")}（${(statSync(join(resources, "dict.db")).size / 1048576).toFixed(1)} MB）`);
