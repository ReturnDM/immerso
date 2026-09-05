import { useCallback, useEffect, useRef, useState } from "react";
import Database from "@tauri-apps/plugin-sql";

interface Entry {
  word: string;
  phonetic: string;
  translation: string;
  definition: string;
  pos: string;
}

let dbPromise: ReturnType<typeof Database.load> | null = null;
const getDb = () => (dbPromise ??= Database.load("sqlite:dict.db"));

async function lookup(q: string): Promise<Entry[]> {
  const db = await getDb();
  const exact = await db.select<Entry[]>(
    `SELECT word, phonetic, translation, definition, pos
     FROM dict WHERE word = ? COLLATE NOCASE LIMIT 1`,
    [q],
  );
  if (exact.length > 0) return exact;
  return db.select<Entry[]>(
    `SELECT word, phonetic, translation, definition, pos
     FROM dict WHERE word LIKE ? LIMIT 20`,
    [q + "%"],
  );
}

function speak(text: string) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

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

export default function App() {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    if (e.key === "Escape") setQuery("");
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-16 pb-10">
      <h1 className="text-2xl font-light tracking-[0.3em] text-zinc-400 select-none">
        浸 词
      </h1>

      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="输入单词查词典…"
        spellCheck={false}
        className="mt-10 w-full max-w-xl rounded-2xl bg-zinc-900/80 border border-zinc-800 px-6 py-4 text-xl outline-none
                   placeholder:text-zinc-600 focus:border-teal-700 transition-colors"
      />

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
              </div>
              {isOpen ? (
                <div className="mt-3 text-sm text-zinc-300 space-y-2">
                  <Translation text={e.translation} />
                  {e.definition && (
                    <p className="text-zinc-500 italic leading-relaxed">{e.definition}</p>
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

      <p className="mt-auto pt-10 text-xs text-zinc-600 select-none">
        词典数据 ECDICT · 夜 2 起接入复习闭环
      </p>
    </div>
  );
}
