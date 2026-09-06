import { useCallback, useEffect, useState } from "react";
import {
  addWordToDeck,
  deleteCard,
  getAllDeckNames,
  getDecks,
  getLibrary,
  getTodayStats,
  getWordDecks,
  setCardSuspended,
  type LibCard,
  type LibFilter,
} from "../lib/db";
import { stateLabel } from "../lib/fsrs";
import { Icon } from "../components/Icon";

function stateBadge(c: LibCard): { text: string; cls: string } {
  if (c.suspended) return { text: "已搁置", cls: "border-[var(--border)] t4" };
  if (c.state === 0) return { text: "新词", cls: "border-teal-900 text-teal-500" };
  if (c.state === 2) return { text: "复习中", cls: "border-sky-900 text-sky-500" };
  return { text: "巩固中", cls: "border-amber-900 text-amber-500" };
}

export default function Library({ onBack }: { onBack: () => void }) {
  const [decks, setDecks] = useState<{ name: string; total: number; learned: number }[]>([]);
  const [deck, setDeck] = useState("全部");
  const [filter, setFilter] = useState<LibFilter>("all");
  const [q, setQ] = useState("");
  const [cards, setCards] = useState<LibCard[]>([]);
  const [decksByWord, setDecksByWord] = useState<Map<string, string[]>>(new Map());
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [addId, setAddId] = useState<number | null>(null);
  const [newBook, setNewBook] = useState("");
  const [allNames, setAllNames] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);

  const reload = useCallback(() => {
    void getLibrary(deck, filter, q).then((cs) => {
      setCards(cs);
      void getWordDecks(cs.map((c) => c.word)).then(setDecksByWord);
    });
  }, [deck, filter, q]);

  const reloadDecks = useCallback(() => {
    void getDecks().then(setDecks);
    void getAllDeckNames().then(setAllNames);
    void getTodayStats("全部").then((s) => setTotalCount(s.library));
  }, []);

  useEffect(() => {
    reloadDecks();
  }, [reloadDecks, cards]);

  useEffect(() => {
    const t = setTimeout(reload, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [reload]);

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
          className="text-xs border border-red-900 text-red-400 rounded-md px-2.5 py-1 hover:bg-red-950/60 transition-colors flex-none"
        >
          确认删除
        </button>
      );
    }
    return (
      <button
        onClick={() => void setCardSuspended(c.id, !c.suspended).then(reload)}
        className="text-xs border border-[var(--border)] t3 rounded-md px-2.5 py-1 hover:border-[var(--accent)] accent-text transition-colors flex-none"
      >
        {c.suspended ? "恢复" : "搁置"}
      </button>
    );
  };

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-12 pb-10">
      <div className="w-full max-w-xl flex items-center">
        <button onClick={onBack} className="link-strong text-sm">
          ← 首页
        </button>
        <span className="mx-auto text-sm tracking-[0.3em] t2 select-none">词库</span>
        <span className="w-10" />
      </div>

      <p className="mt-3 w-full max-w-xl text-[11px] t4">
        一个词可以同时属于多本词书，学习进度全词库共享
      </p>

      {/* 词库 chips */}
      <div className="mt-2 w-full max-w-xl flex flex-wrap gap-2">
        {options.map((d) => (
          <button
            key={d.name}
            onClick={() => setDeck(d.name)}
            className={`text-xs rounded-full px-3 py-1.5 border transition-colors ${
              deck === d.name
                ? "border-[var(--accent)] accent-text bg-[var(--accent-dim)]"
                : "border-[var(--border)] t3 hover:border-[var(--accent)]"
            }`}
          >
            {d.name} <span className="opacity-60 tabular-nums">{d.total}</span>
          </button>
        ))}
      </div>

      {/* 过滤 + 搜索 */}
      <div className="mt-4 w-full max-w-xl flex items-center gap-3">
        <div className="flex rounded-lg border border-[var(--border)] p-0.5">
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
              className={`px-3 py-1 rounded-md text-xs transition-colors ${
                filter === o.v ? "bg-teal-700 text-white" : "t3 hover:text-[var(--text)]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="relative inline-flex items-center flex-1">
          <Icon name="search" size={14} className="absolute left-3 t4 pointer-events-none" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜单词…"
            spellCheck={false}
            className="w-full field rounded-full pl-9 pr-4 py-1.5 text-sm outline-none placeholder:text-[var(--t4)] focus:border-[var(--accent)] transition-colors t1"
          />
        </span>
      </div>

      {/* 列表 */}
      <div className="mt-4 w-full max-w-xl flex flex-col gap-2 pb-10">
        {cards.length === 0 && <p className="mt-8 text-center t4">没有符合条件的卡片</p>}
        {cards.map((c) => {
          const badge = stateBadge(c);
          const wordDecks = decksByWord.get(c.word.toLowerCase()) ?? [];
          const others = allNames.filter((n) => !wordDecks.includes(n));
          const expanded = addId === c.id;
          return (
            <div key={c.id} className="surface rounded-lg px-4 py-2.5">
              <div className="flex items-center gap-3">
                <span className={`t1 ${c.suspended ? "opacity-50" : ""}`}>{c.word}</span>
                <span className="flex gap-1 flex-wrap min-w-0">
                  {wordDecks.slice(0, 3).map((d) => (
                    <span
                      key={d}
                      className="text-[10px] border border-[var(--border)] rounded-full px-1.5 py-0.5 t3"
                    >
                      {d}
                    </span>
                  ))}
                  {wordDecks.length > 3 && (
                    <span className="text-[10px] t4 self-center">+{wordDecks.length - 3}</span>
                  )}
                </span>
                <span className={`text-[10px] border rounded-full px-2 py-0.5 shrink-0 ${badge.cls}`}>
                  {c.suspended ? badge.text : stateLabel(c.state)}
                </span>
                <span className="ml-auto text-xs t4 shrink-0 hidden sm:inline">
                  {c.reps > 0 ? `学过 ${c.reps} 次` : "未开始"}
                </span>
                <button
                  onClick={() => {
                    setAddId(expanded ? null : c.id);
                    setNewBook("");
                  }}
                  title="加入其他词书"
                  className="text-xs t3 border border-[var(--border)] rounded-md px-1.5 py-1 hover:border-[var(--accent)] accent-text transition-colors flex-none inline-flex"
                >
                  <Icon name="plus" size={12} />
                </button>
                {rowAction(c)}
              </div>
              {expanded && (
                <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap items-center gap-2 text-xs">
                  <span className="t4">加入：</span>
                  {others.length > 0 ? (
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) void joinDeck(c.word, e.target.value);
                        setAddId(null);
                      }}
                      className="field rounded-md px-2 py-1 t2 outline-none focus:border-[var(--accent)] cursor-pointer"
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
                  ) : (
                    <span className="t4">已在全部词书中</span>
                  )}
                  <span className="t4">或自建：</span>
                  <input
                    value={newBook}
                    onChange={(e) => setNewBook(e.target.value)}
                    placeholder="新词书名"
                    spellCheck={false}
                    className="field rounded-md px-2 py-1 w-28 outline-none placeholder:text-[var(--t4)] focus:border-[var(--accent)] t1"
                  />
                  <button
                    onClick={() => {
                      void joinDeck(c.word, newBook).then(() => setAddId(null));
                    }}
                    disabled={!newBook.trim()}
                    className="t3 border border-[var(--border)] rounded-md px-2 py-1 hover:border-[var(--accent)] accent-text transition-colors disabled:opacity-40"
                  >
                    创建
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
