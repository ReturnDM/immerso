import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import {
  addCard,
  addWordToDeck,
  getAllDeckNames,
  getSetting,
  getWordDecks,
  lookup,
  lookupBase,
  setSetting,
  type DictEntry,
} from "./db";

/** 剪贴板/选区原文 → 可入库的词：去引号括号、取首行、限长 */
export function cleanWord(raw: string): string {
  let w = raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  w = w.replace(/^["'“”‘’「」『』《》\[\(\{]+/, "").replace(/["'“”‘’「」『』《》\]\)\}\.,;:!?\.\!\?]+$/, "").trim();
  if (w.length > 48) w = w.slice(0, 48).trim();
  return w;
}

export interface Resolved {
  /** 清洗后的输入 */
  word: string;
  /** 实际入库词：变形词解析到词基 */
  cardWord: string;
  entry: DictEntry | null;
  /** 经词形还原时记录原输入（puddles → puddle） */
  viaLemma: string | null;
  inDecks: string[];
}

/** ECDICT exchange 字段里的词基指针：'0:go/1:p' → 'go' */
function exchangeBase(entry: DictEntry): string | null {
  const m = entry.exchange?.match(/(?:^|\/)0:([^/]+)/);
  return m ? m[1].trim().toLowerCase() : null;
}

/** 查词 + 词形还原：变形条目（went→go）与词典外的变形词（puddles→puddle）都归到词基 */
export async function resolveWord(raw: string): Promise<Resolved> {
  const word = cleanWord(raw);
  if (!word) return { word: "", cardWord: "", entry: null, viaLemma: null, inDecks: [] };
  let cardWord = word;
  let viaLemma: string | null = null;
  let entry: DictEntry | null = null;

  const useBase = async (base: string): Promise<boolean> => {
    if (!base || base === word.toLowerCase()) return false;
    const brows = await lookup(base);
    const bentry = brows[0]?.word.toLowerCase() === base ? brows[0] : null;
    if (!bentry || !bentry.translation.trim()) return false;
    cardWord = bentry.word;
    entry = bentry;
    viaLemma = word;
    return true;
  };

  const rows = await lookup(word);
  const exact = rows[0]?.word.toLowerCase() === word.toLowerCase() ? rows[0] : null;
  if (exact) {
    entry = exact;
    // 精确命中但本身是变形条目（如 went = "go的过去式"）→ 归到词基
    const base = exchangeBase(exact) ?? (await lookupBase(word));
    await useBase(base ?? "");
  }
  if (!entry) {
    // 词典外变形词（如 puddles）→ lemma 表还原
    const base = await lookupBase(word);
    await useBase(base ?? "");
  }

  const map = await getWordDecks([cardWord]);
  return {
    word,
    cardWord,
    entry,
    viaLemma,
    inDecks: map.get(cardWord.toLowerCase()) ?? [],
  };
}

/** 划词直加入书：返回给系统通知的文案 */
export async function directCapture(raw: string): Promise<string> {
  const r = await resolveWord(raw);
  if (!r.word) return "剪贴板里没有可收的词，先选中单词";
  const names = await getAllDeckNames();
  const deck = (await getSetting("quick_deck")) ?? names[0] ?? "生词本";
  if (r.inDecks.includes(deck)) return `「${r.cardWord}」已在「${deck}」`;
  if (r.inDecks.length === 0) await addCard(r.cardWord, undefined, deck);
  else await addWordToDeck(r.cardWord, deck);
  void setSetting("quick_deck", deck);
  const via = r.viaLemma ? `（${r.viaLemma} → ${r.cardWord}）` : "";
  return `✓ ${r.cardWord}${via} 已收进「${deck}」`;
}

/** 系统通知（失败静默，不打断收词） */
export async function notify(body: string) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) sendNotification({ title: "浸词 · 快速收词", body });
  } catch {
    /* 通知不可用时静默 */
  }
}
