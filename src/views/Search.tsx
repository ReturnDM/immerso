import { useCallback, useEffect, useRef, useState } from "react";
import {
  addCard,
  getCurrentDeck,
  getDecks,
  lookup,
  type DictEntry,
} from "../lib/db";
import { speak } from "../lib/fsrs";

// ECDICT 的 translation 用字面 "\n" 分隔多条释义
function Translation({ text }: { text: string }) {
  return (
    <>
      {text.split("\\n").map((line, i) => (
        <p key={i} className="m-0 leading-relaxed">
          {line}
        </p>
      ))}
    </>
  );
}

type AddState = "idle" | "adding" | "added" | "exists";

export default function Search({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<DictEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, AddState>>({});
  const [contexts, setContexts] = useState<Record<string, string>>({});
  const [deck, setDeck] = useState("生词本");
  const [decks, setDecks] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    (async () => {
      const cur = await getCurrentDeck();
      const names = (await getDecks()).map((d) => d.name);
      const options = names.length > 0 ? names : ["生词本"];
      setDecks(options);
      setDeck(options.includes(cur) ? cur : "生词本");
    })();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setEntries(null);
      setError(null);
      return;
    }
    const t = setTimeout(() => {
      lookup(q)
        .then((rows) => {
          setEntries(rows);
          setError(rows.length === 0 ? `词典里没有「${q}」` : null);
        })
        .catch((e) => setError(String(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    },
    [onBack],
  );

  const add = async (word: string) => {
    setAdded((m) => ({ ...m, [word]: "adding" }));
    const r = await addCard(word, contexts[word], deck);
    setAdded((m) => ({ ...m, [word]: r === "added" ? "added" : "exists" }));
  };

  const addLabel = (word: string): string =>
    ({ idle: "＋ 加入学习", adding: "…", added: "✓ 已收入", exists: "已在词库" })[
      added[word] ?? "idle"
    ];

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-12 pb-10">
      <div className="w-full max-w-xl flex items-center gap-4">
        <button onClick={onBack} className="link-strong text-sm shrink-0">← 首页</button>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入单词查词典…"
          spellCheck={false}
          className="flex-1 field rounded-2xl px-5 py-3 text-lg outline-none
                     placeholder:text-[var(--t4)] focus:border-[var(--accent)] transition-colors t1"
        />
      </div>

      {error && <p className="mt-8 text-[var(--t3)]">{error}</p>}

      <div className="mt-8 w-full max-w-xl flex flex-col gap-3">
        {entries?.map((e) => {
          const isOpen = open === e.word;
          return (
            <div key={e.word} className="surface rounded-2xl px-5 py-4">
              <div
                className="flex items-baseline gap-3 cursor-pointer"
                onClick={() => setOpen(isOpen ? null : e.word)}
              >
                <span className="text-lg t1">{e.word}</span>
                {e.phonetic && (
                  <span className="text-sm accent-text opacity-80">/{e.phonetic}/</span>
                )}
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    speak(e.word);
                  }}
                  className="ml-auto t3 hover:text-[var(--accent)] transition-colors text-sm"
                  title="发音"
                >
                  🔊
                </button>
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if ((added[e.word] ?? "idle") === "idle") add(e.word);
                  }}
                  className={`text-xs border rounded-full px-3 py-1 transition-colors ${
                    added[e.word] === "added" || added[e.word] === "exists"
                      ? "border-teal-900 text-teal-500"
                      : "border-[var(--border)] t3 hover:border-[var(--accent)] accent-text"
                  }`}
                >
                  {addLabel(e.word)}
                </button>
              </div>
              {isOpen ? (
                <div className="mt-3 text-sm t2 space-y-2">
                  <Translation text={e.translation} />
                  {e.definition && (
                    <p className="text-[var(--t3)] italic leading-relaxed">{e.definition}</p>
                  )}
                  {(added[e.word] ?? "idle") === "idle" && (
                    <div className="pt-1 flex items-center gap-2">
                      <select
                        value={deck}
                        onChange={(ev) => {
                          ev.stopPropagation();
                          setDeck(ev.target.value);
                        }}
                        className="field rounded-xl px-2 py-1.5 text-xs t2 outline-none focus:border-[var(--accent)] cursor-pointer shrink-0"
                        title="收入哪个词库"
                      >
                        {decks.map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                      <input
                        value={contexts[e.word] ?? ""}
                        onChange={(ev) =>
                          setContexts((m) => ({ ...m, [e.word]: ev.target.value }))
                        }
                        onKeyDown={(ev) => ev.stopPropagation()}
                        placeholder="收词时的原句（可选）"
                        spellCheck={false}
                        className="flex-1 field rounded-xl px-3 py-1.5
                                   text-xs outline-none placeholder:text-[var(--t4)] focus:border-[var(--accent)] transition-colors t1"
                      />
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if ((added[e.word] ?? "idle") === "idle") add(e.word);
                        }}
                        className="text-xs border border-teal-900 rounded-full px-3 py-1 accent-text
                                   hover:bg-teal-950/50 transition-colors shrink-0"
                      >
                        收入「{deck}」
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-1.5 text-sm t2 line-clamp-1">
                  {e.translation.split("\\n")[0]}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
