import { useCallback, useEffect, useRef, useState } from "react";
import { addCard, lookup, type DictEntry } from "../lib/db";
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
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

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") onBack();
  }, [onBack]);

  const add = async (word: string) => {
    setAdded((m) => ({ ...m, [word]: "adding" }));
    const r = await addCard(word, contexts[word]);
    setAdded((m) => ({ ...m, [word]: r === "added" ? "added" : "exists" }));
  };

  const addLabel = (word: string): string =>
    ({ idle: "＋ 加入学习", adding: "…", added: "✓ 已收入", exists: "已在词库" })[
      added[word] ?? "idle"
    ];

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-10 pb-10">
      <div className="w-full max-w-xl flex items-center gap-4">
        <button
          onClick={onBack}
          className="text-sm text-zinc-500 hover:text-zinc-200 transition-colors shrink-0"
        >
          ← 首页
        </button>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入单词查词典…"
          spellCheck={false}
          className="flex-1 rounded-2xl bg-zinc-900/80 border border-zinc-800 px-5 py-3 text-lg outline-none
                     placeholder:text-zinc-600 focus:border-teal-700 transition-colors"
        />
      </div>

      {error && <p className="mt-8 text-zinc-500">{error}</p>}

      <div className="mt-8 w-full max-w-xl flex flex-col gap-3">
        {entries?.map((e) => {
          const isOpen = open === e.word;
          return (
            <div
              key={e.word}
              className="rounded-2xl bg-zinc-900/60 border border-zinc-800/80 px-5 py-4"
            >
              <div
                className="flex items-baseline gap-3 cursor-pointer"
                onClick={() => setOpen(isOpen ? null : e.word)}
              >
                <span className="text-lg text-zinc-100">{e.word}</span>
                {e.phonetic && (
                  <span className="text-sm text-teal-400/80">/{e.phonetic}/</span>
                )}
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    speak(e.word);
                  }}
                  className="ml-auto text-zinc-500 hover:text-teal-400 transition-colors text-sm"
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
                      : "border-zinc-700 text-zinc-400 hover:border-teal-700 hover:text-teal-400"
                  }`}
                >
                  {addLabel(e.word)}
                </button>
              </div>
              {isOpen ? (
                <div className="mt-3 text-sm text-zinc-300 space-y-2">
                  <Translation text={e.translation} />
                  {e.definition && (
                    <p className="text-zinc-500 italic leading-relaxed">{e.definition}</p>
                  )}
                  {(added[e.word] ?? "idle") === "idle" && (
                    <div className="pt-1 flex items-center gap-2">
                      <input
                        value={contexts[e.word] ?? ""}
                        onChange={(ev) =>
                          setContexts((m) => ({ ...m, [e.word]: ev.target.value }))
                        }
                        onKeyDown={(ev) => ev.stopPropagation()}
                        placeholder="收词时的原句（可选）"
                        spellCheck={false}
                        className="flex-1 rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-1.5
                                   text-xs outline-none placeholder:text-zinc-600 focus:border-teal-700 transition-colors"
                      />
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          add(e.word);
                        }}
                        className="text-xs border rounded-full px-3 py-1 border-teal-900 text-teal-400
                                   hover:bg-teal-950/50 transition-colors shrink-0"
                      >
                        带原句收入
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-1.5 text-sm text-zinc-400 line-clamp-1">
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
