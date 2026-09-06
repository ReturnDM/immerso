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
import { pickMode, type ExMode } from "../lib/exercises";
import { Icon } from "../components/Icon";

// ECDICT 的 translation 用字面 "\n" 分隔多条释义
function firstLine(t: string | undefined): string {
  return (t ?? "").split("\\n")[0] || "（无释义）";
}
function Translation({ text }: { text: string }) {
  return (
    <>
      {text.split("\\n").map((line, i) => (
        <p key={i} className="m-0 leading-relaxed">
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
const GRADE_VAR: Record<number, string> = {
  [Rating.Again]: "var(--key-again)",
  [Rating.Hard]: "var(--key-hard)",
  [Rating.Good]: "var(--key-good)",
  [Rating.Easy]: "var(--key-easy)",
};

const norm = (s: string) => s.trim().toLowerCase();
const shuffle = <T,>(a: T[]): T[] =>
  a.map((v) => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map(([, v]) => v);

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
  const [answered, setAnswered] = useState(0);
  const [bug, setBug] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [phase, setPhase] = useState<"ask" | "right" | "wrong">("ask");
  const [pick, setPick] = useState<number | null>(null);
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
        setQueue(await getQueue(deck));
      } catch (e) {
        setLoadErr(String(e));
      }
    })();
  }, []);

  const item = queue?.[idx];
  const mode: ExMode = useMemo(() => {
    if (!item || !modes) return "self";
    return pickMode(modes, item.isNew, item.card.reps);
  }, [item, modes]);

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
  const typing = effMode === "dictation" || effMode === "listen";

  // 听音拼写：出题即朗读
  useEffect(() => {
    if (item && effMode === "listen" && phase === "ask") speak(item.word);
  }, [item, effMode, phase]);

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
      setAnswered((n) => n + 1);
      if (idx + 1 >= queue!.length) setQueue([]);
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

  // 键盘
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!item) return;
      if (e.key === "Escape") return onExit();
      if (typing && phase === "ask") return; // 输入框自己处理回车
      if (phase === "right" && autoGrade.current !== null) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void grade(autoGrade.current);
        }
        return;
      }
      // 翻面/作答后的评分：数字键；self 模式 Enter = 良好
      if (revealed) {
        if (["1", "2", "3", "4"].includes(e.key)) {
          const g = GRADE_ORDER[Number(e.key) - 1];
          if (phase === "wrong" && g === Rating.Easy) return;
          e.preventDefault();
          void grade(g);
          return;
        }
        if (phase === "ask" && effMode === "self" && e.key === "Enter") {
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
      if (e.key === " " && !revealed) {
        e.preventDefault();
        flip();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [item, revealed, phase, typing, mode, choice, flip, grade, pickChoice, onExit]);

  if (queue === null || modes === null) {
    return (
      <div className="min-h-screen flex items-center justify-center t3">
        {loadErr ?? "载入中…"}
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5">
        <Icon name="check" size={44} className="accent-text" />
        <p className="text-xl t1">今日完成</p>
        {answered > 0 && <p className="t3 text-sm">本轮 {answered} 张</p>}
        <button onClick={onExit} className="mt-2 border border-[var(--border)] rounded-lg px-6 py-2.5 t2 text-sm hover:border-[var(--accent)] accent-text transition-colors">
          回首页
        </button>
        <DoneSync />
      </div>
    );
  }

  const progress = answered / queue.length;
  const promptWord = effMode === "choice_en" || effMode === "self";

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶栏 + 水线（本轮进度） */}
      <div className="pt-10">
        <div className="flex items-center px-6 text-sm t3">
          <button onClick={onExit} className="link-strong" title="退出">
            <Icon name="close" size={16} />
          </button>
          <span className="mx-auto tabular-nums t2 text-[13px]">
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
      </div>

      {/* 出题区 */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 select-none">
        {!revealed ? (
          effMode === "self" ? (
            <div
              key={item!.id}
              className="text-center cursor-pointer animate-card-in w-full"
              onClick={flip}
            >
              <div className="word-serif text-6xl t1 tracking-wide">{item!.word}</div>
              {item!.dict?.phonetic && (
                <p className="mt-3 accent-text opacity-70 text-sm">/{item!.dict.phonetic}/</p>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  speak(item!.word);
                }}
                className="mt-5 t3 hover:text-[var(--accent)] transition-colors inline-flex"
                title="发音"
              >
                <Icon name="speaker" />
              </button>
              <p className="mt-14 text-xs t4 animate-pulse">空格 翻面</p>
            </div>
          ) : typing ? (
            <div key={item!.id} className="text-center w-full max-w-xl animate-card-in">
              <p className="text-xs t4 tracking-[0.3em]">
                {effMode === "listen" ? "听 写" : "默 写"}
              </p>
              {effMode === "dictation" && (
                <div className="mt-6 text-lg t1 leading-relaxed">
                  <Translation text={item!.dict?.translation ?? "（词典缺释义）"} />
                </div>
              )}
              {effMode === "listen" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    speak(item!.word);
                  }}
                  className="mt-4 t2 hover:text-[var(--accent)] transition-colors inline-flex mx-auto"
                  title="重听"
                >
                  <Icon name="speaker" size={30} />
                </button>
              )}
              {effMode === "dictation" && item!.dict?.definition && (
                <p className="mt-3 text-sm t3 italic">{item!.dict.definition.split("\\n")[0]}</p>
              )}
              <input
                autoFocus
                key={item!.id}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitTyping();
                  }
                }}
                placeholder="输入英文后回车"
                spellCheck={false}
                autoComplete="off"
                className="mt-8 w-72 field rounded-lg px-5 py-3 text-lg text-center outline-none
                           placeholder:text-[var(--t4)] focus:border-[var(--accent)] transition-colors t1"
              />
              <p className="mt-4 text-xs t4">
                {effMode === "listen" ? "回车提交 · 可点喇叭重听" : "回车提交"}
              </p>
            </div>
          ) : (
            <div key={item!.id} className="text-center w-full max-w-lg animate-card-in">
              {effMode === "choice_en" ? (
                <>
                  <div className="word-serif text-5xl t1">{item!.word}</div>
                  {item!.dict?.phonetic && (
                    <p className="mt-2 accent-text opacity-70 text-sm">/{item!.dict.phonetic}/</p>
                  )}
                </>
              ) : (
                <div className="text-xl t1 leading-relaxed">
                  <Translation text={item!.dict?.translation ?? "（词典缺释义）"} />
                </div>
              )}
              <div className="mt-10 flex flex-col gap-2">
                {choice!.opts.map((opt, i) => {
                  const isCorrect = opt === choice!.correct;
                  const picked = pick === i;
                  const cls =
                    phase === "ask"
                      ? "border-[var(--border)] hover:border-[var(--accent)]"
                      : isCorrect
                        ? "border-[var(--accent)] accent-text"
                        : picked
                          ? "border-red-900 text-red-400"
                          : "border-[var(--border)] t4";
                  return (
                    <button
                      key={i}
                      onClick={() => pickChoice(i)}
                      disabled={phase !== "ask"}
                      className={`w-full text-left border rounded-lg px-4 py-3 transition-colors flex items-center gap-3 ${cls}`}
                    >
                      <span className="keycap t3">{i + 1}</span>
                      <span className={effMode === "choice_zh" ? "word-serif text-lg" : "text-sm t2"}>
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
          <div key={`r${item!.id}`} className="text-center max-w-xl w-full animate-card-in">
            {phase === "right" && typing && <p className="mb-3 accent-text text-sm">✓ 正确</p>}
            {phase === "right" && (effMode === "choice_en" || effMode === "choice_zh") && (
              <p className="mb-3 accent-text text-sm">✓ 答对了</p>
            )}
            {phase === "wrong" && typing && (
              <p className="mb-3 text-rose-400 text-sm">
                ✗ 你写的是「{answer.trim() || "（空）"}」
              </p>
            )}
            {phase === "wrong" && (effMode === "choice_en" || effMode === "choice_zh") && (
              <p className="mb-3 text-rose-400 text-sm">✗ 答错了，正确答案高亮如下</p>
            )}
            <div className="word-serif text-4xl t1">{item!.word}</div>
            {item!.dict?.phonetic && (
              <p className="mt-2 accent-text opacity-80 text-sm">/{item!.dict.phonetic}/</p>
            )}
            <div className="mt-5 text-base space-y-0.5">
              <Translation text={item!.dict?.translation ?? "（词典里没有这条）"} />
            </div>
            {item!.dict?.definition && (
              <p className="mt-3 text-sm t3 italic leading-relaxed line-clamp-3">
                {item!.dict.definition.replace(/\\n/g, "; ")}
              </p>
            )}
            {item!.sourceContext && (
              <blockquote className="mt-4 border-l-2 border-[var(--accent-dim)] pl-4 text-left text-sm t3 italic">
                {item!.sourceContext}
              </blockquote>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                speak(item!.word);
              }}
              className="mt-4 t3 hover:text-[var(--accent)] transition-colors inline-flex"
            >
              <Icon name="speaker" />
            </button>
          </div>
        )}
      </div>

      {/* 评分区 / 提交区 */}
      <div className="pb-9 px-6">
        {typing && phase === "ask" ? (
          <p className="text-center text-xs t4">
            在上方输入拼写，回车提交
          </p>
        ) : phase === "right" && autoGrade.current !== null ? (
          <div className="mx-auto max-w-xs">
            <button
              onClick={() => autoGrade.current !== null && void grade(autoGrade.current)}
              className="w-full rounded-lg border border-[var(--accent-dim)] accent-text px-2 py-2.5 text-sm transition-colors hover:bg-[var(--hover)]"
            >
              继续 · 评「{GRADE_LABEL[autoGrade.current]}」
              <span className="t4 text-xs ml-1">Enter</span>
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
                  className="rounded-lg border border-transparent hover:border-[var(--border)] hover:bg-[var(--hover)] px-2 py-3 transition-colors"
                >
                  <span className="flex items-center justify-center gap-2">
                    <span className="keycap" style={{ color: GRADE_VAR[g] }}>
                      {i + 1}
                    </span>
                    <span className="t2 text-sm">{GRADE_LABEL[g]}</span>
                  </span>
                  <span className="block text-[11px] t4 mt-1.5 tabular-nums">
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
