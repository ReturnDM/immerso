import { useEffect, useState } from "react";
import { getDailyNew, getSetting, setSetting } from "../lib/db";
import { lastSyncText, neathSync } from "../lib/neath";
import { changeTheme, currentTheme, type Theme } from "../lib/theme";

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-[var(--border)] p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-3 py-1 rounded-full text-xs transition-colors ${
            value === o.v ? "bg-teal-700 text-white" : "t3 hover:text-[var(--text)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Settings({ onBack }: { onBack: () => void }) {
  const [quota, setQuota] = useState("10");
  const [saved, setSaved] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const [exMode, setExMode] = useState<"self" | "mix" | "dictation">("self");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    getDailyNew().then((v) => setQuota(String(v)));
    getSetting("auto_pronounce").then((v) => setAutoSpeak(v !== "off"));
    getSetting("exercise_mode").then((v) => {
      if (v === "mix" || v === "dictation") setExMode(v);
    });
    lastSyncText().then(setLastSync);
  }, []);

  const saveQuota = async () => {
    const v = Number(quota);
    if (!Number.isFinite(v) || v < 1) return;
    await setSetting("daily_new", String(Math.floor(v)));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const saveExMode = (v: "self" | "mix" | "dictation") => {
    setExMode(v);
    void setSetting("exercise_mode", v);
  };

  const sync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await neathSync();
      setSyncMsg(`✓ 新收 ${r.added} 词 · 已在词库跳过 ${r.existing} 词`);
      setLastSync(await lastSyncText());
    } catch (e) {
      setSyncMsg(`✗ ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-12 pb-10">
      <div className="w-full max-w-xl flex items-center">
        <button onClick={onBack} className="link-strong text-sm">← 首页</button>
        <span className="mx-auto text-sm tracking-widest t2 select-none">设 置</span>
        <span className="w-10" />
      </div>

      <div className="mt-10 w-full max-w-xl flex flex-col gap-4">
        {/* 外观 */}
        <div className="surface rounded-2xl px-5 py-4 flex items-center">
          <div>
            <p className="t1">外观</p>
            <p className="mt-1 text-xs t3">深色沉浸 / 浅色护眼，立即生效</p>
          </div>
          <div className="ml-auto">
            <Segmented
              value={theme}
              options={[
                { v: "dark" as Theme, label: "🌙 深色" },
                { v: "light" as Theme, label: "☀️ 浅色" },
              ]}
              onChange={(v) => {
                setTheme(v);
                changeTheme(v);
              }}
            />
          </div>
        </div>

        {/* 练习模式 */}
        <div className="surface rounded-2xl px-5 py-4">
          <p className="t1">练习模式</p>
          <p className="mt-1 text-xs t3">
            卡片自评 = 翻面对答案；默写 = 看释义拼单词，自动判分（只对学过的词出现）
          </p>
          <div className="mt-3">
            <Segmented
              value={exMode}
              options={[
                { v: "self" as const, label: "卡片自评" },
                { v: "mix" as const, label: "混合" },
                { v: "dictation" as const, label: "全默写" },
              ]}
              onChange={saveExMode}
            />
          </div>
        </div>

        {/* 每日新词量 */}
        <div className="surface rounded-2xl px-5 py-4">
          <p className="t1">每日新词量</p>
          <p className="mt-1 text-xs t3">每天最多引入多少张新卡；到期的复习卡不受限制</p>
          <div className="mt-3 flex items-center gap-3">
            <input
              value={quota}
              onChange={(e) => setQuota(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={(e) => {
                if (!e.target.value || Number(e.target.value) < 1) setQuota("10");
              }}
              inputMode="numeric"
              className="w-24 field rounded-xl px-4 py-2 text-lg outline-none focus:border-[var(--accent)] transition-colors tabular-nums t1"
            />
            <button
              onClick={saveQuota}
              className={`text-xs border rounded-full px-4 py-1.5 transition-colors ${
                saved
                  ? "border-teal-900 text-teal-500"
                  : "border-[var(--border)] t3 hover:border-[var(--accent)] accent-text"
              }`}
            >
              {saved ? "✓ 已保存" : "保存"}
            </button>
          </div>
        </div>

        {/* 复习体验 */}
        <div className="surface rounded-2xl px-5 py-4 flex items-center">
          <div>
            <p className="t1">翻面自动发音</p>
            <p className="mt-1 text-xs t3">复习卡翻到背面时自动朗读单词（系统 TTS）</p>
          </div>
          <button
            onClick={() => {
              const next = !autoSpeak;
              setAutoSpeak(next);
              void setSetting("auto_pronounce", next ? "on" : "off");
            }}
            className={`ml-auto relative w-11 h-6 rounded-full transition-colors ${
              autoSpeak ? "bg-teal-700" : "bg-[var(--border)]"
            }`}
            title={autoSpeak ? "开" : "关"}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-zinc-200 transition-all ${
                autoSpeak ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        </div>

        {/* 匿词同步 */}
        <div className="surface rounded-2xl px-5 py-4">
          <p className="t1">匿词收词同步</p>
          <p className="mt-1 text-xs t3">
            只读拉取匿词的词灵收藏与默认本，新词带原句流入「生词本」；Key 在 ~/.neath-api-key
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={sync}
              disabled={syncing}
              className="text-xs border border-[var(--border)] rounded-full px-4 py-1.5 t3
                         hover:border-[var(--accent)] accent-text transition-colors
                         disabled:opacity-40 disabled:cursor-wait"
            >
              {syncing ? "同步中…" : "立即同步"}
            </button>
            {lastSync && <span className="text-xs t4">上次同步 {lastSync}</span>}
          </div>
          {syncMsg && <p className="mt-3 text-xs t2 break-all">{syncMsg}</p>}
        </div>

        {/* 关于 */}
        <div className="surface rounded-2xl px-5 py-4">
          <p className="t1">浸词 immerso</p>
          <p className="mt-1 text-xs t3 leading-relaxed">
            词典 ECDICT（77 万词条）· 调度 FSRS-5（ts-fsrs）· 数据
            %APPDATA%\com.returndm.immerso（备份即复制 immerso.db）
          </p>
        </div>
      </div>
    </div>
  );
}
