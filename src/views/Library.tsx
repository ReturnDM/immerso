import { useCallback, useEffect, useRef, useState } from "react";
import { MorphIcon } from "morphicons/react";
import { Plus, Check } from "lucide";
import {
  addWordToDeck,
  deleteCard,
  getAllDeckNames,
  getDecks,
  getLibrary,
  getTodayStats,
  getWordDecks,
  LIB_PAGE_SIZE,
  setCardSuspended,
  type LibCard,
  type LibFilter,
} from "../lib/db";
import { stateLabel } from "../lib/fsrs";

export default function Library({ onBack }: { onBack: () => void }) {
  const [decks, setDecks] = useState<{ name: string; total: number; learned: number }[]>([]);
  const [deck, setDeck] = useState("全部");
  const [filter, setFilter] = useState<LibFilter>("all");
  const [q, setQ] = useState("");
  const [decksByWord, setDecksByWord] = useState<Map<string, string[]>>(new Map());
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [addId, setAddId] = useState<number | null>(null);
  const [newBook, setNewBook] = useState("");
  const [allNames, setAllNames] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [cards, setCards] = useState<LibCard[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  /** 追加一页；page 0 = 重置列表（筛选条件变化时走这里） */
  const load = useCallback(
    async (d: string, f: LibFilter, query: string, pg: number) => {
      setLoading(true);
      try {
        const rows = await getLibrary(d, f, query, pg);
        setCards((cs) => (pg === 0 ? rows : [...cs, ...rows]));
        setHasMore(rows.length === LIB_PAGE_SIZE);
        setPage(pg);
        void getWordDecks(rows.map((r) => r.word)).then((m) =>
          pg === 0
            ? setDecksByWord(m)
            : setDecksByWord((prev) => {
                const next = new Map(prev);
                for (const [k, v] of m) next.set(k, v);
                return next;
              }),
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // 筛选条件变化（防抖）：重置到第一页
  useEffect(() => {
    const t = setTimeout(() => void load(deck, filter, q, 0), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [deck, filter, q, load]);

  // 滚动到底自动加载下一页
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          void load(deck, filter, q, page + 1);
        }
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [deck, filter, q, page, hasMore, loading, load]);

  const reload = useCallback(() => {
    void load(deck, filter, q, 0);
  }, [deck, filter, q, load]);

  const reloadDecks = useCallback(() => {
    void getDecks().then(setDecks);
    void getAllDeckNames().then(setAllNames);
    void getTodayStats("全部").then((s) => setTotalCount(s.library));
  }, []);

  useEffect(() => {
    reloadDecks();
  }, [reloadDecks, cards]);

  const options = [
    { name: "全部", total: totalCount },
    ...decks,
  ];

  const joinDeck = async (word: string, target: string) => {
    if (!target.trim()) return;
    await addWordToDeck(word, target.trim());
    setNewBook("");
    reload();
    reloadDecks();
  };

  const rowAction = (c: LibCard) => {
    if (confirmId === c.id) {
      return (
        <button
          onClick={() => {
            void deleteCard(c.id).then(() => {
              setConfirmId(null);
              reload();
            });
          }}
          className="text-xs text-rose-400 hairline pt-0.5 flex-none hover:opacity-80 transition-opacity"
        >
          确认删除
        </button>
      );
    }
    return (
      <button
        onClick={() => void setCardSuspended(c.id, !c.suspended).then(reload)}
        className="text-xs t4 hairline pt-0.5 hover:text-[var(--t2)] transition-colors flex-none"
      >
        {c.suspended ? "恢复" : "搁置"}
      </button>
    );
  };

  const tabCls = (active: boolean) =>
    `pb-1.5 -mb-px border-b-2 transition-colors ${
      active
        ? "border-[var(--accent)] accent-text"
        : "border-transparent t3 hover:text-[var(--text)] hover:border-[var(--t4)]"
    }`;

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-12 pb-10">
      <div className="w-full max-w-2xl flex items-center">
        <button onClick={onBack} className="link-strong text-sm">
          ← 首页
        </button>
        <span className="word-serif mx-auto text-[15px] tracking-[0.3em] t2 select-none">词库</span>
        <span className="w-10" />
      </div>

      {/* 词书页签 */}
      <div className="mt-8 w-full max-w-2xl flex flex-wrap gap-x-6 text-[13px]">
        {options.map((d) => (
          <button
            key={d.name}
            onClick={() => setDeck(d.name)}
            className={tabCls(deck === d.name)}
          >
            {d.name}
            <span className="num text-[11px] opacity-60 ml-1.5">{d.total}</span>
          </button>
        ))}
      </div>

      {/* 过滤 + 搜索 */}
      <div className="mt-5 w-full max-w-2xl flex items-center gap-5">
        <div className="flex gap-4 text-xs">
          {(
            [
              { v: "all" as LibFilter, label: "全部" },
              { v: "new" as LibFilter, label: "新词" },
              { v: "learned" as LibFilter, label: "已学" },
            ]
          ).map((o) => (
            <button
              key={o.v}
              onClick={() => setFilter(o.v)}
              className={tabCls(filter === o.v)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="relative inline-flex items-center flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜单词…"
            spellCheck={false}
            className="field w-full px-1 py-1 text-sm t1"
          />
        </span>
      </div>

      {/* 列表：发丝线分行 */}
      <div className="mt-4 w-full max-w-2xl">
        {cards.length === 0 && <p className="mt-10 text-center t4">没有符合条件的卡片</p>}
        {cards.map((c) => {
          const wordDecks = decksByWord.get(c.word.toLowerCase()) ?? [];
          const others = allNames.filter((n) => !wordDecks.includes(n));
          const expanded = addId === c.id;
          const hasIt = others.length === 0;
          return (
            <div key={c.id} className="py-2.5 border-t border-[var(--border)]">
              <div className="flex items-center gap-4">
                <span className={`word-serif text-[15px] t1 shrink-0 ${c.suspended ? "opacity-40" : ""}`}>
                  {c.word}
                </span>
                <span className={`text-[11px] truncate min-w-0 ${c.suspended ? "t4" : "t3"}`}>
                  {wordDecks.length > 0 ? wordDecks.join(" · ") : "—"}
                </span>
                <span className="ml-auto text-[11px] t4 shrink-0 hidden sm:inline">
                  {c.suspended ? "已搁置" : c.reps > 0 ? `学过 ${c.reps} 次` : stateLabel(c.state)}
                </span>
                <button
                  onClick={() => {
                    setAddId(expanded ? null : c.id);
                    setNewBook("");
                  }}
                  title="加入其他词书"
                  className="t4 hover:text-[var(--text)] transition-colors flex-none inline-flex"
                >
                  <MorphIcon
                    icon={expanded ? Check : Plus}
                    size={14}
                    strokeWidth={1.8}
                    spring="snappy"
                    reducedMotion="user"
                    aria-hidden
                  />
                </button>
                {rowAction(c)}
              </div>
              {expanded && (
                <div className="mt-3 pt-3 border-t border-[var(--border)] flex flex-wrap items-center gap-4 text-xs">
                  {hasIt ? (
                    <span className="t4">已在全部词书中</span>
                  ) : (
                    <>
                      <span className="t4">加入：</span>
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value) void joinDeck(c.word, e.target.value);
                          setAddId(null);
                        }}
                        className="field px-1 py-1 t2 cursor-pointer"
                      >
                        <option value="" disabled>
                          选择词书…
                        </option>
                        {others.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                  <span className="t4">或自建：</span>
                  <input
                    value={newBook}
                    onChange={(e) => setNewBook(e.target.value)}
                    placeholder="新词书名"
                    spellCheck={false}
                    className="field px-1 py-1 w-28 t1"
                  />
                  <button
                    onClick={() => {
                      void joinDeck(c.word, newBook).then(() => setAddId(null));
                    }}
                    disabled={!newBook.trim()}
                    className="accent-text hairline pt-0.5 disabled:opacity-30 hover:opacity-80 transition-opacity"
                  >
                    创建
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {/* 无限滚动哨兵 */}
        <div ref={sentinelRef} className="h-px" />
        {loading && cards.length > 0 && (
          <p className="py-3 text-center text-xs t4">加载中…</p>
        )}
        {!hasMore && cards.length > 0 && (
          <p className="py-4 text-center text-[11px] t4">
            共 {deck === "全部" ? totalCount : cards.length} 词
          </p>
        )}
      </div>
    </div>
  );
}
