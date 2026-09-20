import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test file opens a real SQLite database and a real listening
    // socket; argon2 verification makes the sign-in tests slow on purpose.
    fileParallelism: false,
    env: { NODE_ENV: "test" },
    testTimeout: 30000,
  },
});
