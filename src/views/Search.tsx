import { useCallback, useEffect, useRef, useState } from "react";
import { MorphIcon } from "morphicons/react";
import { Plus, Check } from "lucide";
import {
  addCard,
  getCurrentDeck,
  getDecks,
  lookup,
  type DictEntry,
} from "../lib/db";
import { speak } from "../lib/fsrs";
import { Icon } from "../components/Icon";

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

  const done = (word: string) => ["added", "exists"].includes(added[word] ?? "idle");
  const addLabel = (word: string): string =>
    ({ idle: "加入", adding: "…", added: "已收入", exists: "已在库" })[added[word] ?? "idle"];

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-12 pb-10">
      <div className="w-full max-w-xl flex items-center gap-5">
        <button onClick={onBack} className="link-strong text-sm shrink-0">← 首页</button>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入单词查词典…"
          spellCheck={false}
          className="word-serif field flex-1 px-1 py-2 text-lg t1"
        />
      </div>

      {error && <p className="mt-8 text-sm t3">{error}</p>}

      <div className="mt-6 w-full max-w-xl">
        {entries?.map((e) => {
          const isOpen = open === e.word;
          return (
            <div key={e.word} className="py-4 border-t border-[var(--border)]">
              <div
                className="flex items-baseline gap-3 cursor-pointer -mx-3 px-3 py-1.5 rounded-md
                           hover:bg-[var(--hover)] transition-colors"
                onClick={() => setOpen(isOpen ? null : e.word)}
              >
                <span className="word-serif text-lg t1">{e.word}</span>
                {e.phonetic && e.phonetic.toLowerCase() !== e.word.toLowerCase() && (
                  <span className="num text-[13px] t3">/{e.phonetic}/</span>
                )}
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    speak(e.word);
                  }}
                  className="ml-auto t3 hover:text-[var(--text)] transition-colors"
                  title="发音"
                >
                  <Icon name="speaker" size={14} />
                </button>
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if ((added[e.word] ?? "idle") === "idle") add(e.word);
                  }}
                  className={`text-xs shrink-0 inline-flex items-center gap-1 transition-colors ${
                    done(e.word) ? "accent-text" : "t3 hover:text-[var(--text)]"
                  }`}
                >
                  <MorphIcon
                    icon={done(e.word) ? Check : Plus}
                    size={13}
                    strokeWidth={1.8}
                    spring="snappy"
                    reducedMotion="user"
                    aria-hidden
                  />
                  {addLabel(e.word)}
                </button>
              </div>
              {isOpen ? (
                <div className="mt-3 text-sm t2 space-y-2">
                  <Translation text={e.translation} />
                  {e.definition && (
                    <p className="t3 italic leading-relaxed">{e.definition}</p>
                  )}
                  {(added[e.word] ?? "idle") === "idle" && (
                    <div className="pt-2 flex items-end gap-4">
                      <select
                        value={deck}
                        onChange={(ev) => {
                          ev.stopPropagation();
                          setDeck(ev.target.value);
                        }}
                        className="field px-1 py-1 text-xs t2 cursor-pointer shrink-0"
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
                        className="field flex-1 px-1 py-1 text-xs t1"
                      />
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if ((added[e.word] ?? "idle") === "idle") add(e.word);
                        }}
                        className="text-xs accent-text hairline pt-0.5 shrink-0 hover:opacity-80 transition-opacity"
                      >
                        收入「{deck}」
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-1.5 text-sm t3 line-clamp-1">
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
