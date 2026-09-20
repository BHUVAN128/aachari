import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "@upcraft/db";
import { ensureTestDatabase, truncateAll } from "./db-admin.ts";
import { loadRepoEnv } from "./load-env.ts";

/**
 * Wires the process environment to harness-owned resources before any real stage
 * module is imported. Handlers call`getDb()` and the provider storage functions
 * directly, so isolation has to happen through the environment rather than by
 * mocking, and every provider call then runs the identical production code path.
 *
 * - Postgres: a dedicated `upcraft_harness` database (never the production one).
 * - Object storage: the repo's local MinIO, on a dedicated `upcraft-harness` bucket.
 * - Rendering: `test/pipeline/.render-output`.
 * - Queue signals: the local Valkey used by docker compose.
 */
export const HARNESS_BUCKET = "upcraft-harness";

export const HARNESS_RENDER_DIR = fileURLToPath(new URL("../.render-output", import.meta.url));

const ensureBucket = async () => {
  const client = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:19000",
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: HARNESS_BUCKET }));
  } catch {
    try {
      await client.send(new CreateBucketCommand({ Bucket: HARNESS_BUCKET }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(message)) throw error;
    }
  }
};

let prepared: Promise<void> | undefined;

/** Idempotently prepares the test DB, applies migrations, and selects the bucket. */
export const prepareHarness = (): Promise<void> => {
  prepared ??= (async () => {
    loadRepoEnv();
    await ensureTestDatabase();
    process.env.S3_BUCKET = HARNESS_BUCKET;
    process.env.RENDER_OUTPUT_DIR = HARNESS_RENDER_DIR;
    if (!process.env.VALKEY_URL) process.env.VALKEY_URL = "redis://127.0.0.1:16379";
    await migrate(getDb(), { migrationsFolder: fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)) });
    await ensureBucket();
    await truncateAll();
  })();
  return prepared;
};

export const resetHarness = async () => {
  await closeDb();
  prepared = undefined;
};