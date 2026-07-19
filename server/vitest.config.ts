import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // SQLite isolation: every test file shares in-memory/temp DBs via initDb(path).
    // Forks (not threads) + no file parallelism prevents cross-file SQLite races.
    // The npm `test` script passes the same flags; encoding them here makes
    // off-script runs (IDE runners, `npx vitest run <file>`, watch) equally safe.
    pool: 'forks',
    fileParallelism: false,
  },
});
