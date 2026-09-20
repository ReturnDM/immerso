import { readTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { getApp, getSetting, setSetting } from "./db";

const NEATH_BASE = "https://neath.clingword.com/api/v1";
// 4045 = 词灵单词收藏（设计上的主数据源），4040 = 匿词默认本
const NEATH_BOOKS = [4045, 4040];

interface NeathItem {
  id: number;
  word: string;
  sentence: string | null;
  notebook_id: number;
}

async function fetchBook(key: string, book: number): Promise<NeathItem[]> {
  const out: NeathItem[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await fetch(`${NEATH_BASE}/notebooks/${book}/words?page=${page}&limit=100`, {
      headers: { "X-Neath-API-Key": key },
    });
    if (!res.ok) throw new Error(`匿词 API 返回 ${res.status}`);
    const j = (await res.json()) as { items: NeathItem[]; pages?: number };
    out.push(...(j.items ?? []));
    pages = j.pages ?? 1;
    page++;
  } while (page <= pages);
  return out;
}

/** 只读拉取匿词收藏 → 新词池。增量：已在词库的词自动跳过 */
export async function neathSync(): Promise<{ added: number; existing: number }> {
  const key = (
    await readTextFile(".neath-api-key", { baseDir: BaseDirectory.Home })
  ).trim();
  if (!key) throw new Error("Key 文件为空");

  const db = await getApp();
  const seen = new Set<number>();
  let added = 0;
  let existing = 0;

  for (const book of NEATH_BOOKS) {
    for (const it of await fetchBook(key, book)) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const dup = await db.select<{ id: number }[]>(
        "SELECT id FROM cards WHERE word = ? COLLATE NOCASE",
        [it.word],
      );
      if (dup.length > 0) {
        existing++;
        continue;
      }
      const src = await db.execute(
        "INSERT INTO sources (kind, context, ref) VALUES ('neath', ?, ?)",
        [it.sentence, `匿词·词书 ${it.notebook_id}`],
      );
      // 上面 NOCASE 查重通过后、此行执行前，并发收词/另一轮同步可能已插入同词——
      // 裸 INSERT 会撞 cards.word 的唯一约束抛 SQLITE_CONSTRAINT，整次匿词同步中途崩掉。
      // 用 ON CONFLICT DO NOTHING 幂等兜底：若受影响行数为 0，说明词已被并发插入，
      // 刚建的 sources 记录成了无人引用的孤儿，一并清掉后按已有词计数。
      const r = await db.execute(
        "INSERT INTO cards (word, source_id) VALUES (?, ?) ON CONFLICT(word) DO NOTHING",
        [it.word, src.lastInsertId],
      );
      if ((r.rowsAffected ?? 0) === 0) {
        await db.execute("DELETE FROM sources WHERE id = ?", [src.lastInsertId]);
        existing++;
        continue;
      }
      await db.execute("INSERT OR IGNORE INTO deck_words (word, deck) VALUES (?, ?)", [
        it.word,
        "生词本",
      ]);
      added++;
    }
  }

  await setSetting("neath_last_sync", new Date().toISOString());
  return { added, existing };
}

export async function lastSyncText(): Promise<string | null> {
  const iso = await getSetting("neath_last_sync");
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
