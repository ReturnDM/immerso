import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// db.ts 顶层 import @tauri-apps/plugin-sql / @tauri-apps/api/event，
// Node 下不可加载，整模块 mock 掉 getApp。
const { getAppMock } = vi.hoisted(() => {
  return {
    getAppMock: vi.fn(),
  };
});

vi.mock("../src/lib/db", () => ({
  getApp: getAppMock,
}));

// 在 import 被测模块之后再定义（顶层 import 会立即执行 fetch? 不会，books.ts 顶层无副作用 fetch）
import { fetchCatalog, importBook, type CatalogBook } from "../src/lib/books";

/** 造一个可断言的 fake db */
function makeFakeDb(existingWords: string[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    select: vi.fn(async () => existingWords.map((w) => ({ w }))),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rowsAffected: 0 };
    }),
  };
  return { db, calls };
}

const BOOK: CatalogBook = {
  id: "cet4",
  name: "四级核心",
  desc: "测试词书",
  file: "cet4.json",
  count: 3,
};

describe("books.fetchCatalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功加载词书目录", async () => {
    const catalog = [{ ...BOOK }, { id: "cet6", name: "六级", desc: "", file: "cet6.json", count: 0 }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => catalog })),
    );
    const result = await fetchCatalog();
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("四级核心");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("catalog.json"));
  });

  it("目录加载失败（非 2xx）抛出带状态码的错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    await expect(fetchCatalog()).rejects.toThrow(/500/);
  });

  it("网络异常向上传播", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(fetchCatalog()).rejects.toThrow("fetch failed");
  });
});

describe("books.importBook", () => {
  beforeEach(() => {
    getAppMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("词表为空：无新词建卡，报告『词都已在库』（fresh=0 分支）", async () => {
    const { db, calls } = makeFakeDb([]);
    getAppMock.mockResolvedValue(db);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
    const report = await importBook(BOOK);
    // fresh.length === 0 时走"都已在库"文案（与新增 0 词同语义但文案不同）
    expect(report).toBe("「四级核心」的词都已在库，已归入词书");
    // SELECT 仍执行（查存量词）；cards / tombstones / deck_words 均不写
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.sql.includes("INSERT INTO cards"))).toHaveLength(0);
    expect(calls.some((c) => c.sql.includes("DELETE FROM tombstones"))).toBe(false);
    // 仅 deck_removals 复活语义照常执行（清整本移除记录）
    expect(calls.some((c) => c.sql.includes("DELETE FROM deck_removals"))).toBe(true);
  });

  it("全部词已在库（大小写不敏感）→ 只归入词书、不建卡", async () => {
    const { db, calls } = makeFakeDb(["Apple", "banana"]);
    getAppMock.mockResolvedValue(db);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ["apple", "BANANA"] })));
    const report = await importBook(BOOK);
    expect(report).toBe("「四级核心」的词都已在库，已归入词书");
    // 没有 INSERT INTO cards（fresh 为空），但有 deck_words 标签补挂
    const cardInserts = calls.filter((c) => c.sql.includes("INSERT INTO cards"));
    expect(cardInserts).toHaveLength(0);
    const tagInserts = calls.filter((c) => c.sql.includes("deck_words"));
    expect(tagInserts).toHaveLength(1);
    // 复活语义：deck_removals 清空；但 tombstones 清理只覆盖 fresh 词，全部已在库时不动
    expect(calls.some((c) => c.sql.includes("DELETE FROM tombstones"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("DELETE FROM deck_removals"))).toBe(true);
  });

  it("混合：仅新词建卡，去重按小写比较", async () => {
    const { db, calls } = makeFakeDb(["apple"]);
    getAppMock.mockResolvedValue(db);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ["Apple", "cherry"] })));
    const report = await importBook(BOOK);
    expect(report).toContain("新增 1 词");
    expect(report).not.toContain("cherry"); // 报告不列词
    const cardInsert = calls.find((c) => c.sql.includes("INSERT INTO cards"));
    // 只插入 cherry（Apple 已在库）
    expect(cardInsert?.params).toEqual(["cherry", "四级核心"]);
  });

  it("新词超过 300 时按 300 分批 INSERT，且每批参数成对展开", async () => {
    const words = Array.from({ length: 650 }, (_, i) => `w${i}`);
    const existing = ["w0", "w100"];
    const { db, calls } = makeFakeDb(existing);
    getAppMock.mockResolvedValue(db);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => words })));
    await importBook(BOOK);
    const cardInserts = calls.filter((c) => c.sql.includes("INSERT INTO cards"));
    // 650 - 2 已存在 = 648 新词 -> ceil(648/300) = 3 批
    expect(cardInserts).toHaveLength(3);
    for (const c of cardInserts) {
      const n = c.sql.match(/\?/g)?.length ?? 0;
      expect(n % 2).toBe(0); // 每词 (?,?)
      expect(c.params.length).toBe(n);
      expect(c.sql).toContain("ON CONFLICT(word) DO NOTHING");
    }
    // tombstones 清理同样分批（批大小 300）
    const tomb = calls.filter((c) => c.sql.includes("DELETE FROM tombstones"));
    expect(tomb.length).toBeGreaterThan(1);
    // deck_words 每批 400
    const tag = calls.filter((c) => c.sql.includes("deck_words"));
    expect(tag.length).toBe(2); // 650 / 400 -> 2 批
  });

  it("词书内容加载失败抛出错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    await expect(importBook(BOOK)).rejects.toThrow(/404/);
  });

  it("getApp 失败时错误向上传播，报告不被吞掉", async () => {
    getAppMock.mockRejectedValue(new Error("db unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ["x"] })));
    await expect(importBook(BOOK)).rejects.toThrow("db unavailable");
  });
});