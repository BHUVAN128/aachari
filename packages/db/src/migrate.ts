import { config } from "dotenv";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb, closeDb } from "./index.ts";

config({ path: "../../.env.local" });
config({ path: "../../.env" });

try {
  await migrate(getDb(), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  console.log("Database migrations applied.");
} finally {
  await closeDb();
}
