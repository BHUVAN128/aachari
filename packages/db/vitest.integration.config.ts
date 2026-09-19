import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config({ path: "../../.env.local" });
config({ path: "../../.env" });

export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    passWithNoTests: true,
  },
});
