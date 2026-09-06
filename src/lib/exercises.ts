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
 * 为一张卡挑练习：新词不进默写/听写；没有可用的就回落自评。
 * cloze/scramble 依赖收词原句，hasContext=false 时自动排除。
 */
export function pickMode(
  modes: ExMode[],
  isNew: boolean,
  reps: number,
  hasContext: boolean,
): ExMode {
  const eligible = modes.filter((m) => {
    if (!isNew) return true;
    return NEW_WORD_MODES.includes(m);
  });
  const usable = eligible.filter((m) => {
    if ((m === "dictation" || m === "listen") && isNew && reps === 0) return false;
    if ((m === "cloze" || m === "scramble") && !hasContext) return false;
    return true;
  });
  const pool = usable.length > 0 ? usable : ["self" as ExMode];
  return pool[Math.floor(Math.random() * pool.length)];
}
