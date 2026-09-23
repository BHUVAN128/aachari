import { describe, expect, it } from "vitest";
import { STAGE_ORDER } from "@upcraft/contracts";
import { stageHandlers, stageInputRoles } from "../src/pipeline/registry.ts";

/**
 * Structural guard for `video-generation-process.md` §13. The dependency graph
 * is data, so it can be asserted without running the pipeline. These tests keep a
 * future restructure from silently dropping a stage or weakening the declared
 * input order.
 */
describe("pipeline stage registry", () => {
  it("has a handler for every stage except executor-owned approval", () => {
    const expected = STAGE_ORDER.filter((stage) => stage !== "approval");
    expect(Object.keys(stageHandlers).sort()).toEqual([...expected].sort());
  });

  it("declares input roles for every stage that consumes locked upstream artifacts", () => {
    // research consumes the frozen source snapshot (hashed separately by
    // getStageInputHash), and preflight consumes only the run snapshot, so
    // neither has artifact input roles.
    const artifactFreeStages = new Set(["preflight", "research"]);
    for (const stage of Object.keys(stageHandlers)) {
      if (artifactFreeStages.has(stage)) {
        expect(stageInputRoles[stage as keyof typeof stageInputRoles], stage).toBeUndefined();
        continue;
      }
      expect(stageInputRoles[stage as keyof typeof stageInputRoles], stage).toBeDefined();
      expect(stageInputRoles[stage as keyof typeof stageInputRoles]!.length).toBeGreaterThan(0);
    }
  });

  it("keeps only known stage names in both tables", () => {
    for (const stage of [...Object.keys(stageHandlers), ...Object.keys(stageInputRoles)]) {
      expect(STAGE_ORDER).toContain(stage);
    }
  });

  it("never lets asset production read a downstream artifact or a pre-asset stage self-reference", () => {
    expect(stageInputRoles.assets).toEqual(["approved-script", "visual-bible", "lesson-blueprint", "verified-fact-pack"]);
  });

  it("makes every post-verification stage consume the verified fact pack, never the raw one", () => {
    expect(stageInputRoles.blueprint).toEqual(["verified-fact-pack"]);
    expect(stageInputRoles.script).toEqual(["lesson-blueprint", "verified-fact-pack"]);
    expect(stageInputRoles.qa).toContain("verified-fact-pack");
    for (const stage of ["blueprint", "script", "assets", "qa"] as const) {
      expect(stageInputRoles[stage]).not.toContain("fact-pack");
    }
  });

  it("runs the text chain in governing order and keeps QA before approval before final render", () => {
    const index = (stage: string) => STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
    expect(index("script")).toBeLessThan(index("visual-bible"));
    expect(index("visual-bible")).toBeLessThan(index("assets"));
    expect(index("assets")).toBeLessThan(index("spatial-layout"));
    expect(index("manifest")).toBeLessThan(index("preview-render"));
    expect(index("preview-render")).toBeLessThan(index("qa"));
    expect(index("qa")).toBeLessThan(index("approval"));
    expect(index("approval")).toBeLessThan(index("final-render"));
    expect(index("final-render")).toBeLessThan(index("release-record"));
  });

  it("requires the release record to depend on the final render, manifest, and QA report", () => {
    expect(stageInputRoles["release-record"]).toEqual(["final-render", "project-manifest", "qa-report"]);
  });
});