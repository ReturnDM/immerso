import { useCallback, useEffect, useState } from "react";
import {
  getCurrentDeck,
  getDecks,
  getTodayStats,
  setCurrentDeck,
  type TodayStats,
} from "../lib/db";

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
      if ((e.key === "Enter" || e.key === " ") && (stats?.total ?? 0) > 0) {
        e.preventDefault();
        onStart();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [stats, onStart]);

  const total = stats?.total ?? 0;

  return (
    <div className="min-h-screen flex flex-col items-center px-6 py-10">
      <div className="w-full max-w-3xl self-center flex items-center text-sm pt-2">
        <button onClick={onSettings} className="link">设置</button>
        <button onClick={onStats} className="link ml-4">统计</button>
        <button onClick={onLibrary} className="link ml-4">词库</button>
        <select
          value={deck}
          onChange={(e) => void pickDeck(e.target.value)}
          className="ml-auto field rounded-lg px-2 py-1 text-xs t2 outline-none focus:border-[var(--accent)] cursor-pointer"
          title="学习词库"
        >
          {decks.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button onClick={onSearch} className="link ml-3">查词 ↗</button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center">
        {total > 0 ? (
          <>
            <div className="text-8xl font-extralight tabular-nums t1">{total}</div>
            <p className="mt-4 text-[var(--t2)]">
              今日待学 · 复习 {stats!.reviewCount} + 新词 {stats!.newCount}
              {deck !== "全部" && <span className="t4"> · {deck}</span>}
            </p>
            <button
              onClick={onStart}
              className="mt-10 rounded-full bg-teal-700 hover:bg-teal-600 px-12 py-4 text-lg tracking-widest
                         transition-colors shadow-lg shadow-teal-950/50 text-white"
            >
              开始
            </button>
            <p className="mt-4 text-xs t4 select-none">回车或空格也可以开始</p>
          </>
        ) : (
          <>
            <div className="text-7xl">🌿</div>
            <p className="mt-6 text-xl t2">
              {stats === null ? "载入中…" : stats.library === 0 ? "词库还是空的" : "今日任务完成"}
            </p>
            {stats !== null && stats.library > 0 && (
              <p className="mt-2 t3">今天已经学了 {stats.doneToday} 次 · 明天见</p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col items-center gap-1 text-xs t4 select-none">
        <p>
          {stats && <>词库 {stats.library} 张卡 · 今日已学 {stats.doneToday} 次 · </>}
          词典数据 ECDICT
        </p>
        {total === 0 && (
          <button onClick={onSearch} className="accent-text hover:opacity-80 transition-opacity">
            去查几个词收进词库 →
          </button>
        )}
      </div>
    </div>
  );
}
