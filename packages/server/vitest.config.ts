import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/storage.test.ts', 'tests/gap.test.ts', 'tests/mcp-slim.test.ts'],
    // TODO: queries.test.ts, operations.test.ts, projects.test.ts need migration
    // to async PostgreSQL API — they currently test a removed synchronous SQLite API.
  },
});
