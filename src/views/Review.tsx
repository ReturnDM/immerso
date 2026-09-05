import { useCallback, useEffect, useRef, useState } from "react";
import type { Grade, RecordLogItem } from "ts-fsrs";
import { applyReview, getQueue, getSetting, type QueueItem } from "../lib/db";
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

export default function Review({ onExit }: { onExit: () => void }) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [options, setOptions] = useState<{ grade: Grade; text: string }[] | null>(null);
  const [answered, setAnswered] = useState(0);
  const [bug, setBug] = useState<string | null>(null);
  const autoSpeak = useRef(false);
  const schedulingRef = useRef<Record<Grade, RecordLogItem> | null>(null);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    getQueue().then(setQueue).catch(console.error);
    getSetting("auto_pronounce").then((v) => (autoSpeak.current = v !== "off"));
  }, []);

  const item = queue?.[idx];

  const flip = useCallback(() => {
    if (!item) return;
    const { options: opts, scheduling } = previewOptions(item.card);
    schedulingRef.current = scheduling;
    setOptions(opts);
    setFlipped(true);
    if (autoSpeak.current) speak(item.word);
  }, [item]);

  const rate = useCallback(
    async (grade: Grade) => {
      if (!item || !flipped || !schedulingRef.current) return;
      try {
        const duration = Date.now() - shownAt.current;
        await applyReview(item, grade, schedulingRef.current[grade], duration);
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
        shownAt.current = Date.now();
      }
    },
    [item, flipped, idx, queue],
  );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!item) return;
      if (e.key === " " && !flipped) {
        e.preventDefault();
        flip();
      } else if (e.key === "Escape") {
        onExit();
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        rate(GRADES[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [item, flipped, flip, rate, onExit]);

  if (queue === null) {
    return <div className="min-h-screen flex items-center justify-center text-zinc-500">载入中…</div>;
  }

  if (queue.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6">
        <div className="text-7xl">🎉</div>
        <p className="text-xl text-zinc-200">今日完成</p>
        {answered > 0 && <p className="text-zinc-500">本轮复习了 {answered} 张卡</p>}
        <button
          onClick={onExit}
          className="rounded-full border border-zinc-700 px-8 py-3 text-zinc-300 hover:border-teal-700 hover:text-teal-400 transition-colors"
        >
          回首页
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶栏：退出 + 进度 */}
      <div className="flex items-center px-6 pt-12 text-sm text-zinc-500">
        <button onClick={onExit} className="hover:text-zinc-200 transition-colors">
          ✕
        </button>
        <span className="mx-auto tabular-nums text-zinc-400">
          {idx + 1} / {queue.length}
        </span>
        <span className={item!.isNew ? "text-teal-500" : "text-zinc-500"}>
          {stateLabel(item!.card.state)}
        </span>
      </div>

      {/* 卡片 */}
      <div
        className="flex-1 flex flex-col items-center justify-center px-8 cursor-pointer select-none"
        onClick={() => !flipped && flip()}
      >
        {!flipped ? (
          <div key={item!.id} className="text-center animate-card-in">
            <div className="text-6xl font-light">{item!.word}</div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                speak(item!.word);
              }}
              className="mt-6 text-zinc-600 hover:text-teal-400 transition-colors"
              title="发音"
            >
              🔊
            </button>
            <p className="mt-16 text-xs text-zinc-600 animate-pulse">空格 / 点击 翻面</p>
          </div>
        ) : (
          <div key={item!.id} className="text-center max-w-xl w-full animate-card-in">
            <div className="text-4xl font-light">{item!.word}</div>
            {item!.dict?.phonetic && (
              <p className="mt-2 text-teal-400/80">/{item!.dict.phonetic}/</p>
            )}
            <div className="mt-6 text-zinc-200 text-base space-y-0.5">
              <Translation text={item!.dict?.translation ?? "（词典里没有这条）"} />
            </div>
            {item!.dict?.definition && (
              <p className="mt-3 text-sm text-zinc-500 italic leading-relaxed line-clamp-3">
                {item!.dict.definition.replace(/\\n/g, "; ")}
              </p>
            )}
            {item!.sourceContext && (
              <blockquote className="mt-5 border-l-2 border-teal-800 pl-4 text-left text-sm text-zinc-400 italic">
                {item!.sourceContext}
              </blockquote>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                speak(item!.word);
              }}
              className="mt-4 text-zinc-600 hover:text-teal-400 transition-colors"
            >
              🔊
            </button>
          </div>
        )}
      </div>

      {/* 评分区 */}
      <div className="pb-10 px-6">
        {flipped && options ? (
          <div className="mx-auto max-w-xl grid grid-cols-4 gap-3">
            {options.map((o) => {
              const m = GRADE_META[o.grade];
              return (
                <button
                  key={o.grade}
                  onClick={() => rate(o.grade)}
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
          <p className="text-center text-xs text-zinc-700 select-none">
            先回忆意思，再翻面对答案
          </p>
        )}
        {bug && <p className="mt-4 text-center text-xs text-rose-400 px-8 break-all">{bug}</p>}
      </div>
    </div>
  );
}
