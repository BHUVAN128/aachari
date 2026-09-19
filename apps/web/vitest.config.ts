import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
    pool: "forks",
    fileParallelism: false,
  },
});
