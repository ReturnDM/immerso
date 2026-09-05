import { useState } from "react";
import Home from "./views/Home";
import Search from "./views/Search";
import Review from "./views/Review";

type View = "home" | "search" | "review";

export default function App() {
  const [view, setView] = useState<View>("home");

  if (view === "search") return <Search onBack={() => setView("home")} />;
  if (view === "review") return <Review onExit={() => setView("home")} />;
  return <Home onStart={() => setView("review")} onSearch={() => setView("search")} />;
}
