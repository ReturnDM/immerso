import { useState } from "react";
import Home from "./views/Home";
import Search from "./views/Search";
import Review from "./views/Review";
import Settings from "./views/Settings";
import Stats from "./views/Stats";
import TitleBar from "./TitleBar";

type View = "home" | "search" | "review" | "settings" | "stats";

export default function App() {
  const [view, setView] = useState<View>("home");

  return (
    <>
      <TitleBar />
      {view === "search" && <Search onBack={() => setView("home")} />}
      {view === "review" && <Review onExit={() => setView("home")} />}
      {view === "settings" && <Settings onBack={() => setView("home")} />}
      {view === "stats" && <Stats onBack={() => setView("home")} />}
      {view === "home" && (
        <Home
          onStart={() => setView("review")}
          onSearch={() => setView("search")}
          onSettings={() => setView("settings")}
          onStats={() => setView("stats")}
        />
      )}
    </>
  );
}
