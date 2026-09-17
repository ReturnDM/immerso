import Database from "@tauri-apps/plugin-sql";
import { emitTo } from "@tauri-apps/api/event";
import type { Card, Grade, RecordLogItem } from "ts-fsrs";
import { toCard } from "./fsrs";
import { editDistance } from "./spell";
import { DEFAULT_MODES, parseModes, serializeModes, type ExMode } from "./exercises";

export const DEFAULT_DAILY_NEW = 10;
export const DEFAULT_DECK = "生词本";

let dictP: Promise<Database> | null = null;
let appP: Promise<Database> | null = null;
// dict.db 由 Rust 启动时从安装包 resources 释放到数据目录（无内置资源的老安装/开发机用脚本生成的那份）
export const getDict = () => (dictP ??= Database.load("sqlite:dict.db"));
export const getApp = () => (appP ??= Database.load("sqlite:immerso.db"));

/** 词库内容变了（收词/加词书）：通知主窗口词库页刷新。小窗/主窗自身发出均可，失败静默 */
function libraryChanged(): void {
  void emitTo("main", "library-changed").catch(() => {});
}

export interface DictEntry {
  word: string;
  phonetic: string;
  translation: string;
  definition: string;
  pos: string;
  exchange: string;
  /** 查词命中方式：lookup() 填写，其他来源无此字段 */
  hit?: "exact" | "prefix" | "contains" | "zh" | "suggest";
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
  /** 间隔式练习的断点：带着它插回队列，轮到时从 seq[pos] 续练 */
  resume?: { seq: ExMode[]; pos: number; errors: number };
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

const normWord = (s: string) => s.trim().toLowerCase();
const HAS_CJK = /[\u3400-\u9fff]/;

/**
 * 查词：英文按前缀联想（精确置顶 + 常用度排序），中文对释义列做子串匹配，
 * 两路都按常用度（词频 → 牛津/柯林斯 → 词长）排序；前缀候选太少时补「包含」匹配兜底。
 */
export async function lookup(q: string): Promise<DictEntry[]> {
  const db = await getDict();
  const cols = "word, phonetic, translation, definition, pos, exchange";
  const norm = q.trim().toLowerCase();
  // 无词频的排最后；牛津/柯林斯词表次之（用大数与词频域隔开）
  const freqOrd =
    "CASE WHEN frq > 0 THEN frq WHEN oxford > 0 THEN 90000 WHEN collins > 0 THEN 95000 ELSE 999999 END";

  // 中文查英文：匹配释义子串；释义开头（核心词义）命中优先，再按常用度排
  // （LIKE 全表扫描 ~110ms，本地库可接受）
  if (HAS_CJK.test(norm)) {
    const rows = await db.select<DictEntry[]>(
      `SELECT ${cols} FROM dict
       WHERE translation LIKE '%' || ? || '%'
       ORDER BY CASE WHEN instr(translation, ?) BETWEEN 1 AND 30 THEN 0 ELSE 1 END,
                ${freqOrd}, instr(translation, ?), LENGTH(word), word
       LIMIT 30`,
      [q.trim(), q.trim(), q.trim()],
    );
    for (const r of rows) r.hit = "zh";
    return rows;
  }

  const rows = await db.select<DictEntry[]>(
    `SELECT ${cols} FROM dict
     WHERE word LIKE ? ${norm.length === 1 ? "AND frq > 0" : ""}
     ORDER BY CASE WHEN word = ? COLLATE NOCASE THEN 0 ELSE 1 END,
              ${freqOrd}, LENGTH(word), word
     LIMIT 30`,
    [q + "%", q],
  );
  for (const r of rows) r.hit = normWord(r.word) === norm ? "exact" : "prefix";
  // 兜底「包含」匹配限常用词：LIKE '%q%' 走不了索引，全表扫描仅在候选少时触发
  if (rows.length < 8 && norm.length >= 3) {
    const seen = new Set(rows.map((r) => normWord(r.word)));
    const extra = await db.select<DictEntry[]>(
      `SELECT ${cols} FROM dict
       WHERE word LIKE '%' || ? || '%' AND word NOT LIKE ?
         AND (frq > 0 OR oxford > 0 OR collins > 0)
       ORDER BY ${freqOrd}, LENGTH(word), word
       LIMIT 12`,
      [q, q + "%"],
    );
    for (const r of extra) {
      if (seen.has(normWord(r.word))) continue;
      r.hit = "contains";
      rows.push(r);
    }
  }
  // 兜底拼写纠错：彻底查不到时，从常用词里找编辑距离相近的（recieve→receive）
  if (rows.length === 0) {
    for (const r of await suggestEntries(norm)) {
      r.hit = "suggest";
      rows.push(r);
    }
  }
  return rows;
}

// ---------- 拼写建议 ----------

/** 常用词表（按词频取前 2 万，会话级缓存一次） */
let commonWordsCache: Promise<string[]> | null = null;

async function suggestEntries(q: string): Promise<DictEntry[]> {
  if (q.length < 3) return [];
  const db = await getDict();
  commonWordsCache ??= db
    .select<{ word: string }[]>("SELECT word FROM dict WHERE frq > 0 ORDER BY frq LIMIT 20000")
    .then((rows) => rows.map((r) => r.word));
  const list = await commonWordsCache;
  const maxD = q.length >= 6 ? 2 : 1;
  const hits: { w: string; d: number; i: number }[] = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (Math.abs(w.length - q.length) > maxD) continue;
    const d = editDistance(q, w.toLowerCase());
    if (d <= maxD) hits.push({ w, d, i });
  }
  hits.sort((a, b) => a.d - b.d || a.i - b.i); // 距离优先，同距按常用度（词频序）
  const top = hits.slice(0, 8).map((h) => h.w);
  if (top.length === 0) return [];
  const map = await dictEntries(top);
  return top.map((w) => map.get(w.toLowerCase())).filter((e): e is DictEntry => e !== undefined);
}

