import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { SourceEvidenceMapSchema, type CreateRunInput, type SourceEvidenceMap } from "@upcraft/contracts";
import { artifacts, getDb, sourceDocuments } from "@upcraft/db";
import { createVideoRun, getRun } from "@upcraft/pipeline";
import { processPipelineStage } from "@upcraft/pipeline/pipeline";

/**
 * Sandbox runner for the source-less Brave research half of s02.
 *
 * It drives the REAL production `runResearch` handler with the official Brave
 * MCP transport pointed at the local fake server
 * (`BRAVE_MCP_COMMAND=node`, `BRAVE_MCP_ARGS=<fake-brave-mcp.ts>`). The planning
 * call needs `OPENAI_API_KEY`, which is deliberately removed for the deterministic
 * run: retrieval, `source_documents` insertion, and the deterministic
 * source-evidence map are all persisted before the planning call, so the test can
 * assert them without touching the network.
 *
 * When the planning key is present the run completes and the caller can assert the
 * fact pack too (the live-green checkbox).
 */
export type BraveHarnessResult = {
  runId: string;
  sourceCount: number;
  evidenceMap: SourceEvidenceMap | null;
  failureMessage: string | null;
};

export const runBraveResearchHarness = async (params: { input: CreateRunInput; scenario?: string }): Promise<BraveHarnessResult> => {
  const fakeServerPath = fileURLToPath(new URL("./fake-brave-mcp.ts", import.meta.url));
  const saved = {
    command: process.env.BRAVE_MCP_COMMAND,
    args: process.env.BRAVE_MCP_ARGS,
    scenario: process.env.FAKE_BRAVE_SCENARIO,
    openai: process.env.OPENAI_API_KEY,
  };
  process.env.BRAVE_MCP_COMMAND = "node";
  process.env.BRAVE_MCP_ARGS = fakeServerPath;
  process.env.FAKE_BRAVE_SCENARIO = params.scenario ?? "success";
  delete process.env.OPENAI_API_KEY;

  try {
    const runId = await createVideoRun(params.input);
    try {
      await processPipelineStage(runId, "research");
    } catch {
      // A transient provider failure is rethrown by the executor; the terminal
      // outcome is still persisted on the run, which is read below.
    }
    const run = await getRun(runId);
    const rows = await getDb().select().from(sourceDocuments).where(eq(sourceDocuments.runId, runId));
    const mapRow = await getDb()
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.role, "source-evidence-map")))
      .limit(1)
      .then((result) => result[0]);
    const evidenceMap = mapRow?.content ? SourceEvidenceMapSchema.parse(mapRow.content) : null;
    return { runId, sourceCount: rows.length, evidenceMap, failureMessage: run?.failureMessage ?? null };
  } finally {
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
