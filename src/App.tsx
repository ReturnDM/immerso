import { useState } from "react";
import Home from "./views/Home";
import Search from "./views/Search";
import Review from "./views/Review";
import Settings from "./views/Settings";

type View = "home" | "search" | "review" | "settings";

export default function App() {
  const [view, setView] = useState<View>("home");

  if (view === "search") return <Search onBack={() => setView("home")} />;
  if (view === "review") return <Review onExit={() => setView("home")} />;
  if (view === "settings") return <Settings onBack={() => setView("home")} />;
  return (
    <Home
      onStart={() => setView("review")}
      onSearch={() => setView("search")}
      onSettings={() => setView("settings")}
    />
  );
}
