import { describe, it, expect, vi } from "vitest";

// db.ts / sync.ts 顶层依赖 Tauri 运行时 API，Node 下不可加载 → 整模块 mock 掉。
vi.mock("@tauri-apps/plugin-sql", () => ({
  default: class Database {
    static load() {
      throw new Error("not used in unit tests");
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn() }));

import { fmtDbTime } from "../src/lib/db";
import { timeGte, timeGt, timeLt } from "../src/lib/sync";

describe("fmtDbTime（[B-01] 统一 UTC 时间戳）", () => {
  it("把任意 Date 规范为 UTC 无毫秒 YYYY-MM-DD HH:MM:SS（与 SQLite datetime('now') 同格式）", () => {
    expect(fmtDbTime(new Date("2025-01-10T12:34:56.789Z"))).toBe("2025-01-10 12:34:56");
    expect(fmtDbTime(new Date("2025-01-10T12:34:56.000Z"))).toBe("2025-01-10 12:34:56");
    expect(fmtDbTime(new Date("2025-12-31T23:59:59.999Z"))).toBe("2025-12-31 23:59:59");
  });

  it("默认取当前时刻，格式可被字典序比较", () => {
    expect(fmtDbTime()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("同一时刻无论用哪个时区的字符串构造，规范化结果都相同（跨设备不再颠倒）", () => {
    // 同一时刻的三种表示：+08:00 的晚上 8 点 = -08:00 的凌晨 4 点 = 正午 12 点 UTC
    const a = new Date("2025-01-10T20:00:00+08:00"); // 北京 20:00
    const b = new Date("2025-01-10T04:00:00-08:00"); // 洛杉矶 04:00
    const c = new Date("2025-01-10T12:00:00Z");
    const fa = fmtDbTime(a);
    const fb = fmtDbTime(b);
    const fc = fmtDbTime(c);
    expect(fa).toBe(fb);
    expect(fa).toBe(fc);
    expect(fa).toBe("2025-01-10 12:00:00");
  });

  it("时间越晚字典序越大（与本地时区无关）", () => {
    const earlier = fmtDbTime(new Date("2025-01-10T00:00:00Z"));
    const later = fmtDbTime(new Date("2025-01-10T00:00:01Z"));
    expect(later > earlier).toBe(true);
  });

  it("存量旧数据可读性说明：无时区标记的 'YYYY-MM-DD HH:MM:SS' 会被 JS 按本地时区解析（丢时区）", () => {
    // 这是 B-01 修复注释里的已知坑：空间分隔格式经 `new Date(...)` 解析 = 本地时间。
    // 因此 CAS 快照必须保留 DB 原始字符串，不能经 Date 往返。
    const d = new Date("2025-01-10 12:34:56");
    expect(d.getHours()).toBe(12); // 任何时区下都按本地时间 12:34:56 解析
    // 本地时区非 UTC 时，UTC 小时必然偏移 → toISOString 与"原样 UTC"不等（丢时区）
    const lost = d.getUTCHours() !== 12;
    expect(d.getTimezoneOffset() === 0 ? !lost : lost).toBe(true);
  });
});

describe("时间比较纯函数（sync 合并规则用）", () => {
  it("timeGt / timeGte / timeLt 与字典序=时间序吻合", () => {
    const early = "2025-01-10 00:00:00";
    const late = "2025-01-10 00:00:01";
    expect(timeGt(late, early)).toBe(true);
    expect(timeGt(early, late)).toBe(false);
    expect(timeGt(early, early)).toBe(false);
    expect(timeGte(late, early)).toBe(true);
    expect(timeGte(early, late)).toBe(false);
    expect(timeGte(early, early)).toBe(true);
    expect(timeLt(early, late)).toBe(true);
    expect(timeLt(late, early)).toBe(false);
    expect(timeLt(early, early)).toBe(false);
  });

  it("null / 空串视为最旧（兼容没有 added_at 的旧备份）", () => {
    expect(timeGt("2025-01-10 00:00:00", null)).toBe(true);
    expect(timeGt(null, "2025-01-10 00:00:00")).toBe(false);
    expect(timeGte(null, null)).toBe(true);
    expect(timeLt(null, "2025-01-10 00:00:00")).toBe(true);
    expect(timeGte("", "2025-01-10 00:00:00")).toBe(false);
    expect(timeGte(undefined, undefined)).toBe(true);
  });

  it("跨时区设备产生的同一时刻时间戳判等（不再因本地时间字符串误判先后）", () => {
    // 修复前：北京 20:00 写入 "2025-01-10 20:00:00"（本地），洛杉矶同一时刻写 "2025-01-10 04:00:00"，
    // 字典序比较会错误地认为北京版本更新。修复后两端都写 UTC "2025-01-10 12:00:00" → 判等。
    const beijing = fmtDbTime(new Date("2025-01-10T20:00:00+08:00"));
    const la = fmtDbTime(new Date("2025-01-10T04:00:00-08:00"));
    expect(beijing).toBe(la);
    expect(timeGt(beijing, la)).toBe(false);
    expect(timeGt(la, beijing)).toBe(false);
    expect(timeGte(beijing, la)).toBe(true);
  });
});