import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { closeDb } from "@upcraft/db";
import { VerifiedFactPackSchema } from "@upcraft/contracts";
import {
  BRAVE_BACKOFF_MS,
  BRAVE_RETRY_LADDER,
  BraveCredentialError,
  BraveMcpClient,
  BraveResearchUnavailableError,
  BraveSchemaDriftError,
  BraveTerminalError,
  McpTransportError,
  broadenQuery,
  classifyBraveFailureText,
  flattenToolError,
  parseBraveGrounding,
  resolveModelRoute,
  runBraveResearch,
  type BraveAttemptRecord,
  type BraveGroundingSource,
} from "@upcraft/providers";
import { assembleBraveDocuments, buildSourceEvidenceMapWithOverlap, closeQueue, joinBraveSnippets, mergeOverlapSegments } from "@upcraft/pipeline";
import { prepareHarness } from "../../../setup/stage-context.ts";
import { buildRunInput } from "../../../setup/inputs.ts";
import { runBraveResearchHarness, runDownstreamVerificationHarness } from "./research-brave.ts";

const fakeServerPath = fileURLToPath(new URL("./fake-brave-mcp.ts", import.meta.url));
const route = resolveModelRoute("research-web");
const noSleep = async () => {};

const clientFor = (scenario: string, failFirst = 0) =>
  new BraveMcpClient({ command: "node", args: [fakeServerPath], env: { ...process.env, FAKE_BRAVE_SCENARIO: scenario, FAKE_BRAVE_FAIL_FIRST: String(failFirst) } });

type Stub = { start: () => Promise<void>; assertLlmContextTool: () => Promise<string[]>; callLlmContext: (params: Record<string, unknown>, timeoutMs: number) => Promise<{ payload: Record<string, unknown>; text: string }>; close: () => Promise<void> };
const asClient = (stub: Stub) => stub as unknown as BraveMcpClient;

const longestSnippet = "Photosynthesis converts light energy into chemical energy stored in glucose, using chlorophyll to absorb light and releasing oxygen. ".repeat(3).trim();

const payloadWithSource = (): Record<string, unknown> => ({ grounding: { generic: [{ url: "https://www.example.edu/p", title: "P", snippets: [longestSnippet] }] } });

