import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rating, type Grade, type RecordLogItem } from "ts-fsrs";
import {
  applyReview,
  getCurrentDeck,
  getEnabledModes,
  getQueue,
  getSetting,
  type QueueItem,
} from "../lib/db";
import { previewOptions, speak, stateLabel } from "../lib/fsrs";
import { maybeAutoSync } from "../lib/cloud";
import { buildSequence, EX_MODES, type ExMode } from "../lib/exercises";
import { Icon } from "../components/Icon";

// ECDICT 的 translation 用字面 "\n" 分隔多条释义
function firstLine(t: string | undefined): string {
  return (t ?? "").split("\\n")[0] || "（无释义）";
}
function Translation({ text }: { text: string }) {
  return (
    <>
      {text.split("\\n").map((line, i) => (
        <p key={i} className="word-serif m-0 leading-relaxed">
          {line}
        </p>
      ))}
    </>
  );
}

const GRADE_ORDER: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
const GRADE_LABEL: Record<number, string> = {
  [Rating.Again]: "忘记",
  [Rating.Hard]: "困难",
  [Rating.Good]: "良好",
  [Rating.Easy]: "简单",
};

const norm = (s: string) => s.trim().toLowerCase();
const shuffle = <T,>(a: T[]): T[] =>
  a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map(([, v]) => v);

