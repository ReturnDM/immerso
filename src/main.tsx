import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickCapture from "./QuickCapture";
import { applyTheme, currentTheme } from "./lib/theme";
import "./index.css";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

applyTheme(currentTheme());

// quick 窗口（热键呼出的收词小窗）与主窗口共用这份前端，按窗口标签分流
const Root = getCurrentWebviewWindow().label === "quick" ? QuickCapture : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
