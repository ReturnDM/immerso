import { useCallback, useEffect, useRef, useState } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  addCard,
  addWordToDeck,
  getAllDeckNames,
  getSetting,
  getWordDecks,
  lookup,
  setSetting,
  type DictEntry,
} from "./lib/db";
import { speak } from "./lib/fsrs";

const quickWin = getCurrentWebviewWindow();

/** 剪贴板原文 → 可入库的词：去引号括号、取首行、限长 */
function cleanWord(raw: string): string {
  let w = raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  w = w.replace(/^["'“”‘’「」『』《》\[\(\{]+/, "").replace(/["'“”‘’「」『』《》\]\)\}\.,;:!?\.\!\?]+$/, "").trim();
  if (w.length > 48) w = w.slice(0, 48).trim();
  return w;
}

export default function QuickCapture() {
  const [word, setWord] = useState("");
  const [entry, setEntry] = useState<DictEntry | null>(null);
  const [decks, setDecks] = useState<string[]>([]);
  const [deck, setDeck] = useState("生词本");
  const [inDecks, setInDecks] = useState<string[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastPrep = useRef(0);

  /** 每次呼出：读剪贴板带词、查释义、选默认词书 */
  const prepare = useCallback(async () => {
    // quick-show 事件与焦点事件会接连触发，去重
    if (Date.now() - lastPrep.current < 200) return;
    lastPrep.current = Date.now();
    setStatus(null);
    let w = "";
    try {
      const c = await readText();
      if (c) w = cleanWord(c);
    } catch {
      /* 剪贴板可能是图片等非文本 */
    }
    setWord(w);
    setEntry(null);
    setInDecks([]);
    if (w) {
      const rows = await lookup(w);
      const exact = rows[0]?.word.toLowerCase() === w.toLowerCase() ? rows[0] : null;
      setEntry(exact);
      const map = await getWordDecks([w]);
      setInDecks(map.get(w.toLowerCase()) ?? []);
    }
    const names = await getAllDeckNames();
    const list = names.length > 0 ? names : ["生词本"];
    setDecks(list);
    const last = await getSetting("quick_deck");
    setDeck(last && list.includes(last) ? last : list[0]);
    inputRef.current?.focus();
    if (w && (await getSetting("auto_pronounce")) !== "off") speak(w);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("quick-transparent");
    document.body.classList.add("quick-transparent");
  }, []);

  // 挂载即准备一次（惰性创建的首次打开），此后每次呼出靠 quick-show / 焦点事件刷新；失去焦点自动收起
  useEffect(() => {
    void prepare();
    const unShow = quickWin.listen("quick-show", () => void prepare());
    const unFocus = quickWin.onFocusChanged(({ payload: focused }) => {
      if (focused) void prepare();
      else void quickWin.hide();
    });
    return () => {
      void unShow.then((f) => f());
      void unFocus.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async () => {
    const w = word.trim();
    if (!w || busy) return;
    setBusy(true);
    try {
      if (inDecks.includes(deck)) {
        setStatus({ ok: false, text: `已在「${deck}」` });
        return;
      }
      if (inDecks.length === 0) await addCard(w, undefined, deck);
      else await addWordToDeck(w, deck);
      void setSetting("quick_deck", deck);
      setStatus({ ok: true, text: `✓ 已收进「${deck}」` });
      setTimeout(() => void quickWin.hide(), 900);
    } catch (e) {
      setStatus({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-3 rounded-2xl surface shadow-[0_18px_50px_rgba(0,0,0,0.5)] flex flex-col px-5 py-4 overflow-hidden animate-fade-in">
      <div className="flex items-baseline">
        <span className="text-xs tracking-[0.3em] t3 select-none" data-tauri-drag-region>
          快速收词
        </span>
        <span className="ml-auto text-[11px] t4">Enter 收词 · Esc 收起</span>
      </div>
      <div className="waterline mt-2">
        <i style={{ width: word.trim() ? "100%" : "0%" }} />
      </div>

      <input
        ref={inputRef}
        value={word}
        onChange={(e) => setWord(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
          else if (e.key === "Escape") void quickWin.hide();
        }}
        placeholder="输入或粘贴单词…"
        spellCheck={false}
        className="word-serif mt-3 w-full bg-transparent outline-none text-2xl t1 placeholder:text-[var(--t4)] placeholder:text-lg placeholder:font-sans"
      />

      <div className="mt-1 min-h-[34px]">
        {entry ? (
          <p className="text-xs t2 leading-5 line-clamp-2">
            {entry.phonetic && <span className="accent-text mr-2">{entry.phonetic}</span>}
            {entry.translation.split(/\n/)[0]}
          </p>
        ) : word.trim() ? (
          <p className="text-xs t4">未收录，仍可收进词书</p>
        ) : (
          <p className="text-xs t4">在别的应用里复制单词，再按热键</p>
        )}
        {inDecks.length > 0 && (
          <p className="text-[11px] t4 mt-0.5">已在：{inDecks.join(" · ")}</p>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {decks.map((d) => (
          <button
            key={d}
            onClick={() => setDeck(d)}
            className={`rounded-full px-2.5 py-1 text-xs border transition-colors ${
              deck === d
                ? "bg-teal-700 text-white border-teal-700"
                : "t3 border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--text)]"
            }`}
          >
            {d}
          </button>
        ))}
      </div>

      <p
        className={`mt-2 text-xs h-4 ${
          status ? (status.ok ? "accent-text" : "text-rose-400") : "t4"
        }`}
      >
        {status?.text ?? ""}
      </p>
    </div>
  );
}
