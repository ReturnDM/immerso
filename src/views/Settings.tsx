import { useEffect, useState } from "react";
import {
  getDailyNew,
  getEnabledModes,
  getSetting,
  setEnabledModes,
  setSetting,
} from "../lib/db";
import { EX_MODES, type ExMode } from "../lib/exercises";
import { lastSyncText, neathSync } from "../lib/neath";
import { changeTheme, currentTheme, type Theme } from "../lib/theme";
import { Icon } from "../components/Icon";

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
    <div className="inline-flex rounded-lg border border-[var(--border)] p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-3 py-1 rounded-md text-xs transition-colors ${
            value === o.v ? "bg-teal-700 text-white" : "t3 hover:text-[var(--text)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Check({
  on,
  onChange,
  label,
  desc,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc: string;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="w-full flex items-start gap-3 text-left py-2 group"
    >
      <span
        className={`mt-0.5 w-4 h-4 rounded border flex-none inline-flex items-center justify-center transition-colors ${
          on ? "border-teal-700 bg-teal-700 text-white" : "border-[var(--border)] group-hover:border-[var(--accent)]"
        }`}
      >
        {on && <Icon name="check" size={11} strokeWidth={3} />}
      </span>
      <span>
        <span className={`text-sm ${on ? "t1" : "t2"}`}>{label}</span>
        <span className="block text-xs t4 mt-0.5">{desc}</span>
      </span>
    </button>
  );
}

export default function Settings({ onBack }: { onBack: () => void }) {
  const [quota, setQuota] = useState("10");
  const [saved, setSaved] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const [modes, setModes] = useState<ExMode[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    getDailyNew().then((v) => setQuota(String(v)));
    getEnabledModes().then(setModes);
    getSetting("auto_pronounce").then((v) => setAutoSpeak(v !== "off"));
    lastSyncText().then(setLastSync);
  }, []);

  const toggleMode = (id: ExMode) => {
    if (!modes) return;
    const next = modes.includes(id) ? modes.filter((m) => m !== id) : [...modes, id];
    const final = next.length > 0 ? next : [id]; // 至少保留一项
    setModes(final);
    void setEnabledModes(final);
  };

  const saveQuota = async () => {
    const v = Number(quota);
    if (!Number.isFinite(v) || v < 1) return;
    await setSetting("daily_new", String(Math.floor(v)));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const sync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await neathSync();
      setSyncMsg(`✓ 新收 ${r.added} 词 · 跳过已在库 ${r.existing} 词`);
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
        <button onClick={onBack} className="link-strong text-sm inline-flex items-center gap-1.5">
          ← 首页
        </button>
        <span className="mx-auto text-sm tracking-[0.3em] t2 select-none">设置</span>
        <span className="w-10" />
      </div>

      <div className="mt-8 w-full max-w-xl flex flex-col gap-3">
        {/* 外观 */}
        <div className="surface rounded-xl px-5 py-4 flex items-center">
          <div>
            <p className="t1 text-sm">外观</p>
            <p className="mt-1 text-xs t3">深色墨潭 / 浅色宣纸</p>
          </div>
          <div className="ml-auto">
            <Segmented
              value={theme}
              options={[
                { v: "dark" as Theme, label: "深色" },
                { v: "light" as Theme, label: "浅色" },
              ]}
              onChange={(v) => {
                setTheme(v);
                changeTheme(v);
              }}
            />
          </div>
        </div>

        {/* 练习模式 */}
        <div className="surface rounded-xl px-5 py-4">
          <p className="t1 text-sm">练习方式</p>
          <p className="mt-1 text-xs t3">复习时从勾选的方式中随机出题</p>
          <div className="mt-2 divide-y divide-[var(--border)]">
            {EX_MODES.map((m) => (
              <Check
                key={m.id}
                on={modes?.includes(m.id) ?? false}
                onChange={() => toggleMode(m.id)}
                label={m.label}
                desc={m.desc}
              />
            ))}
          </div>
        </div>

        {/* 每日新词量 */}
        <div className="surface rounded-xl px-5 py-4">
          <p className="t1 text-sm">每日新词量</p>
          <p className="mt-1 text-xs t3">每天最多引入的新卡数，到期复习不受限</p>
          <div className="mt-3 flex items-center gap-3">
            <input
              value={quota}
              onChange={(e) => setQuota(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={(e) => {
                if (!e.target.value || Number(e.target.value) < 1) setQuota("10");
              }}
              inputMode="numeric"
              className="w-20 field rounded-lg px-3 py-1.5 text-base outline-none focus:border-[var(--accent)] transition-colors tabular-nums t1"
            />
            <button
              onClick={saveQuota}
              className={`text-xs rounded-md px-3 py-1.5 transition-colors ${
                saved ? "accent-text bg-[var(--accent-dim)]" : "t3 hover:text-[var(--text)] hover:bg-[var(--hover)]"
              }`}
            >
              {saved ? "已保存" : "保存"}
            </button>
          </div>
        </div>

        {/* 发音 */}
        <div className="surface rounded-xl px-5 py-4 flex items-center">
          <div>
            <p className="t1 text-sm">自动发音</p>
            <p className="mt-1 text-xs t3">揭示答案时朗读单词</p>
          </div>
          <button
            onClick={() => {
              const next = !autoSpeak;
              setAutoSpeak(next);
              void setSetting("auto_pronounce", next ? "on" : "off");
            }}
            className={`ml-auto relative w-10 h-[22px] rounded-full transition-colors ${
              autoSpeak ? "bg-teal-700" : "bg-[var(--border)]"
            }`}
          >
            <span
              className={`absolute top-[3px] w-4 h-4 rounded-full bg-zinc-200 transition-all ${
                autoSpeak ? "left-[21px]" : "left-[3px]"
              }`}
            />
          </button>
        </div>

        {/* 匿词同步 */}
        <div className="surface rounded-xl px-5 py-4">
          <p className="t1 text-sm">匿词同步</p>
          <p className="mt-1 text-xs t3">
            只读拉取匿词收藏，新词带原句流入「生词本」
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={sync}
              disabled={syncing}
              className="text-xs t3 border border-[var(--border)] rounded-md px-3 py-1.5
                         hover:border-[var(--accent)] accent-text transition-colors
                         disabled:opacity-40 disabled:cursor-wait"
            >
              {syncing ? "同步中…" : "立即同步"}
            </button>
            {lastSync && <span className="text-xs t4">上次 {lastSync}</span>}
          </div>
          {syncMsg && <p className="mt-3 text-xs t2 break-all">{syncMsg}</p>}
        </div>

        <p className="text-[11px] t4 text-center pt-1">
          词典 ECDICT · 调度 FSRS-5 · 数据 %APPDATA%\com.returndm.immerso
        </p>
      </div>
    </div>
  );
}