const main = async () => {
  // --- 1. Classifier: status is embedded at the start of the flattened text ---
  assert.deepEqual(classifyBraveFailureText("401 Unauthorized\n{\"error\":\"...\"}"), { retryable: false, code: "BRAVE_401", kind: "terminal" });
  assert.equal(classifyBraveFailureText("403 Forbidden").retryable, false);
  assert.equal(classifyBraveFailureText("Invalid API Key").code, "BRAVE_INVALID_API_KEY");
  assert.equal(classifyBraveFailureText("quota exceeded").retryable, false);
  assert.deepEqual(classifyBraveFailureText("429 Too Many Requests"), { retryable: true, code: "BRAVE_429", kind: "rate-limit" });
  assert.equal(classifyBraveFailureText("500 Internal Server Error").retryable, true);
  assert.equal(classifyBraveFailureText("something unexpected").code, "BRAVE_MALFORMED");
  assert.equal(flattenToolError({ content: [{ type: "text", text: "401 Unauthorized" }], structuredContent: { status: 401 } }).includes("401 Unauthorized"), true);
  console.log("  1. classifier: auth/quota terminal; 429/5xx/malformed retryable.");

  // --- 2. Grounding parse: reject malformed, ignore poi/map, keep snippets ---
  const parsed = parseBraveGrounding({ grounding: { generic: [{ url: "https://a.example.edu/x", title: "A", snippets: ["one", 2, "two"] }, { title: "no url" }, "junk"], poi: { results: [{ url: "https://poi" }] } }, sources: { "https://a.example.edu/x": { title: "Mapped", snippets: ["three"] } } });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], { url: "https://a.example.edu/x", title: "A", snippets: ["one", "two"] });
  assert.deepEqual(parseBraveGrounding(undefined), []);
  console.log("  2. grounding parse: malformed dropped, poi/map ignored.");

  // --- 3. Ladder constants: 5 attempts, compressed timeouts, threshold order ---
  assert.equal(BRAVE_RETRY_LADDER.length, 5);
  assert.deepEqual(BRAVE_RETRY_LADDER.map((step) => step.timeoutMs), [10_000, 15_000, 20_000, 35_000, 40_000]);
  assert.deepEqual(BRAVE_RETRY_LADDER.map((step) => step.params.context_threshold_mode), ["strict", "balanced", "lenient", "disabled", "disabled"]);
  assert.equal(BRAVE_RETRY_LADDER[4]!.broaden, true);
  assert.deepEqual([...BRAVE_BACKOFF_MS], [1_000, 2_000, 4_000, 8_000]);
  assert.equal(broadenQuery("How does photosynthesis work in plants?"), "photosynthesis plants");
  console.log("  3. ladder: timeouts 10/15/20/35/40s, thresholds strict→balanced→lenient→disabled→disabled, attempt 5 broadened.");

  // --- 4. Stub ladder: success on attempt 1; empty grounding exhausts all 5 ---
  const stubSuccess = asClient({ start: async () => {}, assertLlmContextTool: async () => [], callLlmContext: async () => ({ payload: payloadWithSource(), text: "" }), close: async () => {} });
  const success = await runBraveResearch(route, { query: "photosynthesis", client: stubSuccess, sleep: noSleep });
  assert.equal(success.attempts.length, 1);
  assert.equal(success.attempts[0]!.thresholdMode, "strict");
  assert.equal(success.attempts[0]!.timeoutMs, 10_000);
  assert.equal(success.sources.length, 1);

  const sleeps: number[] = [];
  const emptyRecords: BraveAttemptRecord[] = [];
  const stubEmpty = asClient({ start: async () => {}, assertLlmContextTool: async () => [], callLlmContext: async () => ({ payload: { grounding: { generic: [] } }, text: "" }), close: async () => {} });
  await assert.rejects(
    runBraveResearch(route, { query: "How does photosynthesis work?", client: stubEmpty, jitter: (base) => base, sleep: async (ms) => { sleeps.push(ms); }, onAttempt: (record) => { emptyRecords.push(record); } }),
    (error: unknown) => {
      assert.ok(error instanceof BraveResearchUnavailableError);
      assert.equal(error.message, "Something went wrong. Please try again later.");
      assert.equal(error.attempts.length, 5);
      return true;
    },
  );
  assert.deepEqual(sleeps, [...BRAVE_BACKOFF_MS]);
  assert.deepEqual(emptyRecords.map((record) => record.errorCode), ["BRAVE_EMPTY_GROUNDING", "BRAVE_EMPTY_GROUNDING", "BRAVE_EMPTY_GROUNDING", "BRAVE_EMPTY_GROUNDING", "BRAVE_EMPTY_GROUNDING"]);
  assert.equal(emptyRecords[4]!.broadened, true);
  console.log(`  4. stub ladder: worst case ${success.attempts.length + emptyRecords.length} attempts, client-safe exhaustion message, backoff 1/2/4/8s.`);

  // --- 5. Stub ladder: terminal failure stops after exactly one attempt ---
  let terminalCalls = 0;
  const stubTerminal = asClient({ start: async () => {}, assertLlmContextTool: async () => [], callLlmContext: async () => { terminalCalls += 1; throw new BraveTerminalError("401 Unauthorized", "BRAVE_401"); }, close: async () => {} });
  await assert.rejects(runBraveResearch(route, { query: "x", client: stubTerminal, sleep: noSleep }), (error: unknown) => {
    assert.ok(error instanceof BraveResearchUnavailableError);
    assert.equal(error.code, "BRAVE_401");
    assert.equal(error.attempts.length, 1);
    return true;
  });
  assert.equal(terminalCalls, 1, "auth failures must never be retried");
  console.log("  5. terminal auth: exactly 1 attempt, never retried.");

  // Timeout (hung socket) is a classified transport failure and is retried through every attempt.
  let timeouts = 0;
  const stubTimeout = asClient({ start: async () => {}, assertLlmContextTool: async () => [], callLlmContext: async () => { timeouts += 1; throw new McpTransportError("timeout", "Brave MCP tools/call timed out"); }, close: async () => {} });
  await assert.rejects(runBraveResearch(route, { query: "x", client: stubTimeout, sleep: noSleep }), (error: unknown) => {
    assert.ok(error instanceof BraveResearchUnavailableError);
    assert.equal(error.attempts.length, 5);
    assert.ok(error.attempts.every((record) => record.errorCode === "BRAVE_TIMEOUT"));
    return true;
  });
  assert.equal(timeouts, 5, "a hung call escalates through the full ladder");
  console.log("  5b. timeout: 5 attempts, all BRAVE_TIMEOUT.");

  // --- 6. Real fake MCP process: realistic string errors + schema assertion ---
  const realSuccess = await runBraveResearch(route, { query: "photosynthesis", client: clientFor("success"), sleep: noSleep });
  assert.equal(realSuccess.sources.length, 2);

  const realFlaky = await runBraveResearch(route, { query: "photosynthesis", client: clientFor("flaky-then-success", 2), sleep: noSleep });
  assert.equal(realFlaky.attempts.length, 3);
  assert.deepEqual(realFlaky.attempts.map((record) => record.errorCode), ["BRAVE_429", "BRAVE_429", null]);
  assert.equal(realFlaky.attempts[2]!.outcome, "completed");

  await assert.rejects(runBraveResearch(route, { query: "photosynthesis", client: clientFor("error-401"), sleep: noSleep }), (error: unknown) => {
    assert.ok(error instanceof BraveResearchUnavailableError);
    assert.equal(error.code, "BRAVE_401");
    assert.equal(error.attempts.length, 1);
    return true;
  });
  await assert.rejects(runBraveResearch(route, { query: "photosynthesis", client: clientFor("error-429"), sleep: noSleep }), (error: unknown) => {
    assert.ok(error instanceof BraveResearchUnavailableError);
    assert.equal(error.attempts.length, 5, "rate limits are retried through the full ladder");
    assert.ok(error.attempts.every((record) => record.errorCode === "BRAVE_429"));
    return true;
  });
  await assert.rejects(runBraveResearch(route, { query: "photosynthesis", client: clientFor("error-500"), sleep: noSleep }), (error: unknown) => {
    assert.ok(error instanceof BraveResearchUnavailableError);
    assert.equal(error.attempts.length, 5, "server errors are retried through the full ladder");
    assert.ok(error.attempts.every((record) => record.errorCode === "BRAVE_5XX"));
    return true;
  });
  await assert.rejects(runBraveResearch(route, { query: "photosynthesis", client: clientFor("schema-missing"), sleep: noSleep }), (error: unknown) => {
    assert.ok(error instanceof BraveSchemaDriftError, "a narrowed schema must fail loudly, not silently no-op the ladder");
    return true;
  });
  await assert.rejects(runBraveResearch(route, { query: "photosynthesis", client: clientFor("child-exit"), sleep: noSleep }), (error: unknown) => {
    assert.ok(error instanceof BraveCredentialError, "a child that dies at startup is a credential-class block, not a retry");
    return true;
  });
  console.log("  6. real fake MCP server: 401 terminal, 429 retried, schema drift blocked, child-exit credential-class.");

  // --- 7. Untrusted-input policy + provenance ---
  const longSnippets = ["Photosynthesis converts light energy into chemical energy. ".repeat(4).trim(), "Chlorophyll absorbs light and releases oxygen as a by-product. ".repeat(4).trim()];
  const candidate: BraveGroundingSource = { url: "https://www.example.edu/photosynthesis", title: "Photosynthesis", snippets: longSnippets };
  assert.equal(joinBraveSnippets([" a ", " b "]), "a b");
  const documents = assembleBraveDocuments([
    candidate,
    { url: "https://www.example.edu/photosynthesis", title: "dupe", snippets: longSnippets },
    { url: "http://insecure.example.edu/x", title: "insecure", snippets: longSnippets },
    { url: "https://short.example.edu/x", title: "short", snippets: ["too short"] },
  ]);
  assert.equal(documents.length, 1, "HTTPS-only, deduped, minimum length enforced");
  assert.equal(documents[0]!.sha256.length, 64);
  assert.equal(documents[0]!.sourceBytesSha256.length, 64);
  assert.ok(documents[0]!.byteSize >= 200);
  assert.ok(documents[0]!.retrievedUrl.startsWith("https://"));
  assert.notEqual(documents[0]!.sha256, documents[0]!.sourceBytesSha256);
  console.log("  7. policy: insecure/too-short/duplicate dropped; provenance hashes + byte size recorded.");

  // --- 8. Production segmentation tiles losslessly with citable marked overlap ---
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const sourceHash = "a".repeat(64);
  const text = "Photosynthesis converts light. ".repeat(400).trim();
  const { map, overlaps, primaryJoin } = buildSourceEvidenceMapWithOverlap([{ id: sourceId, sha256: sourceHash, extractedText: text }]);
  assert.equal(primaryJoin, text);
  assert.ok(map.sources[0]!.segments.length > 1);
  assert.ok(overlaps.length >= map.sources[0]!.segments.length - 1);
  assert.ok(overlaps.every((segment) => segment.overlap === true && segment.text.length <= 300));
  const merged = mergeOverlapSegments(map, overlaps);
  const mergedSegments = merged.sources[0]!.segments;
  assert.equal(mergedSegments.length, map.sources[0]!.segments.length + overlaps.length, "the persisted map carries primary + overlap segments");
  assert.ok(mergedSegments.some((segment) => segment.overlap === true), "overlap segments must be marked in the locked map");
  assert.ok(mergedSegments.some((segment) => !segment.overlap), "primary segments must remain unmarked");
  assert.ok(mergedSegments.every((segment) => segment.sourceId === sourceId && segment.sourceHash === sourceHash));
  console.log(`  8. segmentation (promoted): ${map.sources[0]!.segments.length} primary + ${overlaps.length} marked overlap, lossless, all citable.`);

  // --- 9. Full stage chain against the harness DB + fake MCP server ---
  await prepareHarness();
  const retrieved = await runBraveResearchHarness({ input: await buildRunInput("photosynthesis-sourceless"), scenario: "success" });
  assert.equal(retrieved.sourceCount, 2, "Brave sources must become source_documents rows");
  assert.ok(retrieved.evidenceMap, "a source-evidence-map must be saved");
  assert.ok(retrieved.factPack, "a fact-pack/v2 must be produced by the planning call");
  assert.equal(retrieved.factPack!.schemaVersion, "fact-pack/v2");
  assert.equal(retrieved.evidenceMap!.schemaVersion, "source-evidence-map/v1");
  assert.ok(retrieved.evidenceMap!.sources.flatMap((source) => source.segments).some((segment) => segment.overlap === true), "overlap context must be persisted and citable");
  for (const claim of retrieved.factPack!.claims) {
    const source = retrieved.evidenceMap!.sources.find((candidate) => candidate.sourceId === claim.evidence.sourceId && candidate.sourceHash === claim.evidence.sourceHash);
    assert.ok(source, `claim ${claim.id} cites an unknown source`);
    for (const segmentId of claim.evidence.segmentIds) assert.ok(source!.segments.some((segment) => segment.id === segmentId), `claim ${claim.id} cites missing segment ${segmentId}`);
  }
  console.log(`  9. stage chain: ${retrieved.sourceCount} source rows, schema-valid fact pack (${retrieved.factPack!.claims.length} claims), all citations resolve.`);

  // --- 10. Downstream adaptability: frozen Brave artifacts → s03 verifier resolves every claim ---
  const downstream = await runDownstreamVerificationHarness(retrieved.runId);
  assert.ok(downstream.verification, `s03 must consume the Brave output: ${downstream.failureMessage ?? ""}`);
  const verified = VerifiedFactPackSchema.parse(downstream.verification);
  assert.equal(verified.claims.length, retrieved.factPack!.claims.length);
  assert.equal(verified.omissions.length, 0, "no claim may be dropped when every claim resolves");
  console.log("  10. downstream: frozen Brave s02 output → s03 verified every claim (0 omissions).");

  const exhausted = await runBraveResearchHarness({ input: await buildRunInput("photosynthesis-sourceless"), scenario: "empty" });
  assert.equal(exhausted.sourceCount, 0);
  assert.equal(exhausted.failureMessage, "Something went wrong. Please try again later.");
  console.log("  10b. stage exhaustion: zero fabricated sources, client-safe failure message.");

  await closeQueue();
  await closeDb();
  console.log("s02 brave PASS");
  process.exit(0);
};

main().catch(async (error) => {
  console.error("s02 brave FAIL:", error);
  await closeQueue().catch(() => undefined);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