/** 词形还原：变形词 → 词基（lemma 表，未命中返回 null） */
export async function lookupBase(word: string): Promise<string | null> {
  const db = await getDict();
  const rows = await db.select<{ base: string }[]>(
    "SELECT base FROM lemma WHERE en = ? COLLATE NOCASE",
    [word],
  );
  return rows[0]?.base ?? null;
}

async function dictEntries(words: string[]): Promise<Map<string, DictEntry>> {  const map = new Map<string, DictEntry>();
  if (words.length === 0) return map;
  const db = await getDict();
  for (let i = 0; i < words.length; i += 200) {
    const chunk = words.slice(i, i + 200);
    const rows = await db.select<DictEntry[]>(
      `SELECT word, phonetic, translation, definition, pos, exchange FROM dict
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
  // 收词即复活：清掉可能的旧删除墓碑
  await db.execute("DELETE FROM tombstones WHERE word = ? COLLATE NOCASE", [word]);
  const dup = await db.select<{ id: number }[]>(
    "SELECT id FROM cards WHERE word = ? COLLATE NOCASE",
    [word],
  );
  if (dup.length > 0) {
    // 卡已存在（如词书导入过）：仍要确保收进指定词书，否则「已在库」却永远不进生词本
    const r = await db.execute(
      "INSERT OR IGNORE INTO deck_words (word, deck) VALUES (?, ?)",
      [word, deck],
    );
    const tagged = (r.rowsAffected ?? 0) > 0;
    if (tagged) libraryChanged();
    return tagged ? "added" : "exists";
  }
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
  libraryChanged();
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
  // 今天首次被复习的卡 = 今天新引入。不能数 reps（同一天复习第二次 reps 就变 2），
  // 用 reviews 里"没有早于今天的记录、且有今天的记录"判定；reviewed_at 是 SQLite
  // localtime 格式，阈值也用 SQLite 本地当日零点，避免跨格式字典序比较
  const { sql: dc, params: dp } = deckClause(deck);
  const introduced = await count(
    db,
    `SELECT COUNT(*) n FROM cards c
     WHERE c.suspended = 0${dc}
       AND EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = c.id
                   AND r.reviewed_at >= datetime('now', 'localtime', 'start of day'))
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = c.id
                       AND r.reviewed_at < datetime('now', 'localtime', 'start of day'))`,
    dp,
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
    // reviewed_at 是 SQLite datetime('now','localtime') 格式，阈值同格式才能正确比较
    // （JS 的 UTC ISO 与它做字典序比较只在东八区碰巧正确）
    // 同一张卡的 Again 重试会有多条记录，进度应按卡计一次；并且应跟随当前词书筛选。
    `SELECT COUNT(DISTINCT c.id) n FROM reviews r JOIN cards c ON c.id = r.card_id
     WHERE r.reviewed_at >= datetime('now', 'localtime', 'start of day')${dc}`,
    dp,
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

export const LIB_PAGE_SIZE = 200;

/** 分页取卡：page 从 0 起；最新收的排最前（新收的词一眼可见），翻页不重不漏 */
export async function getLibrary(
  deck: string,
  filter: LibFilter,
  q: string,
  page: number = 0,
): Promise<LibCard[]> {
  const db = await getApp();
  const conds: string[] = ["1=1"];
  const params: unknown[] = [];
  if (deck && deck !== "全部") {
    conds.push("EXISTS (SELECT 1 FROM deck_words dw WHERE dw.word = cards.word AND dw.deck = ?)");
    params.push(deck);
  }
  if (filter === "new") conds.push("state = 0");
  if (filter === "learned") conds.push("state != 0");
  if (q.trim()) {
    conds.push("word LIKE ?");
    params.push(q.trim() + "%");
  }
  params.push(LIB_PAGE_SIZE, page * LIB_PAGE_SIZE);
  return db.select<LibCard[]>(
    `SELECT id, word, state, reps, due, deck, suspended FROM cards
     WHERE ${conds.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`,
    params,
  );
}

/** 一批词各自拥有的全部词书标签 */
export async function getWordDecks(words: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (words.length === 0) return map;
  const db = await getApp();
  for (let i = 0; i < words.length; i += 200) {
    const chunk = words.slice(i, i + 200);
    const rows = await db.select<{ word: string; deck: string }[]>(
      `SELECT word, deck FROM deck_words
       WHERE word COLLATE NOCASE IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    );
    for (const r of rows) {
      const k = r.word.toLowerCase();
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r.deck);
    }
  }
  return map;
}

