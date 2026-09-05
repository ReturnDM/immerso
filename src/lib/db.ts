import Database from "@tauri-apps/plugin-sql";
import type { Card, Grade, RecordLogItem } from "ts-fsrs";
import { toCard } from "./fsrs";

let dictP: Promise<Database> | null = null;
let appP: Promise<Database> | null = null;
export const getDict = () => (dictP ??= Database.load("sqlite:dict.db"));
export const getApp = () => (appP ??= Database.load("sqlite:immerso.db"));

export interface DictEntry {
  word: string;
  phonetic: string;
  translation: string;
  definition: string;
  pos: string;
}

interface CardRow {
  id: number;
  word: string;
  source_id: number | null;
  stability: number;
  difficulty: number;
  due: string | null;
  last_review: string | null;
  state: number;
  reps: number;
  lapses: number;
  source_context: string | null;
}

export interface QueueItem {
  id: number;
  word: string;
  isNew: boolean;
  card: Card;
  sourceContext: string | null;
  dict: DictEntry | null;
}

/** 本地日期的零点，用 ISO（UTC）字符串与库里的 ISO 时间比较 */
function localDayStartISO(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ---------- 词典 ----------

export async function lookup(q: string): Promise<DictEntry[]> {
  const db = await getDict();
  const cols = "word, phonetic, translation, definition, pos";
  const exact = await db.select<DictEntry[]>(
    `SELECT ${cols} FROM dict WHERE word = ? COLLATE NOCASE LIMIT 1`,
    [q],
  );
  if (exact.length > 0) return exact;
  return db.select<DictEntry[]>(
    `SELECT ${cols} FROM dict WHERE word LIKE ? LIMIT 20`,
    [q + "%"],
  );
}

async function dictEntries(words: string[]): Promise<Map<string, DictEntry>> {
  const map = new Map<string, DictEntry>();
  if (words.length === 0) return map;
  const db = await getDict();
  for (let i = 0; i < words.length; i += 200) {
    const chunk = words.slice(i, i + 200);
    const rows = await db.select<DictEntry[]>(
      `SELECT word, phonetic, translation, definition, pos FROM dict
       WHERE word COLLATE NOCASE IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const r of rows) map.set(r.word.toLowerCase(), r);
  }
  return map;
}

// ---------- 设置 ----------

export async function getSetting(key: string): Promise<string | null> {
  const db = await getApp();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getApp();
  await db.execute(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value],
  );
}

export const DEFAULT_DAILY_NEW = 10;

export async function getDailyNew(): Promise<number> {
  const v = Number(await getSetting("daily_new"));
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_DAILY_NEW;
}

// ---------- 卡片 ----------

export async function addCard(word: string, context?: string): Promise<"added" | "exists"> {
  const db = await getApp();
  const dup = await db.select<{ id: number }[]>(
    "SELECT id FROM cards WHERE word = ? COLLATE NOCASE",
    [word],
  );
  if (dup.length > 0) return "exists";
  let sourceId: number | null = null;
  if (context && context.trim()) {
    const src = await db.execute(
      "INSERT INTO sources (kind, context, ref) VALUES ('manual', ?, '手动查词')",
      [context.trim()],
    );
    sourceId = src.lastInsertId ?? null;
  }
  await db.execute(
    "INSERT INTO cards (word, source_id) VALUES (?, ?) ON CONFLICT(word) DO NOTHING",
    [word, sourceId],
  );
  return "added";
}

export interface TodayStats {
  reviewCount: number;
  newCount: number;
  total: number;
  doneToday: number;
  library: number;
}

async function count(db: Database, sql: string, params: unknown[] = []): Promise<number> {
  const rows = await db.select<{ n: number }[]>(sql, params);
  return rows[0]?.n ?? 0;
}

async function newQuotaLeft(db: Database): Promise<number> {
  // reps = 1 且首次复习在今天 ⇒ 今天新引入的卡
  const introduced = await count(
    db,
    "SELECT COUNT(*) n FROM cards WHERE reps = 1 AND last_review >= ?",
    [localDayStartISO()],
  );
  return Math.max(0, (await getDailyNew()) - introduced);
}

export async function getTodayStats(): Promise<TodayStats> {
  const db = await getApp();
  const now = new Date().toISOString();
  const reviewCount = await count(
    db,
    "SELECT COUNT(*) n FROM cards WHERE suspended = 0 AND state != 0 AND due <= ?",
    [now],
  );
  const availableNew = await count(
    db,
    "SELECT COUNT(*) n FROM cards WHERE suspended = 0 AND state = 0",
  );
  const newCount = Math.min(await newQuotaLeft(db), availableNew);
  const doneToday = await count(
    db,
    "SELECT COUNT(*) n FROM reviews WHERE reviewed_at >= ?",
    [localDayStartISO()],
  );
  const library = await count(db, "SELECT COUNT(*) n FROM cards");
  return { reviewCount, newCount, total: reviewCount + newCount, doneToday, library };
}

export async function getQueue(): Promise<QueueItem[]> {
  const db = await getApp();
  const now = new Date().toISOString();
  const cols = `c.id, c.word, c.source_id, c.stability, c.difficulty, c.due, c.last_review,
                c.state, c.reps, c.lapses, s.context AS source_context`;
  const due = await db.select<CardRow[]>(
    `SELECT ${cols} FROM cards c LEFT JOIN sources s ON s.id = c.source_id
     WHERE c.suspended = 0 AND c.state != 0 AND c.due <= ?
     ORDER BY c.due LIMIT 500`,
    [now],
  );
  const quota = await newQuotaLeft(db);
  const fresh =
    quota > 0
      ? await db.select<CardRow[]>(
          `SELECT ${cols} FROM cards c LEFT JOIN sources s ON s.id = c.source_id
           WHERE c.suspended = 0 AND c.state = 0
           ORDER BY c.id LIMIT ?`,
          [quota],
        )
      : [];
  const rows = [...due, ...fresh];
  const dict = await dictEntries(rows.map((r) => r.word));
  return rows.map((r) => ({
    id: r.id,
    word: r.word,
    isNew: r.state === 0,
    card: toCard(r),
    sourceContext: r.source_context,
    dict: dict.get(r.word.toLowerCase()) ?? null,
  }));
}

export async function applyReview(
  item: QueueItem,
  grade: Grade,
  scheduling: RecordLogItem,
  durationMs: number,
): Promise<void> {
  const db = await getApp();
  const c = scheduling.card;
  const dueISO = c.due.toISOString();
  await db.execute(
    `UPDATE cards SET stability = ?, difficulty = ?, due = ?, last_review = ?,
       state = ?, reps = ?, lapses = ? WHERE id = ?`,
    [c.stability, c.difficulty, dueISO, new Date().toISOString(), c.state, c.reps, c.lapses, item.id],
  );
  await db.execute(
    `INSERT INTO reviews (card_id, rating, state, stability, difficulty, due, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [item.id, grade, item.card.state, c.stability, c.difficulty, dueISO, Math.round(durationMs)],
  );
}
