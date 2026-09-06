import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MorphIcon } from "morphicons/react";
import { Sun, Moon } from "lucide";
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
import { exportData, importData } from "../lib/sync";
import { clearGhToken, cloudSync, getGhToken, lastCloudSyncText, saveGhToken } from "../lib/cloud";
import { Icon } from "../components/Icon";

/** 热键统一选项（macOS 上 Alt=⌥ Option，Ctrl=Control） */
const HOTKEY_OPTIONS: { v: string; label: string }[] = [
  { v: "alt+q", label: "Alt+Q" },
  { v: "alt+e", label: "Alt+E" },
  { v: "ctrl+shift+space", label: "Ctrl+⇧空格" },
  { v: "", label: "关闭" },
];

function Section({
  title,
  desc,
  children,
  first,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <section className={`${first ? "" : "border-t border-[var(--border)]"} py-5`}>
      <p className="t1 text-[13px]">{title}</p>
      {desc && <p className="mt-1 text-xs t3">{desc}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function OptionRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center py-2">
      <div className="min-w-0">
        <p className="t2 text-sm">{label}</p>
        {desc && <p className="mt-0.5 text-xs t4">{desc}</p>}
      </div>
      <div className="ml-auto flex-none pl-4">{children}</div>
    </div>
  );
}

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
    <div className="inline-flex gap-4 text-xs">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`pb-0.5 border-b transition-colors ${
            value === o.v
              ? "border-[var(--accent)] accent-text"
              : "border-transparent t3 hover:text-[var(--text)] hover:border-[var(--t4)]"
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
        className={`mt-0.5 w-3.5 h-3.5 rounded-[3px] border flex-none inline-flex items-center justify-center transition-colors ${
          on ? "border-[var(--accent)] accent-text" : "border-[var(--border)] group-hover:border-[var(--t3)]"
        }`}
      >
        {on && (
          <span className="animate-check-in inline-flex">
            <Icon name="check" size={10} strokeWidth={2.5} />
          </span>
        )}
      </span>
      <span>
        <span className={`text-sm ${on ? "t1" : "t2"}`}>{label}</span>
        <span className="block text-xs t4 mt-0.5">{desc}</span>
      </span>
    </button>
  );
}

function Switch({ on, onToggle, title }: { on: boolean; onToggle: () => void; title?: string }) {
  return (
    <button
      onClick={onToggle}
      title={title}
      className={`relative w-9 h-5 rounded-full transition-colors ${
        on ? "bg-[var(--ink)]" : "border border-[var(--border)] hover:border-[var(--t3)]"
      }`}
    >
      <span
        className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full transition-all ${
          on ? "left-[calc(100%-1.25rem)] bg-[var(--ink-text)]" : "left-1 bg-[var(--t3)]"
        }`}
      />
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
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const [ghToken, setGhToken] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [autoCloud, setAutoCloud] = useState(true);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudMsg, setCloudMsg] = useState<string | null>(null);
  const [lastCloud, setLastCloud] = useState<string | null>(null);
  const [hotkeyDirect, setHotkeyDirect] = useState("alt+q");
  const [hotkeyPopup, setHotkeyPopup] = useState("ctrl+shift+space");
  const [hotkeyMsg, setHotkeyMsg] = useState<string | null>(null);

  useEffect(() => {
    getDailyNew().then((v) => setQuota(String(v)));
    getEnabledModes().then(setModes);
    getSetting("auto_pronounce").then((v) => setAutoSpeak(v !== "off"));
    getSetting("auto_cloud_sync").then((v) => setAutoCloud(v !== "off"));
    getSetting("hotkey_direct").then((v) => setHotkeyDirect(v ?? "alt+q"));
    getSetting("hotkey_popup").then((v) => setHotkeyPopup(v ?? "ctrl+shift+space"));
    lastSyncText().then(setLastSync);
    lastCloudSyncText().then(setLastCloud);
    getGhToken().then(setGhToken);
  }, []);

  const changeHotkey = async (kind: "direct" | "popup", v: string) => {
    const nextDirect = kind === "direct" ? v : hotkeyDirect;
    const nextPopup = kind === "popup" ? v : hotkeyPopup;
    if (kind === "direct") setHotkeyDirect(v);
    else setHotkeyPopup(v);
    setHotkeyMsg(null);
    if (nextDirect && nextPopup && nextDirect === nextPopup) {
      setHotkeyMsg("✗ 两个热键不能相同");
      return;
    }
    await setSetting(kind === "direct" ? "hotkey_direct" : "hotkey_popup", v);
    try {
      await invoke("set_quick_hotkeys", { direct: nextDirect, popup: nextPopup });
    } catch {
      setHotkeyMsg("✗ 注册失败，热键可能被其他程序占用");
    }
  };

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    changeTheme(next);
  };

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

      <div className="mt-4 w-full max-w-xl">
        <Section title="外观" desc="宣纸 / 淡墨" first>
          <OptionRow label="深色模式">
            <button
              onClick={toggleTheme}
              title={theme === "dark" ? "切到浅色" : "切到深色"}
              className="w-8 h-8 rounded-full inline-flex items-center justify-center t2 hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors"
            >
              <MorphIcon
                icon={theme === "dark" ? Moon : Sun}
                size={16}
                strokeWidth={1.6}
                spring="snappy"
                reducedMotion="user"
                label={theme === "dark" ? "切到浅色" : "切到深色"}
              />
            </button>
          </OptionRow>
        </Section>

        <Section title="练习方式" desc="复习时从勾选的方式中随机出题">
          <div className="divide-y divide-[var(--border)]">
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
        </Section>

        <Section title="每日新词量" desc="每天最多引入的新卡数，到期复习不受限">
          <div className="flex items-center gap-4">
            <input
              value={quota}
              onChange={(e) => setQuota(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={(e) => {
                if (!e.target.value || Number(e.target.value) < 1) setQuota("10");
              }}
              inputMode="numeric"
              className="field num w-16 px-1 py-1 text-base t1"
            />
            <button
              onClick={saveQuota}
              className={`text-xs transition-colors ${
                saved ? "accent-text" : "t3 hover:text-[var(--text)]"
              }`}
            >
              {saved ? "已保存" : "保存"}
            </button>
          </div>
        </Section>

        <Section title="快速收词">
          <div className="divide-y divide-[var(--border)]">
            <OptionRow label="划词直加入书" desc="选中单词按热键，直接收进上次用的词书并弹通知">
              <Segmented
                value={hotkeyDirect}
                options={HOTKEY_OPTIONS}
                onChange={(v) => void changeHotkey("direct", v)}
              />
            </OptionRow>
            <OptionRow label="查词小窗" desc="呼出小窗即时查释义，回车确认收词">
              <Segmented
                value={hotkeyPopup}
                options={HOTKEY_OPTIONS}
                onChange={(v) => void changeHotkey("popup", v)}
              />
            </OptionRow>
          </div>
          {hotkeyMsg && <p className="mt-2 text-xs text-rose-400">{hotkeyMsg}</p>}
        </Section>

        <Section title="自动发音" desc="揭示答案时朗读单词">
          <OptionRow label="复习时自动朗读">
            <Switch
              on={autoSpeak}
              onToggle={() => {
                const next = !autoSpeak;
                setAutoSpeak(next);
                void setSetting("auto_pronounce", next ? "on" : "off");
              }}
            />
          </OptionRow>
        </Section>

        <Section title="云同步" desc="数据自动同步到你的 GitHub 私有 Gist；两台设备配同一个 Token 即可互相同步">
          <div className="flex items-center">
            <span className="text-sm t2">自动同步</span>
            <span className="ml-auto">
              <Switch
                on={autoCloud}
                onToggle={() => {
                  const next = !autoCloud;
                  setAutoCloud(next);
                  void setSetting("auto_cloud_sync", next ? "on" : "off");
                }}
                title="打开应用和复习结束后自动同步"
              />
            </span>
          </div>

          <div className="mt-3 flex items-center gap-3">
            {ghToken ? (
              <>
                <span className="text-xs accent-text">✓ 已配置（{ghToken.slice(0, 6)}…）</span>
                <button
                  onClick={() => void clearGhToken().then(() => setGhToken(null))}
                  className="text-xs t4 hover:text-rose-400 transition-colors"
                >
                  清除
                </button>
              </>
            ) : (
              <>
                <input
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="粘贴 GitHub Token（gist 权限）"
                  type="password"
                  spellCheck={false}
                  className="field flex-1 px-1 py-1 text-xs t1"
                />
                <button
                  onClick={async () => {
                    if (!tokenInput.trim()) return;
                    await saveGhToken(tokenInput);
                    setGhToken(tokenInput.trim());
                    setTokenInput("");
                  }}
                  className="text-xs t3 hover:text-[var(--text)] transition-colors flex-none"
                >
                  保存
                </button>
              </>
            )}
          </div>

          <div className="mt-3 flex items-center gap-4 text-xs">
            <button
              onClick={async () => {
                setCloudBusy(true);
                setCloudMsg(null);
                try {
                  setCloudMsg(await cloudSync());
                  setLastCloud(await lastCloudSyncText());
                } catch (e) {
                  setCloudMsg(`✗ ${String(e)}`);
                } finally {
                  setCloudBusy(false);
                }
              }}
              disabled={cloudBusy || !ghToken}
              className="t3 hover:text-[var(--text)] transition-colors disabled:opacity-40 disabled:cursor-wait"
            >
              {cloudBusy ? "同步中…" : "立即同步"}
            </button>
            {lastCloud && <span className="t4">上次 {lastCloud}</span>}
            {!ghToken && (
              <button
                onClick={() =>
                  void openUrl(
                    "https://github.com/settings/tokens/new?scopes=gist&description=immerso%20sync",
                  )
                }
                className="link ml-auto"
              >
                获取 Token ↗
              </button>
            )}
          </div>
          {cloudMsg && <p className="mt-3 text-xs t2 break-all">{cloudMsg}</p>}
        </Section>

        <Section
          title="导出 / 导入"
          desc="数据包备份，或在没有网络的机器之间手动搬运（合并规则：同一张卡取学得较新的那台，记录去重补插）"
        >
          <div className="flex items-center gap-5 text-xs">
            <button
              onClick={() => void exportData().then(setDataMsg)}
              className="t3 hover:text-[var(--text)] transition-colors"
            >
              导出数据包
            </button>
            <button
              onClick={() => void importData().then(setDataMsg)}
              className="t3 hover:text-[var(--text)] transition-colors"
            >
              导入合并
            </button>
          </div>
          {dataMsg && <p className="mt-3 text-xs t2 break-all">{dataMsg}</p>}
          <p className="mt-3 text-[11px] t4">
            匿词收藏无需备份——两台设备各自同步一遍即是同一份
          </p>
        </Section>

        <Section title="匿词同步" desc="只读拉取匿词收藏，新词带原句流入「生词本」">
          <div className="flex items-center gap-4 text-xs">
            <button
              onClick={sync}
              disabled={syncing}
              className="t3 hover:text-[var(--text)] transition-colors disabled:opacity-40 disabled:cursor-wait"
            >
              {syncing ? "同步中…" : "立即同步"}
            </button>
            {lastSync && <span className="t4">上次 {lastSync}</span>}
          </div>
          {syncMsg && <p className="mt-3 text-xs t2 break-all">{syncMsg}</p>}
        </Section>

        <p className="text-[11px] t4 text-center pt-6 border-t border-[var(--border)] mt-2">
          词典 ECDICT · 调度 FSRS-5 · 数据 %APPDATA%\com.returndm.immerso
        </p>
      </div>
    </div>
  );
}
