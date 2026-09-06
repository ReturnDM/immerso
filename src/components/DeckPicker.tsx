import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

/** 左下角词书切换：自绘弹层，向上展开，hairline 列表 + 当前项水色高亮 */
export default function DeckPicker({
  options,
  value,
  onChange,
}: {
  options: { name: string; total?: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="field px-1 py-1 text-xs t2 inline-flex items-center gap-1.5
                   hover:text-[var(--text)] transition-colors cursor-pointer"
        title="学习词库"
      >
        {value}
        <Icon
          name="chevron"
          size={11}
          className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          className="absolute bottom-full mb-2 left-0 z-50 min-w-36 rounded-lg border border-[var(--border)]
                     bg-[var(--bg)] py-1 shadow-[0_8px_28px_rgba(0,0,0,0.16)] animate-view-in"
        >
          {options.map((d) => (
            <button
              key={d.name}
              onClick={() => {
                onChange(d.name);
                setOpen(false);
              }}
              className={`w-full text-left pl-3 pr-3 py-1.5 text-xs flex items-center gap-3
                          transition-colors hover:bg-[var(--hover)] ${
                            d.name === value ? "accent-text" : "t2"
                          }`}
            >
              {d.name}
              {d.total !== undefined && (
                <span className="num text-[10px] t4 ml-auto">{d.total}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
