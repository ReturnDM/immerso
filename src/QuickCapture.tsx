import { useCallback, useEffect, useRef, useState } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  addCard,
  addWordToDeck,
  getAllDeckNames,
  getSetting,
  setCardContextIfEmpty,
  setSetting,
} from "./lib/db";
import { cleanWord, resolveWord, type Resolved } from "./lib/capture";
import { speak } from "./lib/fsrs";

const quickWin = getCurrentWebviewWindow();

export default function QuickCapture() {
  const [word, setWord] = useState("");
  const [context, setContext] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [decks, setDecks] = useState<string[]>([]);
  const [deck, setDeck] = useState("生词本");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastPrep = useRef(0);

  /** 每次呼出：读剪贴板。整句（≥3 词）进原句栏待补单词；单词直接进词条 */
  const prepare = useCallback(async () => {
    // quick-show 事件与焦点事件会接连触发，去重
    if (Date.now() - lastPrep.current < 200) return;
    lastPrep.current = Date.now();
    setStatus(null);
    let raw = "";
    try {
      raw = (await readText()) ?? "";
    } catch {
      /* 剪贴板可能是图片等非文本 */
    }
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 3) {
      setContext(raw.trim());
      setWord("");
      setResolved(null);
    } else {
      setContext("");
      setWord(cleanWord(raw));
      setResolved(null);
    }
    const names = await getAllDeckNames();
    const list = names.length > 0 ? names : ["生词本"];
    setDecks(list);
    const last = await getSetting("quick_deck");
    setDeck(last && list.includes(last) ? last : list[0]);
    inputRef.current?.focus();
    if (words.length < 3 && words.length > 0 && (await getSetting("auto_pronounce")) !== "off") {
      speak(cleanWord(raw));
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("quick-transparent");
    document.body.classList.add("quick-transparent");
  }, []);

  // 输入防抖 160ms 动态解析：精确释义 / 词形还原 / 已在词书
  useEffect(() => {
    const w = word.trim();
    if (!w) {
      setResolved(null);
      return;
    }
    const t = setTimeout(() => {
      void resolveWord(w).then(setResolved);
    }, 160);
    return () => clearTimeout(t);
  }, [word]);

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
    const r = resolved;
    if (!r?.word || busy) return;
    setBusy(true);
    try {
      if (r.inDecks.includes(deck)) {
        setStatus({ ok: false, text: `已在「${deck}」` });
        return;
      }
      if (r.inDecks.length === 0) await addCard(r.cardWord, context.trim() || undefined, deck);
      else {
        await addWordToDeck(r.cardWord, deck);
        if (context.trim()) await setCardContextIfEmpty(r.cardWord, context.trim());
      }
      void setSetting("quick_deck", deck);
      const via = r.viaLemma ? `（${r.viaLemma} → ${r.cardWord}）` : "";
      setStatus({ ok: true, text: `✓ ${r.cardWord}${via} 已收进「${deck}」` });
      setTimeout(() => void quickWin.hide(), 900);
    } catch (e) {
      setStatus({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const entry = resolved?.entry ?? null;
  const hasWord = word.trim().length > 0;

  return (
    <div className="absolute inset-0 rounded-2xl border border-[var(--border)] bg-[var(--bg)] flex flex-col px-5 py-4 overflow-hidden animate-fade-in">
      <div className="flex items-baseline">
        <span className="text-xs tracking-[0.3em] t3 select-none" data-tauri-drag-region>
          快速收词
        </span>
        <span className="ml-auto text-[11px] t4 num">Enter 收词 · Esc 收起</span>
      </div>
      <div className="waterline mt-2">
        <i style={{ width: hasWord ? "100%" : "0%" }} />
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
      <input
        value={context}
        onChange={(e) => setContext(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
          else if (e.key === "Escape") void quickWin.hide();
        }}
        placeholder="原句（可选，随词一起收）"
        spellCheck={false}
        className="mt-2 w-full field px-1 py-1 text-xs t2"
      />

      <div className="mt-1 min-h-[34px]">
        {entry ? (
          <p className="text-xs t2 leading-5 line-clamp-2">
            {entry.phonetic && entry.phonetic.toLowerCase() !== entry.word.toLowerCase() && (
              <span className="accent-text mr-2">{entry.phonetic}</span>
            )}
            {entry.translation.split(/\n/)[0]}
          </p>
        ) : hasWord ? (
          <p className="text-xs t4">未收录，仍可收进词书</p>
        ) : (
          <p className="text-xs t4">在别的应用里选中单词，或直接输入</p>
        )}
        {resolved?.viaLemma && (
          <p className="text-[11px] accent-text mt-0.5">词形 {resolved.viaLemma} → {resolved.cardWord}</p>
        )}
        {resolved && resolved.inDecks.length > 0 && (
          <p className="text-[11px] t4 mt-0.5">已在：{resolved.inDecks.join(" · ")}</p>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {decks.map((d) => (
          <button
            key={d}
            onClick={() => setDeck(d)}
            className={`rounded-full px-3 py-1 text-xs transition-colors ${
              deck === d
                ? "btn-ink"
                : "t3 border border-[var(--border)] hover:text-[var(--text)] hover:border-[var(--t3)]"
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
