// 数据同步核心：备份收集 + 合并（导入合并与云同步共用）
// 合并规则：按卡取最新（last_review 新者胜），复习记录按（词,时间,评分）去重补插
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getApp } from "./db";

export interface BackupCard {
  word: string;
  deck: string;
  state: number;
  stability: number;
  difficulty: number;
  due: string | null;
  last_review: string | null;
  reps: number;
  lapses: number;
  step: number;
  suspended: number;
  added_at: string | null;
  source_kind?: string | null;
  source_context?: string | null;
  source_ref?: string | null;
}

export interface BackupReview {
  word: string;
  reviewed_at: string;
  rating: number;
  state: number | null;
  stability: number | null;
  difficulty: number | null;
  due: string | null;
  duration_ms: number | null;
}

export interface Backup {
  app: "immerso";
  version: number;
  exported_at: string;
  cards: BackupCard[];
  reviews: BackupReview[];
}

/** 收集本机全部数据为备份结构 */
export async function collectBackup(): Promise<Backup> {
  const db = await getApp();
  const cards = await db.select<BackupCard[]>(
    `SELECT c.word, c.deck, c.state, c.stability, c.difficulty, c.due, c.last_review,
            c.reps, c.lapses, c.step, c.suspended, c.added_at,
            s.kind AS source_kind, s.context AS source_context, s.ref AS source_ref
     FROM cards c LEFT JOIN sources s ON s.id = c.source_id`,
  );
  const reviews = await db.select<BackupReview[]>(
    `SELECT c.word, r.reviewed_at, r.rating, r.state, r.stability, r.difficulty, r.due, r.duration_ms
     FROM reviews r JOIN cards c ON c.id = r.card_id`,
  );
  return {
    app: "immerso",
    version: 1,
    exported_at: new Date().toISOString(),
    cards,
    reviews,
  };
}

/** 把远端备份合并进本库，返回人类可读的合并报告 */
export async function mergeIntoLocal(data: Backup): Promise<string> {
  if (data.app !== "immerso" || !Array.isArray(data.cards)) throw new Error("不是浸词的备份文件");

  const db = await getApp();
  // 复习记录指纹（词,时间,评分）
  const reviewKeys = new Set(
    (
      await db.select<{ w: string; t: string; r: number }[]>(
        "SELECT c.word AS w, r.reviewed_at AS t, r.rating AS r FROM reviews r JOIN cards c ON c.id = r.card_id",
      )
    ).map((x) => `${x.w.toLowerCase()}|${x.t}|${x.r}`),
  );
  // 远端记录按词分组，避免 O(n²)
  const reviewsByWord = new Map<string, BackupReview[]>();
  for (const r of data.reviews ?? []) {
    const k = r.word.toLowerCase();
    if (!reviewsByWord.has(k)) reviewsByWord.set(k, []);
    reviewsByWord.get(k)!.push(r);
  }
  // 已有原句指纹
  const sourceKeys = new Map<string, number>(
    (
      await db.select<{ id: number; kind: string; context: string | null; ref: string | null }[]>(
        "SELECT id, kind, context, ref FROM sources",
      )
    ).map((s) => [`${s.kind}|${s.context ?? ""}|${s.ref ?? ""}`, s.id]),
  );
  const ensureSource = async (c: BackupCard): Promise<number | null> => {
    if (!c.source_kind) return null;
    const key = `${c.source_kind}|${c.source_context ?? ""}|${c.source_ref ?? ""}`;
    if (sourceKeys.has(key)) return sourceKeys.get(key)!;
    const res = await db.execute("INSERT INTO sources (kind, context, ref) VALUES (?,?,?)", [
      c.source_kind,
      c.source_context ?? null,
      c.source_ref ?? null,
    ]);
    const id = res.lastInsertId ?? null;
    if (id !== null) sourceKeys.set(key, id);
    return id;
  };

  let addedCards = 0;
  let updatedCards = 0;
  let keptCards = 0;
  let addedReviews = 0;

  for (const c of data.cards) {
    const key = c.word.toLowerCase();
    const existing = await db.select<
      { id: number; last_review: string | null }[]
    >("SELECT id, last_review FROM cards WHERE word = ? COLLATE NOCASE", [c.word]);

    if (existing.length === 0) {
      const sourceId = await ensureSource(c);
      await db.execute(
        `INSERT INTO cards (word, deck, state, stability, difficulty, due, last_review, reps, lapses, step, suspended)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(word) DO NOTHING`,
        [c.word, c.deck || "生词本", c.state, c.stability, c.difficulty, c.due, c.last_review, c.reps, c.lapses, c.step, c.suspended],
      );
      if (sourceId !== null) {
        await db.execute("UPDATE cards SET source_id = ? WHERE word = ? COLLATE NOCASE", [sourceId, c.word]);
      }
      addedCards++;
    } else {
      // 双端都学过：last_review 新者胜；一致则不动
      const local = existing[0];
      const inTime = c.last_review ?? "";
      const loTime = local.last_review ?? "";
      if (inTime > loTime) {
        await db.execute(
          `UPDATE cards SET deck = ?, state = ?, stability = ?, difficulty = ?, due = ?,
             last_review = ?, reps = ?, lapses = ?, step = ?, suspended = ? WHERE id = ?`,
          [c.deck || "生词本", c.state, c.stability, c.difficulty, c.due, c.last_review, c.reps, c.lapses, c.step, c.suspended, local.id],
        );
        updatedCards++;
      } else {
        keptCards++;
      }
    }

    // 补插本机缺失的复习记录
    for (const r of reviewsByWord.get(key) ?? []) {
      const rk = `${key}|${r.reviewed_at}|${r.rating}`;
      if (reviewKeys.has(rk)) continue;
      reviewKeys.add(rk);
      const cardId = (
        await db.select<{ id: number }[]>("SELECT id FROM cards WHERE word = ? COLLATE NOCASE", [c.word])
      )[0]?.id;
      if (cardId === undefined) continue;
      await db.execute(
        `INSERT INTO reviews (card_id, reviewed_at, rating, state, stability, difficulty, due, duration_ms)
         VALUES (?,?,?,?,?,?,?,?)`,
        [cardId, r.reviewed_at, r.rating, r.state, r.stability, r.difficulty, r.due, r.duration_ms],
      );
      addedReviews++;
    }
  }

  const parts = [`新增 ${addedCards} 卡`, `更新 ${updatedCards} 卡`, `补记 ${addedReviews} 条`];
  if (keptCards > 0) parts.push(`本机较新保留 ${keptCards} 卡`);
  return parts.join(" · ");
}

// ---------- 文件导入/导出（手动兜底） ----------

export async function exportData(): Promise<string> {
  const backup = await collectBackup();
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const path = await save({
    defaultPath: `immerso-backup-${stamp}.json`,
    filters: [{ name: "浸词备份", extensions: ["json"] }],
  });
  if (!path) return "已取消导出";
  await writeTextFile(path, JSON.stringify(backup));
  return `✓ 已导出 ${backup.cards.length} 张卡 · ${backup.reviews.length} 条复习记录`;
}

export async function importData(): Promise<string> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "浸词备份", extensions: ["json"] }],
  });
  if (!path) return "已取消导入";
  const raw = await readTextFile(path as string);
  let data: Backup;
  try {
    data = JSON.parse(raw);
  } catch {
    return "✗ 文件不是有效的 JSON";
  }
  try {
    return `✓ 合并完成：${await mergeIntoLocal(data)}`;
  } catch (e) {
    return `✗ ${String(e)}`;
  }
}
