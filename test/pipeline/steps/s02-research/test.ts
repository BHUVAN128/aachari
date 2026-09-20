import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FactPackSchema, SourceEvidenceMapSchema } from "@upcraft/contracts";
import { createVideoRun } from "@upcraft/pipeline";
import { prepareHarness } from "../../setup/stage-context.ts";
import { runStage, artifactFor } from "../../setup/runner.ts";
import { buildRunInput } from "../../setup/inputs.ts";
import { validateArtifactContract, loadContract } from "../../setup/contract.ts";
import { buildSourceEvidenceMapWithOverlap, chooseBoundary, OVERLAP_CONTEXT_CHARS, resolveSegments, segmentationManifest, SEGMENT_TARGET_SIZE } from "./segmentation.ts";

const contractPath = fileURLToPath(new URL("./expected-output.json", import.meta.url));
const adversarialPath = fileURLToPath(new URL("../../setup/mock-inputs/adversarial-segmentation.txt", import.meta.url));

/**
 * s02 — Research & fact pack.
 *
 * Asserts:
 *   1. Gap 3: sentence-aware boundaries never cut a sentence that fits inside the
 *      lookahead window; primary segments still join losslessly.
 *   2. Gap 3: a definition straddling the naive 6000-char boundary survives intact
 *      in a single primary segment.
 *   3. Gap 3: overlap context is emitted as marked segments and is citable.
 *   4. The real stage emits a schema-valid `fact-pack/v2` whose claims cite only
 *      locked segment ids, and every cited segment resolves.
 */
const main = async () => {
  await prepareHarness();

  // --- Gap 3 invariant tests (deterministic, no provider call) ---
  const adversarial = await readFile(adversarialPath, "utf8");
  const id = "11111111-1111-4111-8111-111111111111";
  const hash = createHash("sha256").update(adversarial).digest("hex");
  const { map, overlaps, primaryJoin } = buildSourceEvidenceMapWithOverlap([{ id, sha256: hash, extractedText: adversarial }]);

  assert.equal(primaryJoin, adversarial, "primary segments must join losslessly to the source");
  const primary = map.sources[0]!.segments;
  assert.ok(primary.length > 1, "adversarial source must produce more than one primary segment");
  for (let index = 1; index < primary.length; index += 1) {
    assert.equal(primary[index]!.startOffset, primary[index - 1]!.endOffset, "primary offsets must be contiguous and monotonic");
  }
  const containing = primary.find((segment) => segment.text.includes("Photolysis is the light-driven splitting of water molecules"));
  assert.ok(containing, "the definition straddling the 6000-char boundary must not be split across primary segments");
  assert.ok(!containing!.text.startsWith("litting"), "the definition must remain intact in one primary segment");
  console.log(`  Gap 3: ${primary.length} primary segments, ${overlaps.length} overlap segments, definition intact (no mid-sentence cut at ${SEGMENT_TARGET_SIZE}).`);

  assert.ok(overlaps.length >= primary.length - 1, "each non-first primary boundary should emit overlap context");
  assert.ok(overlaps.every((segment) => segment.overlap === true && segment.endOffset - segment.startOffset <= OVERLAP_CONTEXT_CHARS), "overlap segments must be marked and bounded");
  const resolvedOverlap = resolveSegments(map, overlaps, [{ sourceId: id, sourceHash: hash, segmentIds: [overlaps[0]!.id] }]);
  assert.equal(resolvedOverlap.length, 1, "overlap segments must be valid citation evidence");
  const manifest = segmentationManifest(map, overlaps);
  assert.equal(manifest.primarySegments, primary.length);
  assert.equal(manifest.overlapSegments, overlaps.length);
  console.log(`  Gap 3: segmentation manifest = ${JSON.stringify(manifest)}.`);

  const naiveBoundary = chooseBoundary(adversarial, 0, SEGMENT_TARGET_SIZE);
  assert.notEqual(naiveBoundary, SEGMENT_TARGET_SIZE, "boundary search must move the cut off the hard cap");
  assert.ok(adversarial[naiveBoundary - 1] === " " || /[.!?]/.test(adversarial[naiveBoundary - 1] ?? ""), "chosen boundary must land on sentence or word whitespace");

  // --- Real stage test ---
  const runId = await createVideoRun(await buildRunInput("photosynthesis"));
  const result = await runStage({ stage: "research", input: "photosynthesis", runId, allowBlocked: true });
  if (result.blockReason) {
    console.log(`s02 BLOCKED (credential): ${result.blockReason}`);
    return;
  }
  assert.notEqual(result.checkpointOutcome, "failed", `s02 must not fail: ${result.failureMessage ?? ""}`);

  const artifact = await artifactFor(runId, "fact-pack");
  assert.ok(artifact?.content, "s02 must persist a fact-pack artifact");
  const factPack = FactPackSchema.parse(artifact!.content);

  const mapArtifact = await artifactFor(runId, "source-evidence-map");
  assert.ok(mapArtifact?.content, "s02 must persist a source-evidence-map artifact");
  const evidenceMap = SourceEvidenceMapSchema.parse(mapArtifact!.content);

  const contract = await loadContract(contractPath);
  const failures = validateArtifactContract(factPack, contract);
  assert.deepEqual(failures, [], `fact-pack contract failures: ${failures.join("; ")}`);

  for (const claim of factPack.claims) {
    const source = evidenceMap.sources.find((candidate) => candidate.sourceId === claim.evidence.sourceId);
    assert.ok(source, `claim ${claim.id} cites an unknown source`);
    for (const segmentId of claim.evidence.segmentIds) {
      assert.ok(source!.segments.some((segment) => segment.id === segmentId), `claim ${claim.id} cites missing segment ${segmentId}`);
    }
  }
  console.log(`  s02: ${factPack.claims.length} claims, all citing locked segments. Contract valid.`);
  console.log("s02 PASS");
};

main().catch((error) => {
  console.error("s02 FAIL:", error);
  process.exit(1);
});