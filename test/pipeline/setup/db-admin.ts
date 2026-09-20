import postgres from "postgres";

/**
 * Test-database lifecycle for the step harness. The harness runs the real stage
 * handlers unmodified, so it needs a real Postgres database; it must never be the
 * production one. The database name is fixed and separate (`upcraft_harness`)
 * and is created/truncated only from here.
 */
export const TEST_DATABASE_NAME = "upcraft_harness";

const credentials = () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required to build a harness database");
  return url;
};

/** Rewrites any configured database URL onto the fixed harness database name. */
export const testDatabaseUrl = () => {
  const url = new URL(credentials());
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
};

const adminUrl = () => {
  const url = new URL(credentials());
  url.pathname = "/postgres";
  return url.toString();
};

export const ensureTestDatabase = async () => {
  const admin = postgres(adminUrl(), { max: 1 });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${TEST_DATABASE_NAME}`;
    if (!existing.length) await admin.unsafe(`create database "${TEST_DATABASE_NAME}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  process.env.DATABASE_URL = testDatabaseUrl();
};

/** Clears every table so a run starts from a known-empty durable state. */
export const truncateAll = async () => {
  const sql = postgres(testDatabaseUrl(), { max: 1 });
  try {
    const tables = await sql`select tablename from pg_tables where schemaname = 'public'`;
    if (!tables.length) return;
    const names = tables.map((row) => `"${row.tablename as string}"`).join(", ");
    await sql.unsafe(`truncate table ${names} restart identity cascade`);
  } finally {
    await sql.end({ timeout: 5 });
  }
};