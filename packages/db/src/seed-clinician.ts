import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { clinicianApprovers, getDb, closeDb } from "./index.ts";

config({ path: "../../.env.local" });
config({ path: "../../.env" });

const clerkUserId = process.env.SEED_CLINICIAN_CLERK_USER_ID;
const displayName = process.env.SEED_CLINICIAN_DISPLAY_NAME;
const credentialReference = process.env.SEED_CLINICIAN_CREDENTIAL_REFERENCE;

if (!clerkUserId || !displayName || !credentialReference) {
  throw new Error("Set SEED_CLINICIAN_CLERK_USER_ID, SEED_CLINICIAN_DISPLAY_NAME, and SEED_CLINICIAN_CREDENTIAL_REFERENCE before seeding a clinician.");
}

try {
  const db = getDb();
  const existing = await db.query.clinicianApprovers.findFirst({ where: eq(clinicianApprovers.clerkUserId, clerkUserId) });
  if (!existing) {
    await db.insert(clinicianApprovers).values({ clerkUserId, displayName, credentialReference });
    console.log("Clinician approver created.");
  }
} finally {
  await closeDb();
}
