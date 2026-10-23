import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/gap.test.ts', 'tests/mcp-slim.test.ts', 'tests/events.test.ts', 'tests/workpack.test.ts'],
    // 测试共享远端 PG 库 sibeaver_test——串行执行避免 truncate 冲突
    fileParallelism: false,
  },
});
