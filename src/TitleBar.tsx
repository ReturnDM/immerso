import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./components/Icon";

const appWindow = getCurrentWindow();

/** 无边框窗口顶部：拖拽区 + 窗口控制 */
export default function TitleBar() {
  return (
    <>
      <div data-tauri-drag-region className="fixed top-0 inset-x-0 h-8 z-40" />
      <div className="fixed top-0 right-0 h-8 z-50 flex items-stretch">
        <button
          onClick={() => appWindow.minimize()}
          className="w-11 t3 hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors flex items-center justify-center"
          title="最小化"
        >
          <Icon name="minus" size={14} />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          className="w-11 t3 hover:text-[var(--text)] hover:bg-[var(--hover)] transition-colors flex items-center justify-center"
          title="最大化"
        >
          <Icon name="maximize" size={12} />
        </button>
        <button
          onClick={() => appWindow.close()}
          className="w-11 t3 hover:text-white hover:bg-red-900/70 transition-colors flex items-center justify-center"
          title="关闭"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </>
  );
}
