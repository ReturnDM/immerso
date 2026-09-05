import { useCallback, useEffect, useState } from "react";
import {
  deleteCard,
  getDecks,
  getLibrary,
  setCardSuspended,
  type LibCard,
  type LibFilter,
} from "../lib/db";
import { stateLabel } from "../lib/fsrs";

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
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const reload = useCallback(() => {
    void getLibrary(deck, filter, q).then(setCards);
  }, [deck, filter, q]);

  useEffect(() => {
    void getDecks().then(setDecks);
  }, [cards]);

  useEffect(() => {
    const t = setTimeout(reload, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [reload]);

  const options = [
    { name: "全部", total: decks.reduce((s, d) => s + d.total, 0) },
    ...decks,
  ];

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
          className="text-xs border border-red-900 text-red-400 rounded-full px-3 py-1 hover:bg-red-950/60 transition-colors"
        >
          确认删除
        </button>
      );
    }
    return (
      <button
        onClick={() => void setCardSuspended(c.id, !c.suspended).then(reload)}
        className="text-xs border border-[var(--border)] t3 rounded-full px-3 py-1 hover:border-[var(--accent)] accent-text transition-colors"
      >
        {c.suspended ? "恢复" : "搁置"}
      </button>
    );
  };

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-12 pb-10">
      <div className="w-full max-w-xl flex items-center">
        <button onClick={onBack} className="link-strong text-sm">← 首页</button>
        <span className="mx-auto text-sm tracking-widest t2 select-none">词 库</span>
        <span className="w-10" />
      </div>

      {/* 词库 chips */}
      <div className="mt-6 w-full max-w-xl flex flex-wrap gap-2">
        {options.map((d) => (
          <button
            key={d.name}
            onClick={() => setDeck(d.name)}
            className={`text-xs rounded-full px-3 py-1.5 border transition-colors ${
              deck === d.name
                ? "border-teal-700 bg-teal-700/20 accent-text"
                : "border-[var(--border)] t3 hover:border-[var(--accent)]"
            }`}
          >
            {d.name} <span className="opacity-60 tabular-nums">{d.total}</span>
          </button>
        ))}
      </div>

      {/* 过滤 + 搜索 */}
      <div className="mt-4 w-full max-w-xl flex items-center gap-3">
        <div className="flex rounded-full border border-[var(--border)] p-0.5">
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
              className={`px-3 py-1 rounded-full text-xs transition-colors ${
                filter === o.v ? "bg-teal-700 text-white" : "t3 hover:text-[var(--text)]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜单词…"
          spellCheck={false}
          className="flex-1 field rounded-full px-4 py-1.5 text-sm outline-none
                     placeholder:text-[var(--t4)] focus:border-[var(--accent)] transition-colors t1"
        />
      </div>

      {/* 列表 */}
      <div className="mt-4 w-full max-w-xl flex flex-col gap-2 pb-10">
        {cards.length === 0 && <p className="mt-8 text-center t4">没有符合条件的卡片</p>}
        {cards.map((c) => {
          const badge = stateBadge(c);
          return (
            <div
              key={c.id}
              className="surface rounded-xl px-4 py-2.5 flex items-center gap-3"
            >
              <span className={`t1 ${c.suspended ? "opacity-50" : ""}`}>{c.word}</span>
              <span className="text-[10px] t4 truncate max-w-[80px]">{c.deck}</span>
              <span
                className={`text-[10px] border rounded-full px-2 py-0.5 shrink-0 ${badge.cls}`}
              >
                {c.suspended ? badge.text : stateLabel(c.state)}
              </span>
              <span className="ml-auto text-xs t4 shrink-0">
                {c.reps > 0 ? `学过 ${c.reps} 次` : "未开始"}
              </span>
              {rowAction(c)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
