import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CreateRunInput } from "@upcraft/contracts";
import { closeDb } from "@upcraft/db";
import { closeQueue, createVideoRun, getRun } from "@upcraft/pipeline";
import { PRICING_VERSION } from "@upcraft/providers";
import { prepareHarness } from "../../setup/stage-context.ts";
import { buildRunInput } from "../../setup/inputs.ts";
import { loadContract, validateArtifactContract } from "../../setup/contract.ts";
import { createModelSourceClassifier, SAFETY_ROUTE, screenSource, screenSources, SOURCE_DENY_PATTERNS } from "../../setup/preflight-hardening/screening.ts";
import { decidePrivacyGate, passesLuhn, scanForPii } from "../../setup/preflight-hardening/privacy.ts";
import { validateSourceProvenance } from "../../setup/preflight-hardening/provenance.ts";
import { assertRunIdentityUnique, COST_MODEL, estimateRunCostCeiling, runIdentityKey } from "../../setup/preflight-hardening/fraud-controls.ts";
import { buildComplianceReport, COMPLIANCE_REPORT_SCHEMA_VERSION, decideComplianceGate } from "../../setup/preflight-hardening/compliance-report.ts";
import { complianceReportPathFor, runPreflightHarness } from "../../setup/preflight-runner.ts";

/**
 * s01 — Preflight guardrails & safety gate.
 *
 * Deterministic assertions for every sandbox hardening module (source screening,
 * privacy, provenance, fraud controls, compliance report) plus the harness runner
 * against the real `runPreflight` handler. The deterministic path needs no provider
 * credentials and must never call a provider; the live capability preflight is
 * shown as BLOCKED when its credentials are absent.
 */

const hostilePath = fileURLToPath(new URL("../../setup/mock-inputs/hostile-injection.txt", import.meta.url));

