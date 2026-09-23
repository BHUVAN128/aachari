import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { FactPackSchema, SourceEvidenceMapSchema, type CreateRunInput, type FactPack, type SourceEvidenceMap } from "@upcraft/contracts";
import { artifacts, getDb, sourceDocuments } from "@upcraft/db";
import { createVideoRun, getRun } from "@upcraft/pipeline";
import { processPipelineStage } from "@upcraft/pipeline/pipeline";

/**
 * Sandbox runner for the source-less Brave research path.
 *
 * It drives the REAL production `runResearch` handler with the Brave MCP
 * transport pointed at the local fake server (`BRAVE_MCP_COMMAND=node`,
 * `BRAVE_MCP_ARGS=<fake-brave-mcp.ts>`). By default it also installs a
 * deterministic planning double that answers the OpenAI Responses request with a
 * schema-valid `fact-pack/v2` built from the segment ids in the real prompt, so
 * the full retrieval → segmentation → plan → citation-resolution chain is
 * exercised with zero network and zero keys.
 *
 * `runDownstreamVerificationHarness` clones a completed Brave run's locked
 * artifacts into a fresh frozen run and runs the real s03 verifier against a
 * deterministic verifier double, proving s03/s04/s05 consume Brave-sourced s02
 * output unchanged.
 */

type ArtifactRow = typeof artifacts.$inferSelect;

type SavedFetch = typeof globalThis.fetch;

const sourceBlocks = (prompt: string): Array<{ sourceId: string; sourceHash: string; segmentIds: string[] }> => {
  const blocks = [...prompt.matchAll(/SOURCE\s+([0-9a-f-]{36})\s+HASH\s+([0-9a-f]{64})([\s\S]*?)(?=SOURCE\s+[0-9a-f-]{36}\s+HASH|$)/g)];
  return blocks
    .map((match) => {
      const segmentIds = [...match[3]!.matchAll(/SEGMENT\s+(\S+)/g)].map((segment) => segment[1]!);
      return { sourceId: match[1]!, sourceHash: match[2]!, segmentIds };
    })
    .filter((block) => block.segmentIds.length > 0);
};

const promptFrom = (init: RequestInit | undefined): string => {
  try {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Array<{ content?: Array<{ text?: string }> }>; contents?: Array<{ parts?: Array<{ text?: string }> }> };
    return body.input?.[0]?.content?.[0]?.text ?? body.contents?.[0]?.parts?.[0]?.text ?? "";
  } catch {
    return "";
  }
};

const factPackFromPrompt = (prompt: string): FactPack => {
  const claims = sourceBlocks(prompt)
    .slice(0, 2)
    .map((block) => ({
      id: randomUUID(),
      text: "Photosynthesis converts light energy into chemical energy stored in glucose and releases oxygen.",
      evidence: { sourceId: block.sourceId, sourceHash: block.sourceHash, segmentIds: block.segmentIds.slice(0, 1), locator: "segment 0" },
      critical: true,
    }));
  if (!claims.length) throw new Error("deterministic planner found no citable segments in the prompt");
  return FactPackSchema.parse({ schemaVersion: "fact-pack/v2", claims, caveats: [] });
};

/** Deterministic OpenAI Responses double: echoes a valid fact pack built from the real prompt. */
export const installPlanningDouble = (): (() => void) => {
  const saved: SavedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("api.openai.com")) return saved(input, init);
    const factPack = factPackFromPrompt(promptFrom(init));
    const payload = { id: `resp_${randomUUID()}`, model: "gpt-5.6-terra", output_text: JSON.stringify(factPack), usage: { input_tokens: 1200, output_tokens: 300 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = saved;
  };
};

