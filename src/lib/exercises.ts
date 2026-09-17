// 练习模式定义与调度
export const EX_MODES = [
  { id: "self", label: "卡片自评", desc: "翻面对答案，认知自评四档" },
  { id: "dictation", label: "默写拼写", desc: "看释义拼出单词，自动判分" },
  { id: "choice_en", label: "看词选义", desc: "给出单词，四选一选中文释义" },
  { id: "choice_zh", label: "看义选词", desc: "给出中文，四选一选出单词" },
  { id: "listen", label: "听音拼写", desc: "只听发音拼出单词（学过的词）" },
  { id: "cloze", label: "句子填空", desc: "原句挖出目标词，凭语境填回（需收词原句）" },
  { id: "scramble", label: "组词成句", desc: "把打乱的单词按语序拼回原句（需收词原句）" },
] as const;

export type ExMode = (typeof EX_MODES)[number]["id"];

const NEW_WORD_MODES: ExMode[] = ["self", "choice_en", "choice_zh", "cloze", "scramble"];
export const DEFAULT_MODES: ExMode[] = [
  "self",
  "dictation",
  "choice_en",
  "choice_zh",
  "cloze",
  "scramble",
];

export function parseModes(s: string | null): ExMode[] {
  const set = new Set((s ?? "").split(",").filter(Boolean));
  const valid = EX_MODES.map((m) => m.id).filter((id) => set.has(id as ExMode));
  return valid.length > 0 ? (valid as ExMode[]) : [...DEFAULT_MODES];
}

export const serializeModes = (modes: ExMode[]): string => modes.join(",");

/** Fisher-Yates 洗牌（返回新数组） */
function shuffled<T>(a: readonly T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/**
 * 为一张卡生成练习序列：设置里勾选的所有模式各过一遍，全部完成才算学会。
 * - 新词：跳过默写/听写（先认识后练），self 固定在首位（教学卡会消化它）
 * - 顺序随机洗牌（新词 self 除外）：各词的轮次顺序彼此错开，同一种模式不会成串出现
 * - cloze/scramble 依赖收词原句，无原句时自动排除
 * - 四选一需要队列里至少 4 个词才能凑出干扰项
 */
export function buildSequence(
  modes: ExMode[],
  isNew: boolean,
  reps: number,
  hasContext: boolean,
  poolSize: number,
): ExMode[] {
  const seq = modes.filter((m) => {
    if (isNew && !NEW_WORD_MODES.includes(m)) return false;
    if ((m === "dictation" || m === "listen") && isNew && reps === 0) return false;
    if ((m === "cloze" || m === "scramble") && !hasContext) return false;
    if ((m === "choice_en" || m === "choice_zh") && poolSize < 4) return false;
    return true;
  });
  if (seq.length === 0) return ["self" as ExMode];
  const head = isNew && seq[0] === "self" ? 1 : 0;
  return [...seq.slice(0, head), ...shuffled(seq.slice(head))];
}

/**
 * 间隔式练习：过完 stage 轮后隔几张卡再回来做下一轮。
 * 答错隔 2 张尽快巩固；答对随轮次加深逐渐拉开（第 1 轮隔 2~3 张，之后每轮 +2，上限 8）。
 */
export function deferGap(stage: number, wrong: boolean): number {
  if (wrong) return 2;
  return Math.min(2 + stage * 2, 8) + Math.floor(Math.random() * 2);
}

/**
 * ECDICT exchange 词形变化表 → 变形式列表。
 * 代码：d 过去式 / p 过去分词 / i 现在分词 / 3 三单 / r 比较级 / t 最高级 / s 复数；
 * 0/1/2 是词基指针不是形，不取。
 */
export function wordForms(exchange: string | null | undefined): string[] {
  if (!exchange) return [];
  const out: string[] = [];
  for (const part of exchange.split("/")) {
    const m = part.match(/^[dpi3rts]:(.+)$/);
    if (m) out.push(m[1].trim());
  }
  return [...new Set(out)].filter((s) => s.length > 0 && s.length <= 48);
}

/**
 * 原句挖空：依次尝试原形与各词形（不分大小写、词边界），替换首个命中的形为下划线。
 * 句中是 went 而卡是 go 时也能挖掉；全都不中返回 found=false（句子照显，按释义默写）。
 */
export function blankWord(
  sentence: string,
  word: string,
  forms: string[] = [],
): { text: string; found: boolean; form: string | null } {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const w of [word, ...forms]) {
    if (!w) continue;
    const re = new RegExp(`\\b${esc(w)}\\b`, "i");
    if (re.test(sentence)) return { text: sentence.replace(re, "_____"), found: true, form: w };
  }
  return { text: sentence, found: false, form: null };
}
