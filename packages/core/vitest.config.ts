import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/storage.test.ts', 'tests/operations.test.ts', 'tests/queries.test.ts'],
  },
});
