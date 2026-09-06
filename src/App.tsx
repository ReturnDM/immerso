import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Home from "./views/Home";
import Search from "./views/Search";
import Review from "./views/Review";
import Settings from "./views/Settings";
import Stats from "./views/Stats";
import Library from "./views/Library";
import TitleBar from "./TitleBar";
import { getSetting } from "./lib/db";

type View = "home" | "search" | "review" | "settings" | "stats" | "library";

export default function App() {
  const [view, setView] = useState<View>("home");

  // Rust 端启动时先注册了默认 Alt+Q；这里按设置页保存的值重新注册
  useEffect(() => {
    void (async () => {
      const hk = await getSetting("quick_hotkey");
      if (hk !== null) {
        try {
          await invoke("set_quick_hotkey", { accelerator: hk || null });
        } catch {
          /* 启动时注册失败不打断应用，默认键仍在 */
        }
      }
    })();
  }, []);

  return (
    <>
      <TitleBar />
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
    </>
  );
}
