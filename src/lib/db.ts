import Database from "@tauri-apps/plugin-sql";
import type { Card, Grade, RecordLogItem } from "ts-fsrs";
import { toCard } from "./fsrs";
import { DEFAULT_MODES, parseModes, serializeModes, type ExMode } from "./exercises";

export const DEFAULT_DAILY_NEW = 10;
export const DEFAULT_DECK = "生词本";

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
  deck: string;
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
  deck: string;
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

export async function getDailyNew(): Promise<number> {
  const v = Number(await getSetting("daily_new"));
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_DAILY_NEW;
}

/** 启用的练习模式（勾选制）；兼容旧的 exercise_mode 单选值 */
export async function getEnabledModes(): Promise<ExMode[]> {
  const newV = await getSetting("exercise_modes");
  if (newV !== null) return parseModes(newV);
  const old = await getSetting("exercise_mode");
  if (old === "dictation") return ["dictation"];
  if (old === "mix") return ["self", "dictation"];
  if (old === "self") return ["self"];
  return [...DEFAULT_MODES];
}

export const setEnabledModes = (modes: ExMode[]) =>
  setSetting("exercise_modes", serializeModes(modes));

// ---------- 词库（deck） ----------

export interface DeckInfo {
  name: string;
  total: number;
  learned: number;
}

export async function getDecks(): Promise<DeckInfo[]> {
  const db = await getApp();
  return db.select<DeckInfo[]>(
    `SELECT dw.deck AS name, COUNT(*) AS total,
            SUM(CASE WHEN c.state != 0 THEN 1 ELSE 0 END) AS learned
     FROM deck_words dw JOIN cards c ON c.word = dw.word
     GROUP BY dw.deck ORDER BY total DESC`,
  );
}

export async function getCurrentDeck(): Promise<string> {
  return (await getSetting("current_deck")) ?? "全部";
}

export const setCurrentDeck = (d: string) => setSetting("current_deck", d);

function deckClause(deck: string): { sql: string; params: string[] } {
  return deck && deck !== "全部"
    ? { sql: " AND EXISTS (SELECT 1 FROM deck_words dw WHERE dw.word = c.word AND dw.deck = ?)", params: [deck] }
    : { sql: "", params: [] };
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

// ---------- 卡片 ----------

export async function addCard(
  word: string,
  context?: string,
  deck: string = DEFAULT_DECK,
): Promise<"added" | "exists"> {
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
    "INSERT INTO cards (word, source_id, deck) VALUES (?, ?, ?) ON CONFLICT(word) DO NOTHING",
    [word, sourceId, deck],
  );
  await db.execute(
    "INSERT OR IGNORE INTO deck_words (word, deck) VALUES (?, ?)",
    [word, deck],
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

async function newQuotaLeft(db: Database, deck: string): Promise<number> {
  // reps = 1 且首次复习在今天 ⇒ 今天新引入的卡
  const { sql: dc, params: dp } = deckClause(deck);
  const introduced = await count(
    db,
    `SELECT COUNT(*) n FROM cards c WHERE c.reps = 1 AND c.last_review >= ?${dc}`,
    [localDayStartISO(), ...dp],
  );
  return Math.max(0, (await getDailyNew()) - introduced);
}

export async function getTodayStats(deck: string): Promise<TodayStats> {
  const db = await getApp();
  const now = new Date().toISOString();
  const { sql: dc, params: dp } = deckClause(deck);
  const reviewCount = await count(
    db,
    `SELECT COUNT(*) n FROM cards c WHERE c.suspended = 0 AND c.state != 0 AND c.due <= ?${dc}`,
    [now, ...dp],
  );
  const availableNew = await count(
    db,
    `SELECT COUNT(*) n FROM cards c WHERE c.suspended = 0 AND c.state = 0${dc}`,
    dp,
  );
  const newCount = Math.min(await newQuotaLeft(db, deck), availableNew);
  const doneToday = await count(
    db,
    "SELECT COUNT(*) n FROM reviews WHERE reviewed_at >= ?",
    [localDayStartISO()],
  );
  const library = await count(
    db,
    `SELECT COUNT(*) n FROM cards c WHERE 1=1${dc}`,
    dp,
  );
  return { reviewCount, newCount, total: reviewCount + newCount, doneToday, library };
}

export async function getQueue(deck: string): Promise<QueueItem[]> {
  const db = await getApp();
  const now = new Date().toISOString();
  const { sql: dc, params: dp } = deckClause(deck);
  const cols = `c.id, c.word, c.source_id, c.deck, c.stability, c.difficulty, c.due,
                c.last_review, c.state, c.reps, c.lapses, s.context AS source_context`;
  const due = await db.select<CardRow[]>(
    `SELECT ${cols} FROM cards c LEFT JOIN sources s ON s.id = c.source_id
     WHERE c.suspended = 0 AND c.state != 0 AND c.due <= ?${dc}
     ORDER BY c.due LIMIT 500`,
    [now, ...dp],
  );
  const quota = await newQuotaLeft(db, deck);
  const fresh =
    quota > 0
      ? await db.select<CardRow[]>(
          `SELECT ${cols} FROM cards c LEFT JOIN sources s ON s.id = c.source_id
           WHERE c.suspended = 0 AND c.state = 0${dc}
           ORDER BY c.id LIMIT ?`,
          [...dp, quota],
        )
      : [];
  const rows = [...due, ...fresh];
  const dict = await dictEntries(rows.map((r) => r.word));
  return rows.map((r) => ({
    id: r.id,
    word: r.word,
    isNew: r.state === 0,
    deck: r.deck,
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

// ---------- 词库浏览 ----------

export interface LibCard {
  id: number;
  word: string;
  state: number;
  reps: number;
  due: string | null;
  deck: string;
  suspended: number;
}

export type LibFilter = "all" | "new" | "learned";

export async function getLibrary(
  deck: string,
  filter: LibFilter,
  q: string,
): Promise<LibCard[]> {
  const db = await getApp();
  const conds: string[] = ["1=1"];
  const params: unknown[] = [];
  if (deck && deck !== "全部") {
    conds.push("deck = ?");
    params.push(deck);
  }
  if (filter === "new") conds.push("state = 0");
  if (filter === "learned") conds.push("state != 0");
  if (q.trim()) {
    conds.push("word LIKE ?");
    params.push(q.trim() + "%");
  }
  params.push(200);
  return db.select<LibCard[]>(
    `SELECT id, word, state, reps, due, deck, suspended FROM cards
     WHERE ${conds.join(" AND ")} ORDER BY id LIMIT ?`,
    params,
  );
}

export async function setCardSuspended(id: number, suspended: boolean): Promise<void> {
  const db = await getApp();
  await db.execute("UPDATE cards SET suspended = ? WHERE id = ?", [suspended ? 1 : 0, id]);
}

export async function deleteCard(id: number): Promise<void> {
  const db = await getApp();
  await db.execute("DELETE FROM reviews WHERE card_id = ?", [id]);
  await db.execute("UPDATE cards SET source_id = NULL WHERE id = ? AND source_id IS NOT NULL", [id]);
  await db.execute("DELETE FROM sources WHERE id NOT IN (SELECT source_id FROM cards WHERE source_id IS NOT NULL)");
  await db.execute("DELETE FROM cards WHERE id = ?", [id]);
}