/** 原句挖空：把目标词（不分大小写、词边界）替换为下划线；找不到返回 false（句子照显，直接默写） */
function blankWord(sentence: string, word: string): { text: string; found: boolean } {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${esc}\\b`, "i");
  return { text: sentence.replace(re, "_____"), found: re.test(sentence) };
}

/** 组词成句：点击乱序 token 拼回原句，全部放对自动判对 */
function Scramble({
  sentence,
  onResult,
}: {
  sentence: string;
  onResult: (ok: boolean) => void;
}) {
  const tokens = useMemo(() => {
    const t = sentence.trim().split(/\s+/).map((w, i) => ({ w, i }));
    let s = shuffle(t);
    // 洗完恰好等于原句（单词少的句子概率不低）就轮换一位
    if (s.every((x, i) => x.i === i) && s.length > 1) s = [...s.slice(1), s[0]];
    return s;
  }, [sentence]);
  const [placed, setPlaced] = useState<number[]>([]);
  const done = placed.length === tokens.length;

  useEffect(() => {
    if (done) onResult(tokens.every((_, i) => tokens[placed[i]]?.i === i));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  return (
    <div className="w-full">
      {/* 已拼区 */}
      <div className="min-h-14 flex flex-wrap gap-2 items-center justify-center border-b border-[var(--border)] pb-4 mb-5">
        {placed.length === 0 && <span className="text-xs t4">按语序点击下方单词</span>}
        {placed.map((ti, pos) => (
          <button
            key={`${ti}-${pos}`}
            onClick={() => setPlaced((p) => p.filter((_, k) => k !== pos))}
            className="word-serif text-base t1 border border-[var(--border)] rounded-md px-2.5 py-1
                       hover:border-[var(--t3)] transition-colors"
          >
            {tokens[ti].w}
          </button>
        ))}
      </div>
      {/* 待选池 */}
      <div className="flex flex-wrap gap-2 justify-center">
        {tokens.map((t, i) =>
          placed.includes(i) ? (
            <span key={i} className="word-serif text-base border border-transparent rounded-md px-2.5 py-1 opacity-25">
              {t.w}
            </span>
          ) : (
            <button
              key={i}
              onClick={() => setPlaced((p) => [...p, i])}
              className="word-serif text-base t2 border border-[var(--border)] rounded-md px-2.5 py-1
                         hover:border-[var(--accent)] hover:text-[var(--text)] active:scale-95 transition-all"
            >
              {t.w}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** 复习完成屏底部：后台云同步（未配置则不渲染） */
function DoneSync() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    maybeAutoSync().then((s) => s && setMsg(s));
  }, []);
  if (!msg) return null;
  return <p className="text-xs t4">{msg}</p>;
}

export default function Review({ onExit }: { onExit: () => void }) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [modes, setModes] = useState<ExMode[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [intervals, setIntervals] = useState<{ grade: Grade; text: string }[] | null>(null);
  const [bug, setBug] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"ask" | "right" | "wrong">("ask");
  const [pick, setPick] = useState<number | null>(null);
  const [taughtId, setTaughtId] = useState<number | null>(null);
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());
  const [total, setTotal] = useState(0);
  const [wrongIds, setWrongIds] = useState<Map<number, QueueItem>>(new Map());
  const [retryCount, setRetryCount] = useState(0);
  /** 每张卡的练习序列：勾选的所有模式按顺序各过一遍，最后一个作答完才评分；评分前可在序列内前后移动 */
  const seqRef = useRef<Map<number, { seq: ExMode[]; pos: number }>>(new Map());
  const autoSpeak = useRef(false);
  const schedulingRef = useRef<Record<Grade, RecordLogItem> | null>(null);
  const autoGrade = useRef<Grade | null>(null);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      try {
        const [deck, ms, ap] = await Promise.all([
          getCurrentDeck(),
          getEnabledModes(),
          getSetting("auto_pronounce"),
        ]);
        setModes(ms);
        autoSpeak.current = ap !== "off";
        const q = await getQueue(deck);
        setQueue(q);
        setTotal(q.length);
      } catch (e) {
        setLoadErr(String(e));
      }
    })();
  }, []);

  const item = queue?.[idx];
  // 模式序列：惰性构建；重试卡（Again 接回）重建全新序列
  const seqState = useMemo(() => {
    if (!item || !modes) return null;
    let s = seqRef.current.get(item.id);
    if (!s) {
      const seq = buildSequence(modes, item.isNew, item.card.reps, !!item.sourceContext, queue?.length ?? 0);
      s = { seq, pos: 0 };
      seqRef.current.set(item.id, s);
    }
    return s;
  }, [item, modes, queue]);
  const mode: ExMode = seqState ? seqState.seq[seqState.pos] ?? "self" : "self";
  /** 当前是否是序列最后一个模式：是才进入评分，否则「下一个」 */
  const isLast = !seqState || seqState.pos >= seqState.seq.length - 1;
  const seqKey = item && seqState ? `${item.id}-${seqState.pos}` : "";

  // 四选一的干扰项从同队列其他卡生成；不够四个就回落自评
  const choice = useMemo(() => {
    if (mode !== "choice_en" && mode !== "choice_zh") return null;
    if (!item || !queue) return null;
    const others = shuffle(queue.filter((x) => x.id !== item.id));
    if (mode === "choice_zh") {
      const words = [...new Set(others.map((o) => o.word))].slice(0, 3);
      if (words.length < 3) return null;
      return { opts: shuffle([item.word, ...words]), correct: item.word };
    }
    const means = [...new Set(others.map((o) => firstLine(o.dict?.translation)))]
      .filter((m) => m !== firstLine(item.dict?.translation))
      .slice(0, 3);
    if (means.length < 3) return null;
    const correct = firstLine(item.dict?.translation);
    return { opts: shuffle([correct, ...means]), correct };
  }, [item, mode, queue]);

  const effMode: ExMode = choice === null && (mode === "choice_en" || mode === "choice_zh")
    ? "self"
    : mode;
  const typing = effMode === "dictation" || effMode === "listen" || effMode === "cloze";
  // 新词教学：state 仍为 New 的卡首遇先教后测（重试卡携带新状态，不会重教）
  const teaching = !!item && item.card.state === 0 && taughtId !== item.id;

  // 听音拼写：出题即朗读；教学卡出现即朗读
  useEffect(() => {
    if (item && phase === "ask" && (teaching || effMode === "listen")) speak(item.word);
  }, [item, effMode, phase, teaching]);

  const reveal = useCallback(() => {
    if (!item) return;
    const { options: iv, scheduling } = previewOptions(item.card);
    schedulingRef.current = scheduling;
    setIntervals(iv);
    setRevealed(true);
    if (autoSpeak.current && effMode !== "listen") speak(item.word);
  }, [item, effMode]);

  const flip = useCallback(() => {
    if (!item) return;
    autoGrade.current = null;
    reveal();
  }, [reveal]);

  /** 完成当前模式，进入序列下一个模式（最后一个模式由评分流程接管） */
  const advanceMode = useCallback(() => {
    if (!item) return;
    const s = seqRef.current.get(item.id);
    if (!s || s.pos >= s.seq.length - 1) return;
    s.pos += 1;
    setRevealed(false);
    setIntervals(null);
    setAnswer("");
    setPhase("ask");
    setPick(null);
    autoGrade.current = null;
    shownAt.current = Date.now();
  }, [item]);

  /** 退回当前词的上一模式再看一遍；该词一旦评分进入下一词即不可回退 */
  const prevMode = useCallback(() => {
    if (!item) return;
    const s = seqRef.current.get(item.id);
    if (!s || s.pos === 0) return;
    s.pos -= 1;
    setRevealed(false);
    setIntervals(null);
    setAnswer("");
    setPhase("ask");
    setPick(null);
    autoGrade.current = null;
    shownAt.current = Date.now();
  }, [item]);

  const grade = useCallback(
    async (g: Grade, presched?: RecordLogItem) => {
      if (!item || !revealed) return;
      const sched = presched ?? schedulingRef.current?.[g];
      if (!sched) return;
      try {
        await applyReview(item, g, sched, Date.now() - shownAt.current);
      } catch (e) {
        setBug(String(e));
        return;
      }
      // 忘记 → 本轮内重现：携带最新 FSRS 状态，隔 3~5 张后整条模式序列重来
      if (g === Rating.Again) {
        const retryItem = { ...item, card: sched.card };
        seqRef.current.delete(item.id); // 重试卡重新生成完整序列
        setQueue((q) => {
          if (!q) return q;
          const at = Math.min(idx + 3 + Math.floor(Math.random() * 3), q.length);
          const next = [...q];
          next.splice(at, 0, retryItem);
          return next;
        });
        setRetryCount((n) => n + 1);
        setWrongIds((m) => new Map(m).set(item.id, retryItem));
        setDoneIds((s) => {
          const n = new Set(s);
          n.delete(item.id);
          return n;
        });
      } else {
        setDoneIds((s) => new Set(s).add(item.id));
      }
      // 末尾评忘记时上面已把重试卡接回队尾，照常推进即可
      if (idx + 1 >= queue!.length && g !== Rating.Again) setQueue([]);
      else {
        setIdx(idx + 1);
        setRevealed(false);
        setIntervals(null);
        setAnswer("");
        setPhase("ask");
        setPick(null);
        autoGrade.current = null;
        shownAt.current = Date.now();
      }
    },
    [item, revealed, idx, queue],
  );

  const submitTyping = useCallback(() => {
    if (!item || phase !== "ask") return;
    const { options: iv, scheduling } = previewOptions(item.card);
    schedulingRef.current = scheduling;
    setIntervals(iv);
    setRevealed(true);
    if (autoSpeak.current) speak(item.word);
    if (norm(answer) === norm(item.word)) {
      setPhase("right");
      autoGrade.current = Rating.Good;
    } else {
      setPhase("wrong");
      autoGrade.current = null;
    }
    // 提交后失焦：让后续 Enter/Space 落到全局键盘处理（下一模式或评分）
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, [item, phase, answer]);

  const pickChoice = useCallback(
    (i: number) => {
      if (!choice || phase !== "ask") return;
      const { options: iv, scheduling } = previewOptions(item!.card);
      schedulingRef.current = scheduling;
      setIntervals(iv);
      setRevealed(true);
      setPick(i);
      if (autoSpeak.current) speak(item!.word);
      if (choice.opts[i] === choice.correct) {
        setPhase("right");
        autoGrade.current = Rating.Good;
      } else {
        setPhase("wrong");
        autoGrade.current = null;
      }
    },
    [choice, phase, item],
  );

  /** 组词成句拼完：全部归位自动良好，否则揭示原句手动评分 */
  const answerScramble = useCallback(
    (ok: boolean) => {
      if (!item || phase !== "ask") return;
      const { options: iv, scheduling } = previewOptions(item.card);
      schedulingRef.current = scheduling;
      setIntervals(iv);
      setRevealed(true);
      if (autoSpeak.current) speak(item.word);
      if (ok) {
        setPhase("right");
        autoGrade.current = Rating.Good;
      } else {
        setPhase("wrong");
        autoGrade.current = null;
      }
    },
    [item, phase],
  );

  // 键盘
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!item) return;
      if (e.key === "Escape") return onExit();
      if (teaching) {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          setTaughtId(item.id);
        }
        return;
      }
      if (typing && phase === "ask") return; // 输入框自己处理回车
      // 该词未评分时：退格/左方向键退回上一模式
      if (phase === "ask" && seqState && seqState.pos > 0 && (e.key === "Backspace" || e.key === "ArrowLeft")) {
        e.preventDefault();
        prevMode();
        return;
      }
      // 最后一个模式：答对 → 一键评「良好」
      if (isLast && phase === "right" && autoGrade.current !== null) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void grade(autoGrade.current);
        }
        return;
      }
      // 非最后一个模式：作答/翻面后回车进入下一个模式
      if (revealed && !isLast) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          advanceMode();
        }
        return;
      }
      // 最后一个模式的评分：数字键；self 模式翻面后 空格/回车 = 良好
      if (revealed && isLast) {
        if (["1", "2", "3", "4"].includes(e.key)) {
          const g = GRADE_ORDER[Number(e.key) - 1];
          if (phase === "wrong" && g === Rating.Easy) return;
          e.preventDefault();
          void grade(g);
          return;
        }
        if (phase === "ask" && effMode === "self" && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          void grade(Rating.Good);
        }
        return;
      }
      if (effMode === "choice_en" || effMode === "choice_zh") {
        if (!revealed && ["1", "2", "3", "4"].includes(e.key) && choice) {
          const i = Number(e.key) - 1;
          if (i < choice.opts.length) {
            e.preventDefault();
            pickChoice(i);
          }
        }
        return;
      }
      if (effMode === "scramble" && !revealed) return; // 拼句纯点击，不接空格翻面
      if ((e.key === " " || e.key === "Enter") && !revealed) {
        e.preventDefault();
        flip();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [item, revealed, phase, typing, mode, choice, teaching, flip, grade, pickChoice, onExit, advanceMode, prevMode, isLast, seqState]);

  if (queue === null || modes === null) {
    return (
      <div className="min-h-screen flex items-center justify-center t3">
        {loadErr ?? "载入中…"}
      </div>
    );
  }

  if (queue.length === 0) {
    const wrongList = [...wrongIds.values()];
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5">
        <Icon name="check" size={36} className="accent-text animate-check-in" strokeWidth={1.4} />
        <p className="text-xl t1 word-serif">今日完成</p>
        <p className="t3 text-[13px] num">
          本轮 {doneIds.size} 词{retryCount > 0 ? ` · 重试 ${retryCount} 次` : ""}
        </p>
        {wrongList.length > 0 && (
          <div className="w-full max-w-sm text-left">
            <p className="text-xs t4 mb-2">本轮忘记 · {wrongList.length} 词</p>
            <div className="border-t border-[var(--border)]">
              {wrongList.map((wq) => (
                <div key={wq.id} className="flex items-baseline gap-4 py-2 border-b border-[var(--border)]">
                  <span className="word-serif text-[15px] t1 shrink-0">{wq.word}</span>
                  <span className="text-xs t3 truncate">{firstLine(wq.dict?.translation)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {wrongList.length > 0 ? (
          <button
            onClick={() => {
              const items = shuffle([...wrongList]);
              seqRef.current.clear(); // 重练的每张卡重新生成完整模式序列
              setQueue(items);
              setTotal(items.length);
              setDoneIds(new Set());
              setWrongIds(new Map());
              setRetryCount(0);
              setIdx(0);
              setRevealed(false);
              setIntervals(null);
              setAnswer("");
              setPhase("ask");
              setPick(null);
              shownAt.current = Date.now();
            }}
            className="btn-ink rounded-md px-8 py-2.5 text-sm"
          >
            再练一轮错词
          </button>
        ) : (
          <p className="t3 text-[13px]">一个都没忘，漂亮</p>
        )}
        <button onClick={onExit} className="mt-1 link text-sm hairline pt-1">
          回到首页
        </button>
        <DoneSync />
      </div>
    );
  }

  const progress = total > 0 ? doneIds.size / total : 0;
  const promptWord = effMode === "choice_en" || effMode === "self";

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶栏 + 水线（本轮进度） */}
      <div className="pt-10">
        <div className="flex items-center px-6 text-sm t3">
          <button onClick={onExit} className="link-strong" title="退出">
            <Icon name="close" size={16} />
          </button>
          <span className="mx-auto num text-[13px] t2">
            {idx + 1} / {queue.length}
          </span>
          <span className="t3 text-[13px]">
            {item!.isNew ? "新词" : stateLabel(item!.card.state)}
            {item!.deck !== "生词本" && <span className="t4"> · {item!.deck}</span>}
          </span>
        </div>
        <div className="waterline mt-2.5 mx-6">
          <i style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        {!teaching && seqState && (
          <p className="text-center text-[11px] t4 mt-2">
            模式 {Math.min(seqState.pos + 1, seqState.seq.length)} / {seqState.seq.length} ·{" "}
            {EX_MODES.find((m) => m.id === mode)?.label}
          </p>
        )}
      </div>

      {/* 出题区 */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 select-none">
        {!revealed ? (
          teaching ? (
            /* 新词教学卡：先认识，再进练习 */
            <div key={item!.id} className="text-center w-full max-w-xl animate-card-in">
              <div className="word-serif text-6xl t1 tracking-wide">{item!.word}</div>
              {item!.dict?.phonetic && item!.dict.phonetic.toLowerCase() !== item!.word.toLowerCase() && (
                <p className="mt-4 num text-sm t3">/{item!.dict.phonetic}/</p>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  speak(item!.word);
                }}
                className="mt-4 t3 hover:text-[var(--text)] transition-colors inline-flex"
                title="发音"
              >
                <Icon name="speaker" size={15} />
              </button>
              <div className="mt-6 text-base space-y-0.5">
                <Translation text={item!.dict?.translation ?? "（词典里没有这条）"} />
              </div>
              {item!.sourceContext && (
                <blockquote className="mt-4 border-l-2 border-[var(--accent-dim)] pl-4 text-left text-sm t3 italic">
                  {item!.sourceContext}
                </blockquote>
              )}
              <button
                onClick={() => setTaughtId(item!.id)}
                className="btn-ink rounded-md px-8 py-2.5 text-sm mt-12"
              >
                开始练习
                <span className="opacity-50 text-xs ml-2 num">空格 / Enter</span>
              </button>
            </div>
          ) : effMode === "self" ? (
            <div
              key={seqKey}
              className="text-center cursor-pointer animate-card-in w-full"
              onClick={flip}
            >
              <div className="word-serif text-7xl t1 tracking-wide">{item!.word}</div>
              {item!.dict?.phonetic && item!.dict.phonetic.toLowerCase() !== item!.word.toLowerCase() && (
                <p className="mt-4 num text-sm t3">/{item!.dict.phonetic}/</p>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  speak(item!.word);
                }}
                className="mt-6 t3 hover:text-[var(--text)] transition-colors inline-flex"
                title="发音"
              >
                <Icon name="speaker" size={15} />
              </button>
              <p className="mt-16 text-xs t4 animate-pulse">空格 / 回车 翻面</p>
            </div>
          ) : typing ? (
            <div key={seqKey} className="text-center w-full max-w-xl animate-card-in">
              <p className="text-xs t4 tracking-[0.3em]">
                {effMode === "listen" ? "听 写" : effMode === "cloze" ? "填 空" : "默 写"}
              </p>
              {effMode === "cloze" ? (
                <>
                  <p className="mt-7 text-lg t1 leading-relaxed text-left">
                    {blankWord(item!.sourceContext ?? "", item!.word).text}
                  </p>
                  {!blankWord(item!.sourceContext ?? "", item!.word).found && (
                    <p className="mt-2 text-[11px] t4 text-left">
                      原句里没有该词原形，按释义直接默写
                    </p>
                  )}
                  <p className="word-serif mt-3 text-sm t3">{firstLine(item!.dict?.translation)}</p>
                </>
              ) : effMode === "dictation" ? (
                <div className="word-serif mt-6 text-lg t1 leading-relaxed">
                  <Translation text={item!.dict?.translation ?? "（词典缺释义）"} />
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    speak(item!.word);
                  }}
                  className="mt-4 t2 hover:text-[var(--text)] transition-colors inline-flex mx-auto"
                  title="重听"
                >
                  <Icon name="speaker" size={22} />
                </button>
              )}
              {effMode === "dictation" && item!.dict?.definition && (
                <p className="mt-3 text-sm t3 italic">{item!.dict.definition.split("\\n")[0]}</p>
              )}
              <input
                autoFocus
                key={seqKey}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitTyping();
                  }
                }}
                placeholder={effMode === "cloze" ? "填入空格里的单词" : "输入英文后回车"}
                spellCheck={false}
                autoComplete="off"
                className="word-serif field mt-9 w-80 px-2 py-2.5 text-2xl text-center t1"
              />
              <p className="mt-5 text-xs t4">
                {effMode === "listen" ? "回车提交 · 可点喇叭重听" : "回车提交"}
              </p>
            </div>
          ) : effMode === "scramble" ? (
            <div key={seqKey} className="w-full max-w-xl animate-card-in">
              <p className="text-center text-xs t4 tracking-[0.3em] mb-7">组 词 成 句</p>
              <p className="word-serif text-center text-sm t3 mb-6">{firstLine(item!.dict?.translation)}</p>
              <Scramble sentence={item!.sourceContext ?? ""} onResult={answerScramble} />
            </div>
          ) : (
            <div key={seqKey} className="text-center w-full max-w-lg animate-card-in">
              {effMode === "choice_en" ? (
                <>
                  <div className="word-serif text-6xl t1">{item!.word}</div>
                  {item!.dict?.phonetic && item!.dict.phonetic.toLowerCase() !== item!.word.toLowerCase() && (
                    <p className="mt-3 num text-sm t3">/{item!.dict.phonetic}/</p>
                  )}
                </>
              ) : (
                <div className="text-xl t1 leading-relaxed">
                  <Translation text={item!.dict?.translation ?? "（词典缺释义）"} />
                </div>
              )}
              <div className="mt-10 w-full border-t border-[var(--border)]">
                {choice!.opts.map((opt, i) => {
                  const isCorrect = opt === choice!.correct;
                  const picked = pick === i;
                  const cls =
                    phase === "ask"
                      ? "t2 hover:text-[var(--text)] hover:bg-[var(--hover)]"
                      : isCorrect
                        ? "accent-text"
                        : picked
                          ? "text-rose-400"
                          : "t4";
                  return (
                    <button
                      key={i}
                      onClick={() => pickChoice(i)}
                      disabled={phase !== "ask"}
                      className={`w-full text-left px-3 py-3.5 transition-colors flex items-center gap-4
                                  border-b border-[var(--border)] disabled:cursor-default ${cls}`}
                    >
                      <span className="num text-xs t4 w-4 shrink-0">{i + 1}</span>
                      <span className={effMode === "choice_zh" ? "word-serif text-lg" : "text-sm"}>
                        {opt}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-5 text-xs t4">数字键 1-4 可直接作答</p>
            </div>
          )
        ) : (
          /* 揭晓 */
          <div key={`r${seqKey}`} className="text-center max-w-xl w-full animate-card-in">
            {phase === "right" && typing && <p className="mb-4 accent-text text-sm">✓ 正确</p>}
            {phase === "right" && (effMode === "choice_en" || effMode === "choice_zh") && (
              <p className="mb-4 accent-text text-sm">✓ 答对了</p>
            )}
            {phase === "wrong" && typing && (
              <p className="mb-4 text-rose-400 text-sm">
                ✗ 你写的是「{answer.trim() || "（空）"}」
              </p>
            )}
            {phase === "wrong" && (effMode === "choice_en" || effMode === "choice_zh") && (
              <p className="mb-4 text-rose-400 text-sm">✗ 答错了，正确答案高亮如下</p>
            )}
            <div className="word-serif text-5xl t1">{item!.word}</div>
            {item!.dict?.phonetic && item!.dict.phonetic.toLowerCase() !== item!.word.toLowerCase() && (
              <p className="mt-3 num text-sm t3">/{item!.dict.phonetic}/</p>
            )}
            <div className="mt-6 text-base space-y-0.5">
              <Translation text={item!.dict?.translation ?? "（词典里没有这条）"} />
            </div>
            {item!.dict?.definition && (
              <p className="mt-4 text-sm t3 italic leading-relaxed line-clamp-3">
                {item!.dict.definition.replace(/\\n/g, "; ")}
              </p>
            )}
            {item!.sourceContext && (
              <blockquote className="mt-5 border-l-2 border-[var(--accent-dim)] pl-4 text-left text-sm t3 italic">
                {item!.sourceContext}
              </blockquote>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                speak(item!.word);
              }}
              className="mt-5 t3 hover:text-[var(--text)] transition-colors inline-flex"
            >
              <Icon name="speaker" size={15} />
            </button>
          </div>
        )}
      </div>

      {/* 评分区 / 提交区 */}
      <div className="pb-9 px-6">
        {typing && phase === "ask" ? (
          <div className="mx-auto max-w-xs">
            <button
              onClick={submitTyping}
              disabled={!answer.trim()}
              className="btn-ink w-full rounded-md px-2 py-3 text-sm disabled:opacity-40"
            >
              提交
              <span className="opacity-50 text-xs ml-2 num">Enter</span>
            </button>
          </div>
        ) : isLast && phase === "right" && autoGrade.current !== null ? (
          <div className="mx-auto max-w-xs">
            <button
              onClick={() => autoGrade.current !== null && void grade(autoGrade.current)}
              className="btn-ink w-full rounded-md px-2 py-3 text-sm"
            >
              继续 · 评「{GRADE_LABEL[autoGrade.current]}」
              <span className="opacity-50 text-xs ml-2 num">空格 / Enter</span>
            </button>
          </div>
        ) : revealed && !isLast ? (
          <div className="mx-auto max-w-md w-full grid grid-cols-2 gap-2">
            <button
              onClick={prevMode}
              disabled={!seqState || seqState.pos === 0}
              className="rounded-md px-2 py-3 text-sm t3 border border-[var(--border)] hover:text-[var(--text)] hover:border-[var(--t3)] disabled:opacity-30 transition-colors"
            >
              上一个
            </button>
            <button
              onClick={advanceMode}
              className="btn-ink rounded-md px-2 py-3 text-sm"
            >
              下一个
              <span className="opacity-50 text-xs ml-2 num">空格 / Enter</span>
            </button>
          </div>
        ) : revealed && intervals ? (
          <div className="mx-auto max-w-xl grid grid-cols-4 gap-2 animate-fade-in">
            {GRADE_ORDER.map((g, i) => {
              if (phase === "wrong" && g === Rating.Easy) return null;
              return (
                <button
                  key={g}
                  onClick={() => void grade(g)}
                  className="rounded-md px-2 py-3 transition-colors hover:bg-[var(--hover)] active:scale-[0.97]"
                >
                  <span className="flex items-baseline justify-center gap-2">
                    <span className="num text-xs t4">{i + 1}</span>
                    <span className="t1 text-sm">{GRADE_LABEL[g]}</span>
                  </span>
                  <span className="block num text-[11px] t4 mt-1.5">
                    {intervals.find((o) => o.grade === g)?.text}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          promptWord && !typing && <p className="text-center text-xs t4">回忆之后作答</p>
        )}
        {bug && <p className="mt-3 text-center text-xs text-rose-400 break-all">{bug}</p>}
      </div>
    </div>
  );
}
