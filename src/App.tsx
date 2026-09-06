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
/** 转场方向：fwd 前进（去往子页）、back 返回（回首页）、dive 进入复习 */
type Dir = "fwd" | "back" | "dive";
const DIR_CLASS: Record<Dir, string> = {
  fwd: "animate-view-fwd",
  back: "animate-view-back",
  dive: "animate-view-dive",
};

export default function App() {
  const [nav, setNav] = useState<{ view: View; dir: Dir }>({ view: "home", dir: "fwd" });
  const { view } = nav;
  const go = (v: View, dir: Dir) => setNav({ view: v, dir });

  // Rust 端启动时先挂了默认热键；这里按设置页保存的值重挂（兼容旧的单热键设置）
  useEffect(() => {
    void (async () => {
      const direct = (await getSetting("hotkey_direct")) ?? (await getSetting("quick_hotkey")) ?? "alt+q";
      const popup = (await getSetting("hotkey_popup")) ?? "alt+e";
      try {
        await invoke("set_quick_hotkeys", { direct, popup });
      } catch {
        /* 启动时注册失败不打断应用，默认键仍在 */
      }
    })();
  }, []);

  // 划词直加热键：单词/短语直入词书并通知；选中整句（≥3 词）则呼出小窗，句子自动进原句栏
  useEffect(() => {
    const un = listen("quick-direct", () => {
      void (async () => {
        try {
          const raw = await invoke<string>("capture_selected");
          const words = raw.trim().split(/\s+/).filter(Boolean).length;
          if (words >= 3) {
            await invoke("open_quick");
          } else {
            notify(await directCapture(raw));
          }
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
      <div key={view} className={DIR_CLASS[nav.dir]}>
        {view === "search" && <Search onBack={() => go("home", "back")} />}
        {view === "review" && <Review onExit={() => go("home", "back")} />}
        {view === "settings" && <Settings onBack={() => go("home", "back")} />}
        {view === "stats" && <Stats onBack={() => go("home", "back")} />}
        {view === "library" && <Library onBack={() => go("home", "back")} />}
        {view === "home" && (
          <Home
            onStart={() => go("review", "dive")}
            onSearch={() => go("search", "fwd")}
            onSettings={() => go("settings", "fwd")}
            onStats={() => go("stats", "fwd")}
            onLibrary={() => go("library", "fwd")}
          />
        )}
      </div>
    </>
  );
}
