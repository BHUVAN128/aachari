import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "dotenv";
import { closeDb } from "@upcraft/db";
import { collectRegressionFixtures } from "../packages/pipeline/src/feedback-regression.ts";

config({ path: ".env.local" });
config({ path: ".env" });

const main = async () => {
  const outputPath = process.argv[2] ?? ".local/regression-fixtures.json";
  try {
    const fixtures = await collectRegressionFixtures();
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify({ schemaVersion: "regression-fixture-set/v1", generatedAt: new Date().toISOString(), fixtures }, null, 2));
    console.log(`Wrote ${fixtures.length} regression fixtures to ${outputPath}.`);
  } finally {
    await closeDb();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
