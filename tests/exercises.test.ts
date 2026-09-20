import { describe, it, expect } from "vitest";
import {
  EX_MODES,
  DEFAULT_MODES,
  parseModes,
  serializeModes,
  buildSequence,
  deferGap,
  wordForms,
  blankWord,
  type ExMode,
} from "../src/lib/exercises";

describe("EX_MODES / DEFAULT_MODES 常量", () => {
  it("EX_MODES 有 7 种模式且 id 唯一", () => {
    const ids = EX_MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("self");
    expect(ids).toContain("listen");
  });

  it("DEFAULT_MODES 是 EX_MODES 的子集且不含 listen", () => {
    const ids = EX_MODES.map((m) => m.id);
    for (const m of DEFAULT_MODES) expect(ids).toContain(m);
    expect(DEFAULT_MODES).not.toContain("listen");
  });
});

describe("parseModes / serializeModes", () => {
  it("null / 空串 / 全非法 → 回退 DEFAULT_MODES", () => {
    expect(parseModes(null)).toEqual(DEFAULT_MODES);
    expect(parseModes("")).toEqual(DEFAULT_MODES);
    expect(parseModes("bogus,unknown")).toEqual(DEFAULT_MODES);
    expect(parseModes(",,")).toEqual(DEFAULT_MODES);
  });

  it("合法 id 按 EX_MODES 顺序过滤", () => {
    expect(parseModes("listen,self")).toEqual(["self", "listen"]);
    expect(parseModes("dictation,cloze")).toEqual(["dictation", "cloze"]);
  });

  it("混合合法与非法：只保留合法项", () => {
    expect(parseModes("self,nope,dictation")).toEqual(["self", "dictation"]);
  });

  it("serialize -> parse 往返一致", () => {
    const modes: ExMode[] = ["self", "listen", "scramble"];
    const s = serializeModes(modes);
    expect(s).toBe("self,listen,scramble");
    expect(parseModes(s)).toEqual(["self", "listen", "scramble"]);
  });

  it("serializeModes 空数组 -> 空串 -> parse 回退默认", () => {
    expect(serializeModes([])).toBe("");
    expect(parseModes(serializeModes([]))).toEqual(DEFAULT_MODES);
  });
});

describe("buildSequence（练习序列生成）", () => {
  it("新词：跳过默写/听写（reps=0），self 固定在首位", () => {
    const seq = buildSequence(["self", "dictation", "listen", "choice_en"], true, 0, true, 8);
    expect(seq).not.toContain("dictation");
    expect(seq).not.toContain("listen");
    expect(seq[0]).toBe("self");
    expect(seq.length).toBe(2);
  });

  it("新词但已练过（reps>0）：NEW_WORD_MODES 硬编码不含默写/听写，仍被排除", () => {
    // 源码 NEW_WORD_MODES = [self, choice_en, choice_zh, cloze, scramble]，
    // 第一条过滤 `isNew && !NEW_WORD_MODES.includes(m)` 与 reps 无关 -> 新词永不带 dictation/listen
    const seq = buildSequence(["self", "dictation", "listen"], true, 3, true, 8);
    expect(seq).not.toContain("dictation");
    expect(seq).not.toContain("listen");
    expect(seq[0]).toBe("self");
  });

  it("cloze/scramble 无原句时自动排除", () => {
    const seq = buildSequence(["self", "cloze", "scramble"], false, 5, false, 8);
    expect(seq).not.toContain("cloze");
    expect(seq).not.toContain("scramble");
  });

  it("四选一需要 poolSize >= 4", () => {
    const seq = buildSequence(["choice_en", "choice_zh"], false, 5, true, 3);
    expect(seq).not.toContain("choice_en");
    expect(seq).not.toContain("choice_zh");
  });

  it("poolSize >= 4 时四选一保留", () => {
    const seq = buildSequence(["choice_en", "choice_zh"], false, 5, true, 4);
    expect(seq).toContain("choice_en");
    expect(seq).toContain("choice_zh");
  });

  it("过滤后为空 → 回退 ['self']", () => {
    // 新词 + 无原句 + 小词库 + 只剩 choice/cloze/scramble/dictation/listen
    const seq = buildSequence(["dictation", "listen", "cloze", "scramble", "choice_en"], true, 0, false, 2);
    expect(seq).toEqual(["self"]);
  });

  it("非新词：不跳过默写/听写", () => {
    const seq = buildSequence(["dictation", "listen"], false, 5, true, 8);
    expect(seq).toEqual(expect.arrayContaining(["dictation", "listen"]));
  });

  it("结果保持输入集合（新词 self 例外：固定首位不参与洗牌）", () => {
    const modes: ExMode[] = ["self", "choice_en", "choice_zh", "cloze"];
    const seq = buildSequence(modes, true, 2, true, 8);
    expect(seq[0]).toBe("self");
    expect(new Set(seq)).toEqual(new Set(modes));
    expect(seq.length).toBe(modes.length);
  });
});

