// 词书目录：public/books/ 下的内置内容包，按需一键导入
// 目录 catalog.json + 每本一个词表文件；导入 = 建新卡 + 挂词书标签，已入库的词只补标签
import { getApp } from "./db";

export interface CatalogBook {
  id: string;
  name: string;
  desc: string;
  file: string;
  count: number;
}

const BASE = `${import.meta.env.BASE_URL}books/`;

export async function fetchCatalog(): Promise<CatalogBook[]> {
  const res = await fetch(`${BASE}catalog.json`);
  if (!res.ok) throw new Error(`词书目录加载失败 ${res.status}`);
  return res.json();
}

/** 导入一本词书。报告文本给 UI 展示 */
export async function importBook(b: CatalogBook): Promise<string> {
  const res = await fetch(`${BASE}${b.file}`);
  if (!res.ok) throw new Error(`词书内容加载失败 ${res.status}`);
  const words: string[] = await res.json();
  const db = await getApp();
  const existing = new Set(
    (await db.select<{ w: string }[]>("SELECT word AS w FROM cards")).map((r) => r.w.toLowerCase()),
  );
  const fresh = words.filter((w) => !existing.has(w.toLowerCase()));

  // 收词即复活：导入的新卡清掉旧删除墓碑，与 addCard 同语义（否则下次同步可能被旧墓碑反杀）
  for (let i = 0; i < fresh.length; i += 300) {
    const chunk = fresh.slice(i, i + 300);
    const ph = chunk.map(() => "?").join(",");
    await db.execute(`DELETE FROM tombstones WHERE word COLLATE NOCASE IN (${ph})`, chunk);
  }
  // 重新导入同名词书 = 复活：清掉整本移除记录，同步才能把标签恢复回来
  await db.execute("DELETE FROM deck_removals WHERE deck = ?", [b.name]);

  // 新词建卡（卡的主词书即本书）
  for (let i = 0; i < fresh.length; i += 300) {
    const chunk = fresh.slice(i, i + 300);
    const ph = chunk.map(() => "(?,?)").join(",");
    await db.execute(
      `INSERT INTO cards (word, deck) VALUES ${ph} ON CONFLICT(word) DO NOTHING`,
      chunk.flatMap((w) => [w, b.name]),
    );
  }
  // 全部词挂词书标签（已在库的词只补标签）
  for (let i = 0; i < words.length; i += 400) {
    const chunk = words.slice(i, i + 400);
    const ph = chunk.map(() => "(?,?)").join(",");
    await db.execute(
      `INSERT OR IGNORE INTO deck_words (word, deck) VALUES ${ph}`,
      chunk.flatMap((w) => [w, b.name]),
    );
  }
  return fresh.length === 0
    ? `「${b.name}」的词都已在库，已归入词书`
    : `「${b.name}」新增 ${fresh.length} 词`;
}
