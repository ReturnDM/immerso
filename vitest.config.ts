import { defineConfig } from "vitest/config";

// 独立的 vitest 配置：测试目标为纯逻辑模块，node 环境即可，
// 需要 DOM 的用例（useCountUp.test.tsx）通过文件头注释 @vitest-environment happy-dom 单独指定。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // 覆盖 src/lib 下纯逻辑模块（db/sync/cloud/neath/capture 依赖 Tauri API，无法在 Node 导入）
    coverage: {
      provider: "v8",
      include: ["src/lib/fsrs.ts", "src/lib/spell.ts", "src/lib/books.ts", "src/lib/useCountUp.ts", "src/lib/exercises.ts"],
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});