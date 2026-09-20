import { describe, it, expect } from "vitest";
import { editDistance } from "../src/lib/spell";

describe("editDistance（Damerau-Levenshtein）", () => {
  it("相等字符串距离为 0", () => {
    expect(editDistance("hello", "hello")).toBe(0);
    expect(editDistance("", "")).toBe(0);
  });

  it("空串 vs 非空：距离为长度差", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("", "a")).toBe(1);
  });

  it("相邻换位距离为 1", () => {
    expect(editDistance("receive", "recieve")).toBe(1);
    expect(editDistance("ab", "ba")).toBe(1);
    expect(editDistance("wrod", "word")).toBe(1);
  });

  it("单字符替换距离为 1", () => {
    expect(editDistance("cat", "cut")).toBe(1);
    expect(editDistance("word", "work")).toBe(1);
  });

  it("经典案例：kitten -> sitting 距离为 3", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("文档示例：recived -> receive 距离为 2", () => {
    expect(editDistance("recived", "receive")).toBe(2);
  });

  it("多个编辑操作累加", () => {
    expect(editDistance("apple", "apples")).toBe(1); // 末尾加 s
    expect(editDistance("speling", "spelling")).toBe(1); // 缺 l
    expect(editDistance("hte", "the")).toBe(1); // 换位
  });

  it("长度差超过 2 时剪枝直接返回长度差", () => {
    // 内部实现：|len(a)-len(b)| > 2 时直接返回长度差
    expect(editDistance("a", "abcd")).toBe(3);
    expect(editDistance("xyz", "x")).toBe(2); // 长度差 2，仍需完整计算但结果 = 2
    expect(editDistance("abcd", "a")).toBe(3);
  });

  it("长度差恰好为 2 时仍走完整动态规划", () => {
    // |4-2| = 2 不触发剪枝，但真实距离也是 2
    expect(editDistance("abcd", "ac")).toBe(2);
  });

  it("大小写敏感：'Test' 与 'test' 距离为 1", () => {
    expect(editDistance("Test", "test")).toBe(1);
    expect(editDistance("TEST", "test")).toBe(4);
  });

  it("无编辑可能的前缀/后缀差异", () => {
    expect(editDistance("prefix", "pre")).toBe(3);
    expect(editDistance("simple", "ample")).toBe(2); // 去 s 改 i->a
  });

  it("换位 + 其他编辑组合", () => {
    expect(editDistance("recieve", "receivex")).toBeLessThanOrEqual(2);
  });

  it("长词性能不受限：长度差越界直接剪枝", () => {
    const long = "a".repeat(100);
    const short = "b".repeat(10);
    expect(editDistance(long, short)).toBe(90); // |100-10| = 90 > 2 -> 剪枝
  });
});