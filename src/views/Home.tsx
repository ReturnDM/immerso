import { useCallback, useEffect, useState } from "react";
import {
  getCurrentDeck,
  getDecks,
  getTodayStats,
  setCurrentDeck,
  type TodayStats,
} from "../lib/db";
import { Icon } from "../components/Icon";

interface Props {
  onStart: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onStats: () => void;
  onLibrary: () => void;
}

export default function Home({ onStart, onSearch, onSettings, onStats, onLibrary }: Props) {
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [deck, setDeck] = useState("全部");
  const [decks, setDecks] = useState<string[]>(["全部"]);

  useEffect(() => {
    (async () => {
      try {
        const d = await getCurrentDeck();
        setDeck(d);
        setDecks(["全部", ...(await getDecks()).map((x) => x.name)]);
        setStats(await getTodayStats(d));
      } catch (e) {
        console.error(e);
        setStats({ reviewCount: 0, newCount: 0, total: 0, doneToday: 0, library: 0 });
      }
    })();
  }, []);

  const pickDeck = useCallback(async (d: string) => {
    setDeck(d);
    await setCurrentDeck(d);
    setStats(await getTodayStats(d));
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA") return;
      if ((e.key === "Enter" || e.key === " ") && (stats?.total ?? 0) > 0) {
        e.preventDefault();
        onStart();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [stats, onStart]);

  const total = stats?.total ?? 0;
  const done = stats?.doneToday ?? 0;
  const p = done + total > 0 ? done / (done + total) : 0;

  return (
    <div className="min-h-screen flex flex-col items-center px-6 py-9">
      <div className="w-full max-w-3xl self-center flex items-center text-[13px] pt-1.5">
        <button onClick={onSettings} className="link inline-flex items-center gap-1.5">
          <Icon name="sliders" size={15} /> 设置
        </button>
        <button onClick={onStats} className="link ml-4 inline-flex items-center gap-1.5">
          <Icon name="chart" size={15} /> 统计
        </button>
        <button onClick={onLibrary} className="link ml-4 inline-flex items-center gap-1.5">
          <Icon name="layers" size={15} /> 词库
        </button>
        <button onClick={onSearch} className="link ml-auto inline-flex items-center gap-1.5">
          <Icon name="search" size={15} /> 查词
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center w-full">
        {total > 0 ? (
          <>
            <div className="word-serif text-8xl font-normal tabular-nums t1">{total}</div>
            <p className="mt-3 text-sm t2">
              复习 {stats!.reviewCount} · 新词 {stats!.newCount}
              {deck !== "全部" && <span className="t4"> · {deck}</span>}
            </p>
            {/* 水线：今日进度 */}
            <div className="waterline mt-6 w-56">
              <i style={{ width: `${Math.round(p * 100)}%` }} />
            </div>
            <button
              onClick={onStart}
              className="mt-10 rounded-lg bg-teal-700 hover:bg-teal-600 px-14 py-3.5 text-base tracking-[0.4em] pl-[calc(3.5rem+0.4em)]
                         transition-colors text-white"
            >
              开始
            </button>
          </>
        ) : (
          <>
            <div className="word-serif text-5xl t4">浸</div>
            <p className="mt-5 text-lg t2">
              {stats === null ? "载入中…" : stats.library === 0 ? "词库是空的" : "今日已完成"}
            </p>
            {stats !== null && stats.library > 0 && (
              <p className="mt-2 text-sm t3">学了 {stats.doneToday} 次 · 明天见</p>
            )}
          </>
        )}
      </div>

      <div className="w-full max-w-3xl self-center flex items-center text-xs t4 select-none">
        <select
          value={deck}
          onChange={(e) => void pickDeck(e.target.value)}
          className="field rounded-md px-2 py-1 text-xs t2 outline-none focus:border-[var(--accent)] cursor-pointer"
          title="学习词库"
        >
          {decks.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        {stats && <span className="ml-3">{stats.library} 张卡</span>}
        <span className="ml-auto">词典 ECDICT · FSRS-5</span>
      </div>
    </div>
  );
}
