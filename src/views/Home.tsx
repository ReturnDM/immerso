import { useEffect, useState } from "react";
import { getTodayStats, type TodayStats } from "../lib/db";

interface Props {
  onStart: () => void;
  onSearch: () => void;
}

export default function Home({ onStart, onSearch }: Props) {
  const [stats, setStats] = useState<TodayStats | null>(null);

  useEffect(() => {
    getTodayStats().then(setStats).catch(console.error);
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
      <button
        onClick={onSearch}
        className="self-end text-sm text-zinc-500 hover:text-teal-400 transition-colors"
      >
        查词 ↗
      </button>

      <div className="flex-1 flex flex-col items-center justify-center text-center">
        {total > 0 ? (
          <>
            <div className="text-8xl font-extralight tabular-nums">{total}</div>
            <p className="mt-4 text-zinc-400">
              今日待学 · 复习 {stats!.reviewCount} + 新词 {stats!.newCount}
            </p>
            <button
              onClick={onStart}
              className="mt-10 rounded-full bg-teal-700 hover:bg-teal-600 px-12 py-4 text-lg tracking-widest
                         transition-colors shadow-lg shadow-teal-950/50"
            >
              开始
            </button>
            <p className="mt-4 text-xs text-zinc-600 select-none">回车或空格也可以开始</p>
          </>
        ) : (
          <>
            <div className="text-7xl">🌿</div>
            <p className="mt-6 text-xl text-zinc-300">
              {stats === null ? "载入中…" : stats.library === 0 ? "词库还是空的" : "今日任务完成"}
            </p>
            {stats !== null && stats.library > 0 && (
              <p className="mt-2 text-zinc-500">今天已经学了 {stats.doneToday} 次 · 明天见</p>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col items-center gap-1 text-xs text-zinc-600 select-none">
        <p>
          {stats && <>词库 {stats.library} 张卡 · 今日已学 {stats.doneToday} 次 · </>}
          词典数据 ECDICT
        </p>
        {total === 0 && (
          <button onClick={onSearch} className="text-teal-700 hover:text-teal-500 transition-colors">
            去查几个词收进词库 →
          </button>
        )}
      </div>
    </div>
  );
}
