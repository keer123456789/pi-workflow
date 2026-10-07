import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // 测试卫生（D2/Task 3）：run 日志默认开启，测试期一律写到 OS 临时目录
    // （目录由 logger 递归创建）——绝不落进仓库工作树（.pi-workflow/ 已在 .gitignore，
    // 这里再保证一次"测试期根本不产生"）。单测要别的目录时用 RunOptions.logDir 覆盖。
    env: { PI_WORKFLOW_LOG_DIR: join(tmpdir(), "pi-workflow-test-logs") },
  },
});
