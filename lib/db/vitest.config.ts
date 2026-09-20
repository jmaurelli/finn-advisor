import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Every test opens real SQLite files and some take the write lock across
    // processes; running them in one process keeps that contention meaningful.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
