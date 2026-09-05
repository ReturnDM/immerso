// 练习模式定义与调度
export const EX_MODES = [
  { id: "self", label: "卡片自评", desc: "翻面对答案，认知自评四档" },
  { id: "dictation", label: "默写拼写", desc: "看释义拼出单词，自动判分" },
  { id: "choice_en", label: "看词选义", desc: "给出单词，四选一选中文释义" },
  { id: "choice_zh", label: "看义选词", desc: "给出中文，四选一选出单词" },
  { id: "listen", label: "听音拼写", desc: "只听发音拼出单词（学过的词）" },
] as const;

export type ExMode = (typeof EX_MODES)[number]["id"];

const NEW_WORD_MODES: ExMode[] = ["self", "choice_en", "choice_zh"];
export const DEFAULT_MODES: ExMode[] = ["self", "dictation", "choice_en", "choice_zh"];

export function parseModes(s: string | null): ExMode[] {
  const set = new Set((s ?? "").split(",").filter(Boolean));
  const valid = EX_MODES.map((m) => m.id).filter((id) => set.has(id as ExMode));
  return valid.length > 0 ? (valid as ExMode[]) : [...DEFAULT_MODES];
}

export const serializeModes = (modes: ExMode[]): string => modes.join(",");

/** 为一张卡挑练习：新词不进默写/听写；没有可用的就回落自评 */
export function pickMode(modes: ExMode[], isNew: boolean, reps: number): ExMode {
  const eligible = modes.filter((m) => {
    if (!isNew) return true;
    return NEW_WORD_MODES.includes(m);
  });
  // 听写/默写对从未学过的词无意义
  const usable = eligible.filter((m) =>
    m === "dictation" || m === "listen" ? reps > 0 || !isNew : true,
  );
  const pool = usable.length > 0 ? usable : ["self" as ExMode];
  return pool[Math.floor(Math.random() * pool.length)];
}
