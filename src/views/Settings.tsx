import { useEffect, useState } from "react";
import { getDailyNew, setSetting } from "../lib/db";
import { lastSyncText, neathSync } from "../lib/neath";

export default function Settings({ onBack }: { onBack: () => void }) {
  const [quota, setQuota] = useState("10");
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    getDailyNew().then((v) => setQuota(String(v)));
    lastSyncText().then(setLastSync);
  }, []);

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
      setSyncMsg(`✓ 新收 ${r.added} 词 · 已在词库跳过 ${r.existing} 词`);
      setLastSync(await lastSyncText());
    } catch (e) {
      setSyncMsg(`✗ ${String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center px-6 pt-10 pb-10">
      <div className="w-full max-w-xl flex items-center">
        <button
          onClick={onBack}
          className="text-sm text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          ← 首页
        </button>
        <span className="mx-auto text-sm tracking-widest text-zinc-400 select-none">设 置</span>
        <span className="w-10" />
      </div>

      <div className="mt-10 w-full max-w-xl flex flex-col gap-4">
        {/* 每日新词量 */}
        <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800/80 px-5 py-4">
          <p className="text-zinc-200">每日新词量</p>
          <p className="mt-1 text-xs text-zinc-500">
            每天最多引入多少张新卡；到期的复习卡不受限制
          </p>
          <div className="mt-3 flex items-center gap-3">
            <input
              value={quota}
              onChange={(e) => setQuota(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={(e) => {
                if (!e.target.value || Number(e.target.value) < 1) setQuota("10");
              }}
              inputMode="numeric"
              className="w-24 rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-2 text-lg outline-none focus:border-teal-700 transition-colors tabular-nums"
            />
            <button
              onClick={saveQuota}
              className={`text-xs border rounded-full px-4 py-1.5 transition-colors ${
                saved
                  ? "border-teal-900 text-teal-500"
                  : "border-zinc-700 text-zinc-400 hover:border-teal-700 hover:text-teal-400"
              }`}
            >
              {saved ? "✓ 已保存" : "保存"}
            </button>
          </div>
        </div>

        {/* 匿词同步 */}
        <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800/80 px-5 py-4">
          <p className="text-zinc-200">匿词收词同步</p>
          <p className="mt-1 text-xs text-zinc-500">
            只读拉取匿词的词灵收藏与默认本，新词带原句流入每日队列；Key 在
            ~/.neath-api-key
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={sync}
              disabled={syncing}
              className="text-xs border rounded-full px-4 py-1.5 border-zinc-700 text-zinc-400
                         hover:border-teal-700 hover:text-teal-400 transition-colors
                         disabled:opacity-40 disabled:cursor-wait"
            >
              {syncing ? "同步中…" : "立即同步"}
            </button>
            {lastSync && <span className="text-xs text-zinc-600">上次同步 {lastSync}</span>}
          </div>
          {syncMsg && <p className="mt-3 text-xs text-zinc-400 break-all">{syncMsg}</p>}
        </div>

        {/* 关于 */}
        <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800/80 px-5 py-4">
          <p className="text-zinc-200">浸词 immerso</p>
          <p className="mt-1 text-xs text-zinc-500 leading-relaxed">
            词典 ECDICT（77 万词条）· 调度 FSRS-5（ts-fsrs）· 数据
            %APPDATA%\com.returndm.immerso（备份即复制 immerso.db）
          </p>
        </div>
      </div>
    </div>
  );
}
