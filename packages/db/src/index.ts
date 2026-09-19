import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export * from "./schema.ts";

let client: postgres.Sql | undefined;
let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export const getDb = () => {
  if (!db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    client = postgres(connectionString, { max: 10, idle_timeout: 20 });
    db = drizzle(client, { schema });
  }
  return db;
};

export const closeDb = async () => {
  await client?.end({ timeout: 5 });
  client = undefined;
  db = undefined;
};