const main = async () => {
  const hostileText = await readFile(hostilePath, "utf8");

  // --- R1: frozen-source content screening ---
  assert.equal(SOURCE_DENY_PATTERNS.length, 5);
  assert.equal(screenSource("photosynthesis working").verdict, "pass");
  assert.equal(screenSource("Beta-adrenergic blockers (educational overview)").verdict, "pass", "educational medical source text must not be flagged");
  const hostile = screenSource(hostileText);
  assert.equal(hostile.verdict, "blocked");
  assert.ok(hostile.categories.includes("jailbreak"), `expected the jailbreak category, got ${hostile.categories.join(", ")}`);
  assert.equal(hostile.failureCode, "safety_policy_rejected");
  console.log("  R1: deterministic denylist passes benign sources and blocks the hostile fixture with a terminal code.");

  // The promotion-ready model classifier reuses the single approved safety route.
  let sawRoute = false;
  const reviewClassifier = createModelSourceClassifier(async ({ modelRef }) => {
    assert.equal(modelRef, SAFETY_ROUTE.modelRef);
    sawRoute = true;
    return { label: "review", categories: ["ambiguous"], rationale: "model stub" };
  });
  const reviewed = await reviewClassifier("plain science text");
  assert.equal(sawRoute, true);
  assert.equal(reviewed.verdict, "blocked");
  assert.equal(reviewed.failureCode, "safety_review_required");
  await assert.rejects(async () => createModelSourceClassifier(async () => ({ bogus: true }))("x"), "a malformed model label must fail schema validation");

  const screenedSources = await screenSources({
    sources: [
      { id: "s1", text: hostileText, contentHash: "h1" },
      { id: "s2", text: "photosynthesis converts light to glucose", contentHash: "h2" },
    ],
  });
  assert.equal(screenedSources.blocked, true);
  assert.equal(screenedSources.failureCode, "safety_policy_rejected");
  assert.equal(screenedSources.records.length, 2);
  assert.equal(screenedSources.records[0]!.screenedBy, "denylist");
  assert.equal(screenedSources.records[0]!.screenedChars, hostileText.length);
  console.log("  R1: every frozen source is screened; the first blocking source decides the failure code.");

  // --- R2: privacy / secret scan (hashes, never raw matches) ---
  assert.equal(passesLuhn("4111 1111 1111 1111"), true);
  assert.equal(passesLuhn("4111 1111 1111 1112"), false, "a failing Luhn checksum is not a card");
  const piiText = "Email jane.doe@example.com or call +1 555 010 9999. Card 4111 1111 1111 1111. Key sk-abcdefghijklmnop1234. password: supersecretvalue";
  const scan = scanForPii(piiText);
  const byKind = Object.fromEntries(scan.findings.map((finding) => [finding.kind, finding]));
  assert.equal(byKind.email?.count, 1);
  assert.ok(byKind.phone, "phone must be detected");
  assert.ok(byKind.card, "a Luhn-valid card must be detected");
  assert.ok(byKind["api-key"], "an API key must be detected");
  assert.ok(byKind.secret, "a secret assignment must be detected");
  const serialized = JSON.stringify(scan);
  for (const raw of ["jane.doe@example.com", "4111 1111 1111 1111", "sk-abcdefghijklmnop1234", "supersecretvalue"]) {
    assert.ok(!serialized.includes(raw), `raw private value must never appear in the scan record: ${raw}`);
  }
  assert.ok(scan.findings.every((finding) => finding.sampleHash === null || finding.sampleHash.startsWith("sha256:")), "only hashes, never raw matches");

  const blockedPrivacy = decidePrivacyGate(scan);
  assert.equal(blockedPrivacy.allowed, false);
  assert.equal(blockedPrivacy.failureCode, "privacy_blocked");
  assert.ok(blockedPrivacy.blockingKinds.includes("api-key"));
  const contactOnly = decidePrivacyGate(scanForPii("Write to a@b.com for the worksheet."));
  assert.equal(contactOnly.allowed, true, "benign contact PII is recorded, not blocking");
  assert.equal(decidePrivacyGate(scanForPii("photosynthesis converts light to glucose")).allowed, true);
  console.log("  R2: credentials block; benign contact PII records counts and hashes only.");

  // --- R3: provenance validation ---
  const okProvenance = validateSourceProvenance([{ id: "s1", kind: "text", name: "photosynthesis.txt", value: "content", hash: "a".repeat(64) }]);
  assert.equal(okProvenance.complete, true);
  assert.equal(okProvenance.records[0]!.rightsDeclaration, "unrecorded", "a missing rights basis is flagged, never fabricated");
  assert.equal(okProvenance.records[0]!.originStatus, "not-applicable");

  const insecure = validateSourceProvenance([{ id: "s2", kind: "url", name: "web copy", value: "http://example.com/a", hash: "b".repeat(64) }]);
  assert.equal(insecure.complete, false);
  assert.equal(insecure.records[0]!.originStatus, "http-insecure");
  const secure = validateSourceProvenance([{ id: "s3", kind: "url", name: "web copy", value: "https://example.com/a", hash: "c".repeat(64) }]);
  assert.equal(secure.complete, true);
  assert.equal(secure.records[0]!.originStatus, "https");
  assert.equal(secure.records[0]!.origin, "https://example.com");
  assert.ok(!JSON.stringify(secure).includes("https://example.com/a"), "the raw source URL must not be duplicated into the record");
  const missing = validateSourceProvenance([{ id: "s4", kind: "text", name: "", value: "x", hash: null }]);
  assert.equal(missing.complete, false);
  assert.ok(missing.failures.length >= 1);
  console.log("  R3: kind/name/hash required; URL sources must be HTTPS with a recorded origin; rights flagged.");

  await prepareHarness();

  // --- R4: deterministic cost ceiling + run-identity uniqueness ---
  const benignRunId = await createVideoRun(await buildRunInput("photosynthesis"));
  const benignRun = await getRun(benignRunId);
  assert.ok(benignRun, "the benign run must be created");

  const cost = estimateRunCostCeiling(benignRun!.snapshot, { sourceCount: 1 });
  assert.equal(cost.pricingVersion, PRICING_VERSION);
  assert.equal(cost.durationSeconds, 120);
  assert.ok(cost.routes.length >= 5, "a run must carry a route-level cost ceiling");
  assert.ok(cost.routes.some((route) => route.unpriced), "unpriced routes are recorded explicitly, never as a silent zero");
  assert.equal(cost.routes.find((route) => route.capability === "planning")!.calls, 4);
  assert.equal(cost.durationSeconds * COST_MODEL.narrationCharsPerSecond, 1_800);
  assert.ok(!cost.routes.some((route) => route.capability === "research-web"), "a source-backed run has no web-research ceiling");
  assert.ok(estimateRunCostCeiling(benignRun!.snapshot, { sourceCount: 0 }).routes.some((route) => route.capability === "research-web"), "a source-less run includes web research");
  console.log(`  R4: cost ceiling pricingVersion=${cost.pricingVersion} unpriced=${cost.unpriced} routes=${cost.routes.length}.`);

  assert.equal(runIdentityKey(benignRun!.snapshot, ["a", "b"]), runIdentityKey(benignRun!.snapshot, ["b", "a"]), "identity key must be order-independent over source hashes");

  // --- Compliance report assembly + gate precedence ---
  const cleanScreening = await screenSources({ sources: [{ id: "s1", text: "clean text", contentHash: "h" }] });
  const cleanScan = scanForPii("clean text");
  const cleanPrivacy = decidePrivacyGate(cleanScan);
  const cleanProvenance = validateSourceProvenance([{ id: "s1", kind: "text", name: "n", value: "clean", hash: "h" }]);
  const passing = buildComplianceReport({
    snapshotHash: "snapshot-hash",
    sourceCount: 1,
    screening: cleanScreening,
    privacyScan: cleanScan,
    privacy: cleanPrivacy,
    provenance: cleanProvenance,
    costCeiling: cost,
    idempotency: { identityKey: "key", duplicateRunId: null, unique: true },
  });
  assert.equal(passing.schemaVersion, COMPLIANCE_REPORT_SCHEMA_VERSION);
  assert.equal(passing.decision, "pass");
  assert.equal(passing.failureCode, null);
  const duplicateGate = decideComplianceGate({ screening: cleanScreening, privacy: cleanPrivacy, provenance: cleanProvenance, idempotency: { identityKey: "key", duplicateRunId: "other", unique: false } });
  assert.equal(duplicateGate.decision, "blocked");
  assert.equal(duplicateGate.failureCode, "duplicate_run");
  console.log("  compliance: gate returns a terminal code for any blocked check.");

  // --- Runner: benign source passes compliance (capability preflight is live) ---
  const benign = await runPreflightHarness({ input: "photosynthesis", runId: benignRunId });
  assert.equal(benign.compliance.decision, "pass", "the benign photosynthesis source must pass compliance");
  assert.equal(benign.productCalls, 0, "preflight must never make a provider call");

  const contract = await loadContract(fileURLToPath(new URL("./expected-compliance-output.json", import.meta.url)));
  const persisted = JSON.parse(await readFile(complianceReportPathFor(benignRunId), "utf8"));
  const contractFailures = validateArtifactContract(persisted, contract);
  assert.deepEqual(contractFailures, [], `compliance-report contract failures: ${contractFailures.join("; ")}`);
  console.log(`  runner: compliance-report persisted and contract-valid at artifacts/${benignRunId}/preflight-compliance.json.`);

  // --- Runner: hostile source is blocked before any billable call ---
  const hostileInput: CreateRunInput = {
    ...(await buildRunInput("photosynthesis")),
    topic: "Photosynthesis source packet",
    sources: [{ kind: "text", name: "hostile-injection.txt", value: hostileText }],
  };
  const hostileRunId = await createVideoRun(hostileInput);
  const hostileOutcome = await runPreflightHarness({ input: "photosynthesis", runId: hostileRunId });
  assert.equal(hostileOutcome.status, "blocked");
  assert.equal(hostileOutcome.failureCode, "safety_policy_rejected");
  assert.equal(hostileOutcome.compliance.decision, "blocked");
  assert.equal(hostileOutcome.productCalls, 0, "a blocked run must accrue zero provider calls");
  const hostileRunRecord = await getRun(hostileRunId);
  assert.equal(hostileRunRecord?.status, "failed", "a blocked run must be a terminal visible failure");
  assert.equal(hostileRunRecord?.failureCode, "safety_policy_rejected");
  console.log("  runner: hostile source blocked with a terminal code and zero provider calls.");

  // --- Runner: idempotent run identity (duplicate delivery creates no second run) ---
  const firstId = await createVideoRun(await buildRunInput("adversarial-segmentation"));
  const secondId = await createVideoRun(await buildRunInput("adversarial-segmentation"));
  const firstAssertion = await assertRunIdentityUnique(firstId);
  const secondAssertion = await assertRunIdentityUnique(secondId);
  assert.equal(firstAssertion.identityKey, secondAssertion.identityKey);
  assert.equal(secondAssertion.unique, false, "a duplicate frozen input must be detected");
  assert.equal(secondAssertion.duplicateRunId, firstId);
  assert.equal((await assertRunIdentityUnique(benignRunId)).unique, true, "a distinct run identity stays unique");
  console.log("  runner: duplicate frozen input is detected and blocked as duplicate_run.");

  // --- Live capability preflight (real runPreflight) or a visible BLOCKED ---
  if (benign.status === "blocked") {
    console.log(`s01 BLOCKED (credential): ${benign.blockReason ?? "live capability preflight requires provider keys"}`);
  } else {
    assert.equal(benign.status, "passed");
    assert.equal(benign.capabilityOutcome, "valid");
    assert.ok(benign.capabilityReport, "live preflight must persist a capability report");
    const capabilityContract = await loadContract(fileURLToPath(new URL("./expected-output.json", import.meta.url)));
    const capabilityFailures = validateArtifactContract(benign.capabilityReport, capabilityContract);
    assert.deepEqual(capabilityFailures, [], `capability-report contract failures: ${capabilityFailures.join("; ")}`);
    console.log(`  live: capability preflight valid; costCeiling=${benign.compliance.costCeiling.totalMicrounits ?? "unpriced"}.`);
  }

  console.log("s01 deterministic PASS");
  await closeQueue();
  await closeDb();
  process.exit(0);
};

main().catch(async (error) => {
  console.error("s01 FAIL:", error);
  await closeQueue().catch(() => undefined);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