/** 所有词书名（含只出现在 deck_words 里的自建词书） */
export async function getAllDeckNames(): Promise<string[]> {
  const db = await getApp();
  const rows = await db.select<{ deck: string }[]>(
    "SELECT DISTINCT deck FROM deck_words ORDER BY deck",
  );
  return rows.map((r) => r.deck);
}

/** 把词加入另一本词书（新词书名即自建）；同样是复活，清掉旧墓碑 */
export async function addWordToDeck(word: string, deck: string): Promise<void> {
  const db = await getApp();
  await db.execute("DELETE FROM tombstones WHERE word = ? COLLATE NOCASE", [word]);
  await db.execute("INSERT OR IGNORE INTO deck_words (word, deck) VALUES (?, ?)", [
    word,
    deck.trim(),
  ]);
  libraryChanged();
}

export async function setCardSuspended(id: number, suspended: boolean): Promise<void> {
  const db = await getApp();
  await db.execute("UPDATE cards SET suspended = ? WHERE id = ?", [suspended ? 1 : 0, id]);
}

/** 彻底删除一个词（卡+复习+词书标签+孤儿原句），并留下墓碑——同步合并时据此删词/抑制旧卡回灌 */
export async function deleteCard(id: number): Promise<void> {
  const db = await getApp();
  const row = (
    await db.select<{ word: string }[]>("SELECT word FROM cards WHERE id = ?", [id])
  )[0];
  if (!row) return;
  await db.execute("DELETE FROM reviews WHERE card_id = ?", [id]);
  await db.execute("DELETE FROM deck_words WHERE word = ? COLLATE NOCASE", [row.word]);
  await db.execute("UPDATE cards SET source_id = NULL WHERE id = ? AND source_id IS NOT NULL", [id]);
  await db.execute("DELETE FROM sources WHERE id NOT IN (SELECT source_id FROM cards WHERE source_id IS NOT NULL)");
  await db.execute("DELETE FROM cards WHERE id = ?", [id]);
  // deleted_at 与 cards.added_at 同格式（SQLite 本地时间），两者才能直接字典序比较
  await db.execute(
    "INSERT INTO tombstones (word, deleted_at) VALUES (?, datetime('now','localtime')) ON CONFLICT(word) DO UPDATE SET deleted_at = excluded.deleted_at",
    [row.word],
  );
}

