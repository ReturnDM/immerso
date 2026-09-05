export type Theme = "dark" | "light";

/** 同步应用主题（启动时用，读 localStorage 避免闪色） */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("immerso-theme", t);
}

/** 设置页切换用：应用即生效；主题跟随设备/浏览器配置，不入库 */
export function changeTheme(t: Theme) {
  applyTheme(t);
}

export function currentTheme(): Theme {
  return (localStorage.getItem("immerso-theme") as Theme) ?? "dark";
}
