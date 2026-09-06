import { useEffect, useState } from "react";
import { getApp, getTodayStats, type TodayStats } from "../lib/db";
import { Icon } from "../components/Icon";

interface DayCount {
  date: string; // YYYY-MM-DD（本地时区）
  count: number;
}

async function loadReviewDays(): Promise<DayCount[]> {
  const db = await getApp();
  const rows = await db.select<{ reviewed_at: string }[]>(
    "SELECT reviewed_at FROM reviews",
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    const d = new Date(r.reviewed_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([date, count]) => ({ date, count }));
}

function streakOf(days: DayCount[]): number {
  const has = new Set(days.filter((d) => d.count > 0).map((d) => d.date));
  const key = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const cur = new Date();
  if (!has.has(key(cur))) cur.setDate(cur.getDate() - 1); // 今天还没学不断连击
  let n = 0;
  while (has.has(key(cur))) {
    n++;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}

/** 最近 17 周的日期方阵（周一开头，最后一列到今天） */
function heatGrid(days: DayCount[]): { date: string; count: number }[][] {
  const count = new Map(days.map((d) => [d.date, d.count]));
  const key = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 17 * 7 + 1);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 回到周一
  const weeks: { date: string; count: number }[][] = [];
  const cur = new Date(start);
  while (cur <= today) {
    const week: { date: string; count: number }[] = [];
    for (let i = 0; i < 7 && cur <= today; i++) {
      const k = key(cur);
      week.push({ date: k, count: count.get(k) ?? 0 });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function heatColor(n: number): string {
  if (n === 0) return "bg-[var(--heat-0)]";
  if (n <= 2) return "bg-[var(--heat-1)]";
  if (n <= 5) return "bg-[var(--heat-2)]";
  if (n <= 9) return "bg-[var(--heat-3)]";
  return "bg-[var(--heat-4)]";
}

function Ring({ p, done, total }: { p: number; done: number; total: number }) {
  const r = 56;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative w-36 h-36 flex-none">
      <svg viewBox="0 0 140 140" className="w-full h-full -rotate-90">
        <circle cx="70" cy="70" r={r} fill="none" strokeWidth="2" className="stroke-[var(--border)]" />
        <circle
          cx="70" cy="70" r={r} fill="none" strokeWidth="2" strokeLinecap="round"
          className="stroke-[var(--accent)] transition-[stroke-dasharray] duration-700"
          strokeDasharray={`${c * p} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-3xl font-light t1">{done}</span>
        <span className="text-xs t3">/ {total} 次</span>
      </div>
    </div>
  );
}

export default function Stats({ onBack }: { onBack: () => void }) {
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [days, setDays] = useState<DayCount[]>([]);
  const [totalReviews, setTotalReviews] = useState(0);

  useEffect(() => {
    getTodayStats("全部").then(setStats);
    loadReviewDays().then(setDays);
    getApp().then((db) =>
      db.select<{ n: number }[]>("SELECT COUNT(*) n FROM reviews").then(
        (r) => setTotalReviews(r[0]?.n ?? 0),
      ),
    );
  }, []);

  const done = stats?.doneToday ?? 0;
  const remaining = stats?.total ?? 0;
  const p = done + remaining > 0 ? done / (done + remaining) : 1;
  const streak = streakOf(days);
  const grid = heatGrid(days);
  const library = stats?.library ?? 0;

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-12 pb-10">
      <div className="w-full max-w-xl flex items-center">
        <button onClick={onBack} className="link-strong text-sm">
          ← 首页
        </button>
        <span className="mx-auto text-sm tracking-widest t2 select-none">统 计</span>
        <span className="w-10" />
      </div>

      <div className="mt-10 w-full max-w-xl flex flex-col gap-10">
        {/* 今日进度环 */}
        <div className="flex items-center gap-9">
          <Ring p={p} done={done} total={done + remaining} />
          <div className="text-sm t2 space-y-2.5">
            <p>今日进度 {Math.round(p * 100)}%</p>
            <p className="t3 text-[13px]">
              还剩 {remaining} 次 · 词库 {library} 张卡
            </p>
          </div>
        </div>

        {/* 连续与累计 */}
        <div className="grid grid-cols-2 divide-x divide-[var(--border)]">
          <div className="text-center">
            <p className="num text-3xl font-light t1">{streak}</p>
            <p className="mt-2 text-xs t3 inline-flex items-center gap-1.5">
              <Icon name="flame" size={12} className="accent-text" /> 连续天数
            </p>
          </div>
          <div className="text-center">
            <p className="num text-3xl font-light t1">{totalReviews}</p>
            <p className="mt-2 text-xs t3">累计复习次数</p>
          </div>
        </div>

        {/* 热力图 */}
        <div>
          <p className="t2 text-[13px]">近 17 周</p>
          <div className="mt-4 flex gap-[3px] overflow-x-auto pb-1">
            {grid.map((week, i) => (
              <div key={i} className="flex flex-col gap-[3px]">
                {Array.from({ length: 7 }, (_, j) => {
                  const d = week[j];
                  return d ? (
                    <div
                      key={d.date}
                      title={`${d.date} · ${d.count} 次`}
                      className={`w-3 h-3 rounded-[2px] ${heatColor(d.count)}`}
                    />
                  ) : (
                    <div key={`e${i}${j}`} className="w-3 h-3" />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-1 text-[10px] t4 justify-end">
            少
            <span className="w-3 h-3 rounded-[2px] bg-[var(--heat-0)]" />
            <span className="w-3 h-3 rounded-[2px] bg-[var(--heat-1)]" />
            <span className="w-3 h-3 rounded-[2px] bg-[var(--heat-2)]" />
            <span className="w-3 h-3 rounded-[2px] bg-[var(--heat-3)]" />
            <span className="w-3 h-3 rounded-[2px] bg-[var(--heat-4)]" />
            多
          </div>
        </div>
      </div>
    </div>
  );
}
