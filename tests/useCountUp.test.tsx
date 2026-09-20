// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCountUp } from "../src/lib/useCountUp";

/** 受控的 requestAnimationFrame：手动触发每一帧，模拟时间轴完全由测试掌控 */
function installRafDriver() {
  let cb: FrameRequestCallback | null = null;
  let cancelled = 0;
  vi.stubGlobal("requestAnimationFrame", ((f: FrameRequestCallback) => {
    cb = f;
    return 42;
  }) as unknown as typeof requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", (() => {
    cancelled++;
    cb = null;
  }) as unknown as typeof cancelAnimationFrame);
  return {
    /** 推进一帧：设置当前模拟时间并触发回调 */
    frame: (now: number) => {
      const f = cb;
      cb = null;
      f?.(now);
    },
    isScheduled: () => cb !== null,
    cancelledCount: () => cancelled,
  };
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useCountUp（数字递增动画）", () => {
  it("初始值为 0，动画推进时按 easeOutQuart 递增", () => {
    stubMatchMedia(false);
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    const raf = installRafDriver();

    const { result } = renderHook(() => useCountUp(100, 1000));
    expect(result.current).toBe(0);
    expect(raf.isScheduled()).toBe(true);

    // 进度 50%：p=0.5, eased=1-(1-0.5)^4=0.9375 -> round(100*0.9375)=94
    act(() => {
      now = 500;
      raf.frame(500);
    });
    expect(result.current).toBe(94);
    expect(raf.isScheduled()).toBe(true); // 未完成，继续调度

    // 进度 100%：p=1, eased=1 -> 100
    act(() => {
      now = 1000;
      raf.frame(1000);
    });
    expect(result.current).toBe(100);
    expect(raf.isScheduled()).toBe(false); // 完成，停止
  });

  it("完成后不再触发多余帧（最后一帧 p>=1 即停）", () => {
    stubMatchMedia(false);
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    const raf = installRafDriver();

    const { result } = renderHook(() => useCountUp(50, 500));
    act(() => {
      now = 600; // 超出 duration
      raf.frame(600);
    });
    expect(result.current).toBe(50);
    expect(raf.isScheduled()).toBe(false);
  });

  it("尊重系统减动效：prefers-reduced-motion 时直接跳到目标值", () => {
    stubMatchMedia(true);
    const raf = installRafDriver();
    const { result } = renderHook(() => useCountUp(777, 1000));
    expect(result.current).toBe(777);
    expect(raf.isScheduled()).toBe(false); // 不启动动画
  });

  it("target 为非有限数（NaN/Infinity）时不启动动画、保持 0", () => {
    stubMatchMedia(false);
    const raf = installRafDriver();
    const { result: r1 } = renderHook(() => useCountUp(Number.NaN, 1000));
    expect(r1.current).toBe(0);
    expect(raf.isScheduled()).toBe(false);

    const { result: r2 } = renderHook(() => useCountUp(Number.POSITIVE_INFINITY, 1000));
    expect(r2.current).toBe(0);
    expect(raf.isScheduled()).toBe(false);
  });

  it("卸载时取消动画帧（清理副作用）", () => {
    stubMatchMedia(false);
    const raf = installRafDriver();
    const { unmount } = renderHook(() => useCountUp(100, 1000));
    expect(raf.isScheduled()).toBe(true);
    unmount();
    expect(raf.cancelledCount()).toBe(1);
  });

  it("目标值变化触发重新动画（effect 依赖 target；首帧前保留旧值）", () => {
    stubMatchMedia(false);
    let now = 0;
    vi.stubGlobal("performance", { now: () => now });
    const raf = installRafDriver();

    const { result, rerender } = renderHook(({ t }) => useCountUp(t, 1000), { initialProps: { t: 100 } });
    act(() => {
      now = 1000;
      raf.frame(1000);
    });
    expect(result.current).toBe(100);

    // rerender 后 effect 重跑并安排新帧，但 value 保持旧值直到首帧执行
    rerender({ t: 200 });
    expect(result.current).toBe(100);
    expect(raf.isScheduled()).toBe(true);
    // 首帧（p=0）回落到 0，随后涨到新目标
    act(() => {
      now = 1000;
      raf.frame(1000);
    });
    expect(result.current).toBe(0);
    act(() => {
      now = 2000;
      raf.frame(2000);
    });
    expect(result.current).toBe(200);
  });

  it("duration 为 0 时直接跳到目标值、不启动动画（防止 (now-t0)/0 产生 NaN）", () => {
    // 旧实现 (now - t0) / 0 在首帧（now===t0）算出 0/0=NaN 并 setValue(NaN)（当时该用例专为记录
    // 此 bug 行为而写）；修复后无时长即无动画过程，直接落位、不调度动画帧。
    stubMatchMedia(false);
    const raf = installRafDriver();
    const { result } = renderHook(() => useCountUp(42, 0));
    expect(result.current).toBe(42);
    expect(raf.isScheduled()).toBe(false);
  });

  it("duration 为负数同样直接落到目标值", () => {
    stubMatchMedia(false);
    const raf = installRafDriver();
    const { result } = renderHook(() => useCountUp(7, -100));
    expect(result.current).toBe(7);
    expect(raf.isScheduled()).toBe(false);
  });
});