import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating,
  State,
  type Card,
  type Grade,
  type RecordLogItem,
} from "ts-fsrs";

// FSRS-5 默认权重，容差 0.9；fuzz 让同批卡片的间隔略微分散
const f = fsrs(
  generatorParameters({ request_retention: 0.9, enable_fuzz: true }),
);

export const GRADES: Grade[] = [
  Rating.Again,
  Rating.Hard,
  Rating.Good,
  Rating.Easy,
];

export const GRADE_META: Record<number, { label: string; key: string; cls: string }> = {
  [Rating.Again]: { label: "忘记", key: "1", cls: "bg-rose-950/70 hover:bg-rose-900/70 border-rose-900 text-rose-300" },
  [Rating.Hard]: { label: "困难", key: "2", cls: "bg-amber-950/70 hover:bg-amber-900/70 border-amber-900 text-amber-300" },
  [Rating.Good]: { label: "良好", key: "3", cls: "bg-teal-950/70 hover:bg-teal-900/70 border-teal-900 text-teal-300" },
  [Rating.Easy]: { label: "简单", key: "4", cls: "bg-sky-950/70 hover:bg-sky-900/70 border-sky-900 text-sky-300" },
};

// ---------- 时间解析（[B-01] 配套） ----------
/**
 * 解析 DB 时间串为 Date。兼容三种存量格式：
 * 1. 新格式 UTC 空格 "YYYY-MM-DD HH:MM:SS"（fmtDbTime / SQLite datetime('now')）→ 补 T+Z 按 UTC 解析；
 * 2. ISO "YYYY-MM-DDTHH:MM:SS.sssZ"（旧版 toISOString 写入的 due/last_review）→ 直接解析；
 * 3. 最老版本本地时间 "YYYY-MM-DD HH:MM:SS"（无时区标记）→ 与 1 无法区分，按 UTC 解析，
 *    与「存量旧数据无法完美迁移」的整体取舍一致。
 * 注意：直接 new Date("YYYY-MM-DD HH:MM:SS") 会按**本地时区**解析，丢失 UTC 语义（东八区偏 8h）。
 */
function parseDbTime(s: string | null | undefined): Date | undefined {
  if (!s) return undefined;
  const t = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 数据库行 + 补充的到期时间 → ts-fsrs Card */
export function toCard(row: {
  state: number;
  stability: number;
  difficulty: number;
  due: string | null;
  last_review: string | null;
  reps: number;
  lapses: number;
}): Card {
  if (row.state === State.New) return createEmptyCard();
  const due = parseDbTime(row.due);
  const last = parseDbTime(row.last_review);
  const dueMs = due?.getTime() ?? Date.now();
  const lastMs = last?.getTime() ?? 0;
  return {
    due: due ?? new Date(dueMs),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: last ? Math.max(0, Math.floor((Date.now() - lastMs) / 86_400_000)) : 0,
    scheduled_days: last ? Math.max(0, Math.round((dueMs - lastMs) / 86_400_000)) : 0,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    ...(last ? { last_review: last } : {}),
  } as Card;
}

/** 四档预览：间隔文案 + 完整调度结果（实际评分时直接采用，保证所见即所得） */
export function previewOptions(card: Card): {
  options: { grade: Grade; text: string }[];
  scheduling: Record<Grade, RecordLogItem>;
} {
  const now = new Date();
  const scheduling = f.repeat(card, now);
  const options = GRADES.map((g) => ({
    grade: g,
    text: intervalText(scheduling[g].card.due.getTime() - now.getTime()),
  }));
  return { options, scheduling };
}

export function schedule(card: Card, grade: Grade): RecordLogItem {
  return f.next(card, new Date(), grade);
}

export function intervalText(ms: number): string {
  if (ms <= 60_000) return "1 分钟内";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `${h} 小时`;
  return `${Math.round(ms / 86_400_000)} 天`;
}

/** 卡片对用户展示的状态名 */
export function stateLabel(state: number): string {
  if (state === State.New) return "新词";
  if (state === State.Review) return "复习";
  return "巩固中";
}

/** 系统 TTS 读单词 */
export function speak(text: string) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
