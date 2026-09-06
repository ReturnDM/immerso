import { useCallback, useEffect, useState } from "react";
import {
  getCurrentDeck,
  getDecks,
  getTodayStats,
  setCurrentDeck,
  type TodayStats,
} from "../lib/db";
import { maybeAutoSync } from "../lib/cloud";
import { useCountUp } from "../lib/useCountUp";
import DeckPicker from "../components/DeckPicker";

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
  const [deckList, setDeckList] = useState<{ name: string; total?: number }[]>([]);
  const [cloudStatus, setCloudStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await getCurrentDeck();
        setDeck(d);
        const s = await getTodayStats(d);
        setStats(s);
        setDeckList(await getDecks());
      } catch (e) {
        console.error(e);
        setStats({ reviewCount: 0, newCount: 0, total: 0, doneToday: 0, library: 0 });
      }
      // 后台自动云同步（未配置则静默跳过）
      const s = await maybeAutoSync();
      if (s) setCloudStatus(s.includes("✓") ? s.replace("✓ ", "") : s);
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
  const shownTotal = useCountUp(total);
  const pickerOptions = [{ name: "全部", total: stats?.library }, ...deckList];

  return (
    <div className="min-h-screen flex flex-col items-center px-8 py-9">
      <div className="w-full max-w-2xl self-center flex items-center text-[13px] pt-1.5 tracking-wide">
        <button onClick={onSettings} className="link">设置</button>
        <span className="t4 px-1">·</span>
        <button onClick={onStats} className="link">统计</button>
        <span className="t4 px-1">·</span>
        <button onClick={onLibrary} className="link">词库</button>
        <button onClick={onSearch} className="link ml-auto">查词</button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center w-full">
        {total > 0 ? (
          <>
            <div className="num text-7xl font-light t1 tabular-nums">{shownTotal}</div>
            <p className="mt-4 text-[13px] t2 tracking-wide">
              复习 {stats!.reviewCount} · 新词 {stats!.newCount}
              {deck !== "全部" && <span className="t4"> · {deck}</span>}
            </p>
            {/* 水线：今日进度——全站唯一的彩色 */}
            <div className="waterline mt-8 w-72">
              <i style={{ width: `${Math.round(p * 100)}%` }} />
            </div>
            <button
              onClick={onStart}
              className="btn-ink mt-12 rounded-md px-16 py-3 text-[15px] tracking-[0.4em] pl-[calc(4rem+0.4em)]"
            >
              开始
            </button>
          </>
        ) : (
          <>
            <div className="word-serif text-5xl t4">浸</div>
            <p className="mt-6 text-[15px] t2">
              {stats === null ? "载入中…" : stats.library === 0 ? "词库是空的" : "今日已完成"}
            </p>
            {stats !== null && stats.library > 0 && (
              <p className="mt-2 text-[13px] t3">学了 {stats.doneToday} 次 · 明天见</p>
            )}
          </>
        )}
      </div>

      <div className="w-full max-w-2xl self-center flex items-center text-xs t4 select-none">
        <DeckPicker options={pickerOptions} value={deck} onChange={(d) => void pickDeck(d)} />
        {stats && <span className="num ml-3">{stats.library} 张卡</span>}
        {cloudStatus && <span className="ml-3 truncate max-w-[280px]">{cloudStatus}</span>}
        <span className="ml-auto">ECDICT · FSRS-5</span>
      </div>
    </div>
  );
}