/** 墓碑表：词 → 删除时间（ISO，可按字典序比较） */
export async function getTombstones(): Promise<Map<string, string>> {
  const db = await getApp();
  const rows = await db.select<{ word: string; deleted_at: string }[]>(
    "SELECT word, deleted_at FROM tombstones",
  );
  return new Map(rows.map((r) => [r.word.toLowerCase(), r.deleted_at]));
}

/**
 * 整本移除词书：摘掉该书全部标签；独占词（不在其他词书）连卡带复习记录整删并记墓碑
 * （同步时另一台设备同样删除）。记入 deck_removals，同步合并据此不再把该书标签灌回来。
 */
export async function deleteDeck(deck: string): Promise<{ tags: number; deleted: number }> {
  const db = await getApp();
  const words = (
    await db.select<{ word: string }[]>("SELECT word FROM deck_words WHERE deck = ?", [deck])
  ).map((r) => r.word);
  if (words.length === 0) return { tags: 0, deleted: 0 };

  // 独占词 = 除本书外不在任何词书
  const others = await getWordDecks(words);
  const orphans = words.filter(
    (w) => (others.get(w.toLowerCase())?.filter((d) => d !== deck).length ?? 0) === 0,
  );

  // 摘掉本书全部标签 + 记录移除（先记，防止后续同步回灌）
  await db.execute("DELETE FROM deck_words WHERE deck = ?", [deck]);
  await db.execute(
    "INSERT INTO deck_removals (deck, removed_at) VALUES (?, datetime('now','localtime')) ON CONFLICT(deck) DO UPDATE SET removed_at = excluded.removed_at",
    [deck],
  );

  // 独占词整删：批量 SQL（逐词走 deleteCard 会是几千次 IPC 往返）
  const CHUNK = 300;
  for (let i = 0; i < orphans.length; i += CHUNK) {
    const chunk = orphans.slice(i, i + CHUNK);
    const ph = chunk.map(() => "?").join(",");
    await db.execute(
      `INSERT INTO tombstones (word, deleted_at)
       SELECT word, datetime('now','localtime') FROM cards WHERE word COLLATE NOCASE IN (${ph})
       ON CONFLICT(word) DO UPDATE SET deleted_at = excluded.deleted_at`,
      chunk,
    );
    await db.execute(
      `DELETE FROM reviews WHERE card_id IN (SELECT id FROM cards WHERE word COLLATE NOCASE IN (${ph}))`,
      chunk,
    );
    await db.execute(
      `UPDATE cards SET source_id = NULL WHERE source_id IS NOT NULL AND word COLLATE NOCASE IN (${ph})`,
      chunk,
    );
    await db.execute(`DELETE FROM cards WHERE word COLLATE NOCASE IN (${ph})`, chunk);
  }
  if (orphans.length > 0) {
    await db.execute(
      "DELETE FROM sources WHERE id NOT IN (SELECT source_id FROM cards WHERE source_id IS NOT NULL)",
    );
  }

  // 当前词书若指向被移除的书，回「全部」
  if ((await getSetting("current_deck")) === deck) await setCurrentDeck("全部");
  libraryChanged();
  return { tags: words.length, deleted: orphans.length };
}

/** 给已有卡片补原句（仅在它还没有原句时写入；无 source 则建一条） */
export async function setCardContextIfEmpty(word: string, context: string): Promise<boolean> {
  const db = await getApp();
  const card = (
    await db.select<{ id: number; source_id: number | null }[]>(
      "SELECT id, source_id FROM cards WHERE word = ? COLLATE NOCASE",
      [word],
    )
  )[0];
  if (!card) return false;
  if (card.source_id != null) {
    const r = await db.execute(
      "UPDATE sources SET context = ? WHERE id = ? AND (context IS NULL OR context = '')",
      [context, card.source_id],
    );
    return (r.rowsAffected ?? 0) > 0;
  }
  const src = await db.execute(
    "INSERT INTO sources (kind, context, ref) VALUES ('manual', ?, '快速收词')",
    [context],
  );
  await db.execute("UPDATE cards SET source_id = ? WHERE id = ?", [src.lastInsertId ?? null, card.id]);
  return true;
}
