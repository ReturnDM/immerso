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

/**
 * 为一张卡生成练习序列：设置里勾选的所有模式按固定顺序各过一遍，全部完成才算学会。
 * - 新词：跳过默写/听写（先认识后练）
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
  return seq.length > 0 ? seq : ["self" as ExMode];
}
