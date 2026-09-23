import { createHash } from "node:crypto";

/**
 * s04 sandbox — composite blueprint input hash (Flaw 1), test-local until Phase-6
 * promotion.
 *
 * The s04 handler saves the blueprint with `inputHash: sha(factPack)`, so the
 * artifact's recorded input provenance omits the frozen snapshot (learner level,
 * audience, language, duration) that shaped generation. Today artifacts are
 * run-scoped and the executor's checkpoint hash already includes `snapshotHash`,
 * so this is not a live cache-poisoning bug — it is a provenance defect and a
 * future mismatch hazard. Binding the hash to the snapshot makes replay
 * idempotence and any future content-addressed cache correct by construction.
 *
 * Local `sha` is byte-identical to `packages/pipeline/src/artifacts/hashing.ts`
 * (`createHash("sha256").update(JSON.stringify(value)).digest("hex")`); promotion
 * swaps in the production helper.
 */

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The blueprint's true generation input: the verified fact pack plus the frozen snapshot. */
export const blueprintInputHash = (factPack: unknown, snapshotHash: string): string => sha([factPack, snapshotHash]);