/** Deterministic Gemini verifier double: marks every supplied claim supported by its own cited segments. */
export const installVerifierDouble = (): (() => void) => {
  const saved: SavedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return saved(input, init);
    const prompt = promptFrom(init);
    const start = prompt.indexOf("{");
    const context = JSON.parse(prompt.slice(start)) as { claims: Array<{ id: string; evidence: { sourceId: string; segmentIds: string[] } }> };
    const verification = {
      schemaVersion: "claim-verification/v2",
      evidence: context.claims.map((claim) => ({ claimId: claim.id, sourceId: claim.evidence.sourceId, segmentIds: claim.evidence.segmentIds, supported: true, rationale: "deterministic sandbox verifier", notes: [] })),
      notes: [],
    };
    const payload = { responseId: `gemini_${randomUUID()}`, candidates: [{ content: { parts: [{ text: JSON.stringify(verification) }] } }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 120 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = saved;
  };
};

export type BraveHarnessResult = {
  runId: string;
  sourceCount: number;
  evidenceMap: SourceEvidenceMap | null;
  factPack: FactPack | null;
  failureMessage: string | null;
};

export const runBraveResearchHarness = async (params: { input: CreateRunInput; scenario?: string; planning?: "deterministic" | "live" }): Promise<BraveHarnessResult> => {
  const fakeServerPath = fileURLToPath(new URL("./fake-brave-mcp.ts", import.meta.url));
  const planning = params.planning ?? "deterministic";
  const saved = {
    command: process.env.BRAVE_MCP_COMMAND,
    args: process.env.BRAVE_MCP_ARGS,
    scenario: process.env.FAKE_BRAVE_SCENARIO,
    openai: process.env.OPENAI_API_KEY,
  };
  process.env.BRAVE_MCP_COMMAND = "node";
  process.env.BRAVE_MCP_ARGS = fakeServerPath;
  process.env.FAKE_BRAVE_SCENARIO = params.scenario ?? "success";
  if (planning === "deterministic") process.env.OPENAI_API_KEY = "sandbox-planning-double";
  const restoreFetch = planning === "deterministic" ? installPlanningDouble() : () => undefined;

  try {
    const runId = await createVideoRun(params.input);
    try {
      await processPipelineStage(runId, "research");
    } catch {
      // Transient provider failures are rethrown by the executor; the terminal
      // outcome is persisted on the run and read below.
    }
    const run = await getRun(runId);
    const rows = await getDb().select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
    const mapRow = await getDb().select().from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.role, "source-evidence-map"))).limit(1).then((result) => result[0]);
    const packRow = await getDb().select().from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.role, "fact-pack"))).limit(1).then((result) => result[0]);
    return {
      runId,
      sourceCount: rows.length,
      evidenceMap: mapRow?.content ? SourceEvidenceMapSchema.parse(mapRow.content) : null,
      factPack: packRow?.content ? FactPackSchema.parse(packRow.content) : null,
      failureMessage: run?.failureMessage ?? null,
    };
  } finally {
    restoreFetch();
    if (saved.command === undefined) delete process.env.BRAVE_MCP_COMMAND;
    else process.env.BRAVE_MCP_COMMAND = saved.command;
    if (saved.args === undefined) delete process.env.BRAVE_MCP_ARGS;
    else process.env.BRAVE_MCP_ARGS = saved.args;
    if (saved.scenario === undefined) delete process.env.FAKE_BRAVE_SCENARIO;
    else process.env.FAKE_BRAVE_SCENARIO = saved.scenario;
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.openai;
  }
};

const cloneLockedArtifacts = async (fromRunId: string, toRunId: string, roles: string[]): Promise<void> => {
  const db = getDb();
  const rows: ArtifactRow[] = await db.select().from(artifacts).where(and(eq(artifacts.runId, fromRunId), inArray(artifacts.role, roles)));
  if (!rows.length) throw new Error(`No locked artifacts to clone from ${fromRunId}`);
  await db.insert(artifacts).values(rows.map((row) => ({
    runId: toRunId, stage: row.stage, role: row.role, version: row.version, status: "valid" as const,
    schemaVersion: row.schemaVersion, content: row.content, sha256: row.sha256, inputHash: row.inputHash,
    provenance: row.provenance, validatedAt: new Date(),
  })));
};

/**
 * Downstream adaptability: clone a completed Brave run's locked s02 artifacts
 * into a fresh frozen run and run the real s03 verifier (with a deterministic
 * double). Every claim must resolve against the Brave-sourced evidence map.
 */
export const runDownstreamVerificationHarness = async (fromRunId: string): Promise<{ runId: string; verification: Record<string, unknown> | null; failureMessage: string | null }> => {
  const savedGemini = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = savedGemini ?? "sandbox-verifier-double";
  const restoreFetch = installVerifierDouble();
  try {
    const newRunId = await createVideoRun({
      topic: "Brave downstream verification",
      learningLevel: "Primary school, ages 9-11",
      audienceCategory: "school",
      language: "en",
      durationSeconds: 120,
      aspectRatio: "16:9",
      domain: "standard",
      visualProfile: "clean whiteboard science explainer",
      requestedDestination: "local",
      sources: [],
    });
    await cloneLockedArtifacts(fromRunId, newRunId, ["source-evidence-map", "fact-pack"]);
    try {
      await processPipelineStage(newRunId, "fact-verification");
    } catch {
      // Terminal outcomes are persisted on the run and read below.
    }
    const run = await getRun(newRunId);
    const row = await getDb().select().from(artifacts).where(and(eq(artifacts.runId, newRunId), eq(artifacts.role, "verified-fact-pack"))).limit(1).then((result) => result[0]);
    return { runId: newRunId, verification: (row?.content as Record<string, unknown> | undefined) ?? null, failureMessage: run?.failureMessage ?? null };
  } finally {
    restoreFetch();
    if (savedGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedGemini;
  }
};
