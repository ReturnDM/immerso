import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Home from "./views/Home";
import Search from "./views/Search";
import Review from "./views/Review";
import Settings from "./views/Settings";
import Stats from "./views/Stats";
import Library from "./views/Library";
import TitleBar from "./TitleBar";
import { getSetting } from "./lib/db";
import { directCapture, notify } from "./lib/capture";

type View = "home" | "search" | "review" | "settings" | "stats" | "library";

export default function App() {
  const [view, setView] = useState<View>("home");

  // Rust 端启动时先挂了默认热键；这里按设置页保存的值重挂（兼容旧的单热键设置）
  useEffect(() => {
    void (async () => {
      const direct = (await getSetting("hotkey_direct")) ?? (await getSetting("quick_hotkey")) ?? "alt+q";
      const popup = (await getSetting("hotkey_popup")) ?? "ctrl+shift+space";
      try {
        await invoke("set_quick_hotkeys", { direct, popup });
      } catch {
        /* 启动时注册失败不打断应用，默认键仍在 */
      }
    })();
  }, []);

  // 划词直加热键：读选中文本 → 直接入书 → 系统通知
  useEffect(() => {
    const un = listen("quick-direct", () => {
      void (async () => {
        try {
          const raw = await invoke<string>("capture_selected");
          notify(await directCapture(raw));
        } catch (e) {
          notify(`收词失败：${String(e)}`);
        }
      })();
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  return (
    <>
      <TitleBar />
      <div key={view} className="animate-view-in">
        {view === "search" && <Search onBack={() => setView("home")} />}
        {view === "review" && <Review onExit={() => setView("home")} />}
        {view === "settings" && <Settings onBack={() => setView("home")} />}
        {view === "stats" && <Stats onBack={() => setView("home")} />}
        {view === "library" && <Library onBack={() => setView("home")} />}
        {view === "home" && (
          <Home
            onStart={() => setView("review")}
            onSearch={() => setView("search")}
            onSettings={() => setView("settings")}
            onStats={() => setView("stats")}
            onLibrary={() => setView("library")}
          />
        )}
      </div>
    </>
  );
}
