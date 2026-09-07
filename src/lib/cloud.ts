// 云同步：GitHub 私有 Gist 作为同步存储
// Token 存 ~/.immerso-gh-token（明文本机文件，与 .neath-api-key 同纪律，勿提交勿外传）
// 每次同步 = 拉远端 → 合并进本库 → 把合并后的全量（超集）传回 → 收敛
import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { BaseDirectory } from "@tauri-apps/plugin-fs";
import { getSetting, setSetting } from "./db";
import { collectBackup, mergeIntoLocal, type Backup } from "./sync";

const GIST_NAME = "immerso-sync.json";
const API = "https://api.github.com";

export async function getGhToken(): Promise<string | null> {
  try {
    const t = (
      await readTextFile(".immerso-gh-token", { baseDir: BaseDirectory.Home })
    ).trim();
    return t || null;
  } catch {
    return null;
  }
}

export async function saveGhToken(token: string): Promise<void> {
  await writeTextFile(".immerso-gh-token", token.trim(), { baseDir: BaseDirectory.Home });
}

export async function clearGhToken(): Promise<void> {
  await writeTextFile(".immerso-gh-token", "", { baseDir: BaseDirectory.Home });
}

/**
 * GitHub API 请求：走 Rust 侧 gist_http 命令（reqwest 直连，连接 15s / 总 120s 超时）。
 * 大备份经 plugin-http 会变成字节数组 JSON 过 WebView IPC，慢到撑爆前端超时，
 * 还会「服务端已建 Gist、前端却取消」——id 丢失，每次重试都新建孤儿 Gist。
 * 返回轻量 Response 形状（ok/status/json/text），调用处无感。
 */
async function gh(url: string, token: string, init?: { method?: string; body?: string }) {
  const [status, text] = await invoke<[number, string]>("gist_http", {
    method: init?.method ?? "GET",
    url,
    token,
    body: init?.body ?? null,
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(text) as unknown),
    text: () => Promise.resolve(text),
  };
}

/** 读取 Gist 内容；处理 GitHub API 对 >1MB 文件的截断（转抓 raw_url） */
async function fetchGist(token: string, id: string): Promise<Backup | null> {
  const res = await gh(`${API}/gists/${id}`, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status}（Token 失效或无权限）`);
  const j = (await res.json()) as {
    files?: Record<string, { content?: string; truncated?: boolean; raw_url?: string }>;
  };
  const f = j.files?.[GIST_NAME];
  if (!f) return null;
  let text: string;
  if (f.truncated && f.raw_url) {
    const raw = await gh(f.raw_url, token);
    if (!raw.ok) throw new Error(`拉取 Gist 原文失败 ${raw.status}`);
    text = await raw.text();
  } else {
    text = f.content ?? "";
  }
  try {
    return JSON.parse(text) as Backup;
  } catch {
    throw new Error("Gist 内容不是有效的浸词备份");
  }
}

/** 云同步主流程；返回报告文本 */
export async function cloudSync(): Promise<string> {
  const token = await getGhToken();
  if (!token) throw new Error("尚未配置 GitHub Token");

  let gistId = await getSetting("cloud_gist_id");
  let remote: Backup | null = null;
  if (gistId) {
    remote = await fetchGist(token, gistId); // 404 → null，靠推送段的死 id 重建
  }

  let report = "";
  if (remote) {
    report = await mergeIntoLocal(remote);
  }

  // 合并后的本机是全量超集，整包传回
  const merged = await collectBackup();
  const body = JSON.stringify({
    description: "immerso 同步数据（勿手动编辑）",
    files: { [GIST_NAME]: { content: JSON.stringify(merged) } },
  });
  if (gistId) {
    const res = await gh(`${API}/gists/${gistId}`, token, { method: "PATCH", body });
    if (res.status === 404) {
      gistId = null; // 远端已被删除或失效 → 转为重建新 Gist
    } else if (!res.ok) {
      throw new Error(`更新 Gist 失败 ${res.status}`);
    }
  }
  if (!gistId) {
    const res = await gh(`${API}/gists`, token, { method: "POST", body });
    if (!res.ok) throw new Error(`创建 Gist 失败 ${res.status}（检查 Token 是否有 gist 权限）`);
    const j = (await res.json()) as { id: string };
    gistId = j.id;
    await setSetting("cloud_gist_id", gistId);
  }
  await setSetting("last_cloud_sync", new Date().toISOString());
  return report ? `✓ 云同步：${report}` : `✓ 云同步完成（${merged.cards.length} 卡已上云）`;
}

/** 自动同步：已配置且未关闭时执行，返回状态文本（错误也以文本返回，不打扰界面） */
export async function maybeAutoSync(): Promise<string | null> {
  const token = await getGhToken();
  if (!token) return null;
  if ((await getSetting("auto_cloud_sync")) === "off") return null;
  try {
    return await cloudSync();
  } catch (e) {
    return `云同步失败：${String(e)}`;
  }
}

export async function lastCloudSyncText(): Promise<string | null> {
  const iso = await getSetting("last_cloud_sync");
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
