import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rating, type Grade, type RecordLogItem } from "ts-fsrs";
import {
  applyReview,
  getCurrentDeck,
  getQueue,
  getSetting,
  type QueueItem,
} from "../lib/db";
import { GRADE_META, GRADES, previewOptions, speak, stateLabel } from "../lib/fsrs";

// ECDICT 的 translation 用字面 "\n" 分隔多条释义
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

type ExMode = "self" | "mix" | "dictation";
type DictPhase = "prompt" | "right" | "wrong";

/** 默写只对学过的词出现（新词连面都没见过，默不出来） */
function decideDictation(mode: ExMode, item: QueueItem): boolean {
  if (mode === "self" || item.isNew || item.card.reps === 0) return false;
  if (mode === "dictation") return true;
  return Math.random() < 0.45;
}

const norm = (s: string) => s.trim().toLowerCase();

export default function Review({ onExit }: { onExit: () => void }) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [options, setOptions] = useState<{ grade: Grade; text: string }[] | null>(null);
  const [answered, setAnswered] = useState(0);
  const [bug, setBug] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [exMode, setExMode] = useState<ExMode>("self");
  const [answer, setAnswer] = useState("");
  const [dictPhase, setDictPhase] = useState<DictPhase>("prompt");
  const autoSpeak = useRef(false);
  const schedulingRef = useRef<Record<Grade, RecordLogItem> | null>(null);
  const autoGradeRef = useRef<Grade | null>(null);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      try {
        const [deck, mode, ap] = await Promise.all([
          getCurrentDeck(),
          getSetting("exercise_mode"),
          getSetting("auto_pronounce"),
        ]);
        setExMode(mode === "mix" || mode === "dictation" ? mode : "self");
        autoSpeak.current = ap !== "off";
        const q = await getQueue(deck);
        setQueue(q);
      } catch (e) {
        setLoadErr(String(e));
      }
    })();
  }, []);

  const item = queue?.[idx];
  const dictating = useMemo(
    () => (item ? decideDictation(exMode, item) : false),
    [item, exMode],
  );

  const flip = useCallback(() => {
    if (!item) return;
    const { options: opts, scheduling } = previewOptions(item.card);
    schedulingRef.current = scheduling;
    autoGradeRef.current = null;
    setOptions(opts);
    setFlipped(true);
    if (autoSpeak.current) speak(item.word);
  }, [item]);

  const rate = useCallback(
    async (grade: Grade, presched?: RecordLogItem) => {
      if (!item || !flipped) return;
      const sched = presched ?? schedulingRef.current?.[grade];
      if (!sched) return;
      try {
        const duration = Date.now() - shownAt.current;
        await applyReview(item, grade, sched, duration);
      } catch (e) {
        setBug(String(e));
        return;
      }
      setAnswered((n) => n + 1);
      if (idx + 1 >= queue!.length) {
        setQueue([]);
      } else {
        setIdx(idx + 1);
        setFlipped(false);
        setOptions(null);
        setAnswer("");
        setDictPhase("prompt");
        shownAt.current = Date.now();
      }
    },
    [item, flipped, idx, queue],
  );

  // 默写提交
  const submitDictation = useCallback(() => {
    if (!item || dictPhase !== "prompt") return;
    const { options: opts, scheduling } = previewOptions(item.card);
    schedulingRef.current = scheduling;
    setOptions(opts);
    setFlipped(true);
    if (autoSpeak.current) speak(item.word);
    if (norm(answer) === norm(item.word)) {
      setDictPhase("right");
      autoGradeRef.current = Rating.Good;
    } else {
      setDictPhase("wrong");
      autoGradeRef.current = null;
    }
  }, [item, dictPhase, answer]);

  // 键盘
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!item) return;
      if (e.key === "Escape") {
        onExit();
        return;
      }
      // 默写正面：Enter 提交
      if (dictating && dictPhase === "prompt") {
        if (e.key === "Enter") {
          e.preventDefault();
          submitDictation();
        }
        return;
      }
      // 默写答对：Enter 继续（按预评的良好）
      if (dictating && dictPhase === "right" && autoGradeRef.current !== null) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void rate(autoGradeRef.current);
        }
        return;
      }
      // 翻面态：1-4 评分
      if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        void rate(GRADES[Number(e.key) - 1]);
        return;
      }
      // 正面：空格翻面
      if (e.key === " " && !flipped) {
        e.preventDefault();
        flip();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [item, flipped, dictating, dictPhase, flip, rate, submitDictation, onExit]);

  if (queue === null) {
    return (
      <div className="min-h-screen flex items-center justify-center t3">
        {loadErr ?? "载入中…"}
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6">
        <div className="text-7xl">🎉</div>
        <p className="text-xl t1">今日完成</p>
        {answered > 0 && <p className="t3">本轮复习了 {answered} 张卡</p>}
        <button
          onClick={onExit}
          className="rounded-full border border-[var(--border)] px-8 py-3 t2 hover:border-[var(--accent)] accent-text transition-colors"
        >
          回首页
        </button>
      </div>
    );
  }

  const dictDone = dictating && dictPhase !== "prompt";
  void dictDone;

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶栏：退出 + 进度 */}
      <div className="flex items-center px-6 pt-12 text-sm t3">
        <button onClick={onExit} className="link-strong">✕</button>
        <span className="mx-auto tabular-nums t2">
          {idx + 1} / {queue.length}
        </span>
        <span className="t3">
          {item!.isNew ? "新词" : stateLabel(item!.card.state)}
          {item!.deck !== "生词本" && <span className="t4"> · {item!.deck}</span>}
        </span>
      </div>

      {/* 卡片 */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-8 select-none"
        onClick={() => !flipped && !dictating && flip()}
      >
        {/* 正面 */}
        {!flipped ? (
          dictating ? (
            <div key={item!.id} className="text-center w-full max-w-xl animate-card-in">
              <p className="text-xs t4 tracking-widest">默写 · 写出对应的英文单词</p>
              <div className="mt-6 text-xl t1 leading-relaxed">
                <Translation
                  text={item!.dict?.translation ?? item!.word + "（词典缺释义）"}
                />
              </div>
              {item!.dict?.definition && (
                <p className="mt-3 text-sm t3 italic">{item!.dict.definition.split("\\n")[0]}</p>
              )}
              <input
                autoFocus
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitDictation();
                  }
                }}
                placeholder="输入英文后回车"
                spellCheck={false}
                autoComplete="off"
                className="mt-8 w-72 mx-auto field rounded-2xl px-5 py-3 text-lg text-center outline-none
                           placeholder:text-[var(--t4)] focus:border-[var(--accent)] transition-colors t1"
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  speak(item!.word);
                }}
                className="mt-5 text-[var(--t3)] hover:text-[var(--accent)] transition-colors"
                title="听发音提示"
              >
                🔊
              </button>
              <p className="mt-4 text-xs t4">回车提交 · 发音可作提示</p>
            </div>
          ) : (
            <div key={item!.id} className="text-center cursor-pointer animate-card-in" onClick={() => flip()}>
              <div className="text-6xl font-light t1">{item!.word}</div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  speak(item!.word);
                }}
                className="mt-6 t3 hover:text-[var(--accent)] transition-colors"
                title="发音"
              >
                🔊
              </button>
              <p className="mt-16 text-xs t4 animate-pulse">空格 / 点击 翻面</p>
            </div>
          )
        ) : (
          /* 背面 */
          <div key={`b${item!.id}`} className="text-center max-w-xl w-full animate-card-in">
            {dictating && dictPhase === "right" && (
              <p className="mb-4 accent-text text-sm">✓ 拼写正确</p>
            )}
            {dictating && dictPhase === "wrong" && (
              <p className="mb-4 text-rose-400 text-sm">
                ✗ 你写的是「{answer.trim() || "（空）"}」—— 正确答案：
              </p>
            )}
            <div className="text-4xl font-light t1">{item!.word}</div>
            {item!.dict?.phonetic && (
              <p className="mt-2 accent-text opacity-80">/{item!.dict.phonetic}/</p>
            )}
            <div className="mt-6 text-[var(--text)] text-base space-y-0.5">
              <Translation text={item!.dict?.translation ?? "（词典里没有这条）"} />
            </div>
            {item!.dict?.definition && (
              <p className="mt-3 text-sm t3 italic leading-relaxed line-clamp-3">
                {item!.dict.definition.replace(/\\n/g, "; ")}
              </p>
            )}
            {item!.sourceContext && (
              <blockquote className="mt-5 border-l-2 border-teal-800 pl-4 text-left text-sm t3 italic">
                {item!.sourceContext}
              </blockquote>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                speak(item!.word);
              }}
              className="mt-4 t3 hover:text-[var(--accent)] transition-colors"
            >
              🔊
            </button>
          </div>
        )}
      </div>

      {/* 评分区 */}
      <div className="pb-10 px-6">
        {dictating && dictPhase === "prompt" ? (
          <p className="text-center text-xs t4 select-none">在上方输入框拼写，回车提交</p>
        ) : dictating && dictPhase === "right" && autoGradeRef.current !== null ? (
          <div className="mx-auto max-w-xs">
            <button
              onClick={() => autoGradeRef.current !== null && void rate(autoGradeRef.current)}
              className="w-full rounded-2xl border border-teal-900 bg-teal-950/40 accent-text px-2 py-3 transition-colors hover:bg-teal-900/40"
            >
              继续 <span className="opacity-50 text-xs">（Enter · 自动评：良好）</span>
            </button>
          </div>
        ) : flipped && options ? (
          <div className="mx-auto max-w-xl grid grid-cols-4 gap-3">
            {options.map((o) => {
              const m = GRADE_META[o.grade];
              const wrongHideEasy = dictating && dictPhase === "wrong" && o.grade === Rating.Easy;
              if (wrongHideEasy) return null;
              return (
                <button
                  key={o.grade}
                  onClick={() => void rate(o.grade)}
                  className={`rounded-2xl border px-2 py-3 transition-colors ${m.cls}`}
                >
                  <span className="opacity-50 text-xs mr-1">{m.key}</span>
                  {m.label}
                  <span className="block text-xs opacity-60 mt-1 tabular-nums">{o.text}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-center text-xs t4 select-none">
            {dictating ? "默写完成，选一个评分" : "先回忆意思，再翻面对答案"}
          </p>
        )}
        {bug && <p className="mt-4 text-center text-xs text-rose-400 px-8 break-all">{bug}</p>}
      </div>
    </div>
  );
}