describe("deferGap（间隔式练习）", () => {
  it("答错恒为 2（尽快巩固）", () => {
    for (let stage = 0; stage < 10; stage++) {
      expect(deferGap(stage, true)).toBe(2);
    }
  });

  it("答对：随轮次加深逐渐拉开（阶段 0 → 2~3）", () => {
    expect(deferGap(0, false)).toBeGreaterThanOrEqual(2);
    expect(deferGap(0, false)).toBeLessThanOrEqual(3);
  });

  it("上限 8：高阶段不无限增长（stage>=3 时 8~9）", () => {
    for (let stage = 3; stage < 20; stage++) {
      const v = deferGap(stage, false);
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it("阶段递增时最小值单调不降", () => {
    expect(deferGap(1, false)).toBeGreaterThanOrEqual(deferGap(0, false));
    expect(deferGap(2, false)).toBeGreaterThanOrEqual(4); // 2+2*2=6？min=6
  });
});

describe("wordForms（ECDICT exchange 解析）", () => {
  it("null / undefined / 空串 → []", () => {
    expect(wordForms(null)).toEqual([]);
    expect(wordForms(undefined)).toEqual([]);
    expect(wordForms("")).toEqual([]);
  });

  it("只取形代码 d/p/i/3/r/t/s 的条目（结果去重）", () => {
    expect(wordForms("d:went/p:gone/0:go/1:goes")).toEqual(["went", "gone"]);
    expect(wordForms("d:ate/p:eaten/i:eating/3:eats/s:eaten")).toEqual(["ate", "eaten", "eating", "eats"]);
  });

  it("结果去重（'eaten' 出现两次只保留一次）", () => {
    const forms = wordForms("p:eaten/s:eaten");
    expect(forms).toEqual(["eaten"]);
  });

  it("过滤空形与超长形（>48 字符）", () => {
    expect(wordForms("d:/p:ok")).toEqual(["ok"]);
    const long = "x".repeat(49);
    expect(wordForms(`d:${long}`)).toEqual([]);
    expect(wordForms("d:" + "y".repeat(48))).toEqual(["y".repeat(48)]); // 48 允许
  });

  it("形带空格时 trim", () => {
    expect(wordForms("d: went ")).toEqual(["went"]);
  });
});

describe("blankWord（原句挖空）", () => {
  it("原形直接命中替换为 _____", () => {
    const r = blankWord("I go to school", "go");
    expect(r).toEqual({ text: "I _____ to school", found: true, form: "go" });
  });

  it("用词形命中句中变体（went → go）", () => {
    const r = blankWord("He went home", "go", ["goes", "went", "gone"]);
    expect(r.found).toBe(true);
    expect(r.form).toBe("went");
    expect(r.text).toBe("He _____ home");
  });

  it("大小写不敏感命中", () => {
    const r = blankWord("My Name is X", "name");
    expect(r.found).toBe(true);
    expect(r.text).toBe("My _____ is X");
  });

  it("词边界：不挖部分匹配（going 不挖 go）", () => {
    const r = blankWord("I am going now", "go");
    expect(r.found).toBe(false);
    expect(r.text).toBe("I am going now");
  });

  it("全都不中：返回原文与 found=false", () => {
    const r = blankWord("He went home", "go"); // 无词形传入，went 不匹配 go
    expect(r).toEqual({ text: "He went home", found: false, form: null });
  });

  it("正则特殊字符被转义（点号、连字符可命中）", () => {
    const r2 = blankWord("3.14 is pi", "3.14");
    expect(r2.found).toBe(true);
    expect(r2.text).toBe("_____ is pi");
    const r3 = blankWord("Send me an e-mail", "e-mail");
    expect(r3.found).toBe(true);
    expect(r3.text).toBe("Send me an _____");
  });

  it("以非字母收尾的词（C++）可用自定义边界命中：\\b 不认识 + 号，lookaround 边界兼容", () => {
    // 旧实现用 \b 词边界，'c++' 尾字符 '+' 非 \w、两侧都非词字符 → 无边界、匹配失败。
    // 修复后边界改为「前后都不是字母/数字/下划线」的 lookaround，语义等价且兼容非字母字符。
    const r = blankWord("It's C# and C++", "c++");
    expect(r.found).toBe(true);
    expect(r.form).toBe("c++");
    expect(r.text).toBe("It's C# and _____");
  });

  it("C++ 单独成词也能命中（行首/行尾边界）", () => {
    const r = blankWord("C++ is hard", "c++");
    expect(r.found).toBe(true);
    expect(r.text).toBe("_____ is hard");
  });

  it("新边界不破坏部分匹配拦截（going 不挖 go）", () => {
    const r = blankWord("I am going now", "go");
    expect(r.found).toBe(false);
    const r2 = blankWord("prego is pasta", "go");
    expect(r2.found).toBe(false);
  });

  it("替换首个命中（同一形出现多次）", () => {
    const r = blankWord("go go go", "go");
    expect(r.text).toBe("_____ go go");
  });
});