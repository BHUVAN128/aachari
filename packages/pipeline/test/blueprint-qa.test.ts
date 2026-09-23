import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BlueprintV2Schema, type Blueprint } from "@upcraft/contracts";
import {
  blueprintInputHash,
  criticalClaimBudget,
  sceneBoundsFor,
  validateBlueprint,
  validateClaimBudget,
  validateClaimsPerScene,
  validateSceneDensity,
  validateVisualBeat,
  validateVisualBeats,
} from "../src/blueprint-qa.ts";

const sceneA = "22222222-2222-4222-8222-222222222222";
const sceneB = "33333333-3333-4333-8333-333333333333";
const claimA = "44444444-4444-4444-8444-444444444444";
const claimB = "55555555-5555-4555-8555-555555555555";
const claimC = "66666666-6666-4666-8666-666666666666";

const base: Blueprint = BlueprintV2Schema.parse({
  schemaVersion: "lesson-blueprint/v2",
  objective: "Explain photosynthesis",
  prerequisites: ["none required"],
  hook: "Why do leaves need light?",
  recap: "Light energy becomes chemical energy.",
  scenes: [
    { id: sceneA, order: 0, purpose: "Introduce light energy", claimIds: [claimA], visualBeat: "Light arrives" },
    { id: sceneB, order: 1, purpose: "Show energy conversion", claimIds: [claimB], visualBeat: "Energy converts" },
  ],
});

const allowed = new Set([claimA, claimB, claimC]);
const validate = (blueprint: Blueprint) => validateBlueprint({ blueprint, criticalClaimIds: [claimA, claimB], allowedClaimIds: allowed });

describe("blueprint validation", () => {
  it("accepts a complete v2 blueprint that covers every critical claim in order", () => {
    expect(validate(base)).toEqual([]);
  });

  it("requires the hook, recap, and learner prerequisites from Stage 3", () => {
    const rules = validate({ ...base, hook: "  ", recap: "", prerequisites: [] }).map((issue) => issue.rule);
    expect(rules).toEqual(expect.arrayContaining(["blueprint-hook-missing", "blueprint-recap-missing", "blueprint-prerequisites-missing"]));
  });

  it("requires strictly increasing scene order and unique scene identities", () => {
    const rules = validate({ ...base, scenes: [base.scenes[0]!, { ...base.scenes[1]!, order: 0 }] }).map((issue) => issue.rule);
    expect(rules).toContain("blueprint-scene-order");
    const duplicate = validate({ ...base, scenes: [base.scenes[0]!, { ...base.scenes[1]!, id: sceneA }] }).map((issue) => issue.rule);
    expect(duplicate).toContain("blueprint-scene-id-duplicate");
  });

  it("requires every scene to cite a claim locked in the fact pack", () => {
    const rules = validate({ ...base, scenes: [{ ...base.scenes[0]!, claimIds: [] }, { ...base.scenes[1]!, claimIds: ["99999999-9999-4999-8999-999999999999"] }] }).map((issue) => issue.rule);
    expect(rules).toContain("blueprint-scene-claim-missing");
    expect(rules).toContain("blueprint-claim-reference-invalid");
  });

  it("fails objective coverage when a critical claim has no scene", () => {
    const issues = validate({ ...base, scenes: [base.scenes[0]!] });
    expect(issues.map((issue) => issue.rule)).toContain("blueprint-objective-coverage");
    expect(issues.find((issue) => issue.rule === "blueprint-objective-coverage")?.evidence).toMatchObject({ uncoveredCritical: [claimB] });
  });

  it("checks that a knowledge-check answer points at one of its options", () => {
    const issues = validate({ ...base, knowledgeCheck: { question: "What carries energy?", options: ["light", "sound"], answerIndex: 4 } });
    expect(issues.map((issue) => issue.rule)).toContain("blueprint-knowledge-check-answer");
  });
});

describe("scene density", () => {
  it("computes the 6-20s corridor per duration", () => {
    expect(sceneBoundsFor(30)).toEqual({ minScenes: 1, maxScenes: 5 });
    expect(sceneBoundsFor(120)).toEqual({ minScenes: 6, maxScenes: 20 });
    expect(sceneBoundsFor(600)).toEqual({ minScenes: 30, maxScenes: 100 });
  });

  it("passes an in-corridor scene count and flags too few or too many", () => {
    expect(validateSceneDensity({ sceneCount: 12, durationSeconds: 120 })).toEqual([]);
    expect(validateSceneDensity({ sceneCount: 5, durationSeconds: 120 }).map((issue) => issue.rule)).toEqual(["blueprint-scene-density-low"]);
    expect(validateSceneDensity({ sceneCount: 21, durationSeconds: 120 }).map((issue) => issue.rule)).toEqual(["blueprint-scene-density-high"]);
    expect(validateSceneDensity({ sceneCount: 10, durationSeconds: 600 }).map((issue) => issue.rule)).toEqual(["blueprint-scene-density-low"]);
    expect(validateSceneDensity({ sceneCount: 8, durationSeconds: 30 }).map((issue) => issue.rule)).toEqual(["blueprint-scene-density-high"]);
  });
});

describe("critical-claim budget", () => {
  it("allows 8 critical claims per minute and rejects an over-budget set without pruning", () => {
    expect(criticalClaimBudget(60)).toBe(8);
    expect(criticalClaimBudget(120)).toBe(16);
    expect(validateClaimBudget({ criticalClaimCount: 8, durationSeconds: 60 })).toEqual([]);
    const exceeded = validateClaimBudget({ criticalClaimCount: 25, durationSeconds: 60 });
    expect(exceeded.map((issue) => issue.rule)).toEqual(["blueprint-claim-budget-exceeded"]);
    expect(exceeded[0]?.evidence).toMatchObject({ criticalClaimCount: 25, budget: 8 });
    expect(exceeded[0]?.remediation).toMatch(/never dropped/);
  });

  it("flags a scene that carries more than three claims", () => {
    expect(validateClaimsPerScene({ scenes: [{ id: sceneA, claimIds: [claimA, claimB, claimC] }] })).toEqual([]);
    const crowded = validateClaimsPerScene({ scenes: [{ id: sceneB, claimIds: [claimA, claimB, claimC, claimA] }] });
    expect(crowded.map((issue) => issue.rule)).toEqual(["blueprint-scene-claim-overcrowded"]);
    expect(crowded[0]?.evidence).toMatchObject({ sceneId: sceneB, claimCount: 4 });
  });
});

describe("visual-beat validation", () => {
  it("rejects a non-English beat, a vague beat, and a non-directive beat", () => {
    expect(validateVisualBeat("\u0b87\u0bb2\u0bc8 \u0b92\u0bb3\u0bbf\u0b9a\u0bcd\u0b9a\u0bc7\u0bb0\u0bcd\u0b95\u0bcd\u0b95\u0bc8\u0baf\u0bc8 \u0bb5\u0bbf\u0bb3\u0b95\u0bcd\u0b95\u0bc1\u0b95\u0bbf\u0bb1\u0ba4\u0bc1").map((issue) => issue.rule)).toEqual(["blueprint-visual-beat-localized"]);
    expect(validateVisualBeat("Show video").map((issue) => issue.rule)).toEqual(["blueprint-visual-beat-vague"]);
    expect(validateVisualBeat("The process explains how plants make sugar from light").map((issue) => issue.rule)).toEqual(["blueprint-visual-beat-nonDirective"]);
  });

  it("accepts a directed English beat and does not flag Greek scientific notation", () => {
    expect(validateVisualBeat("Reveal the leaf cross-section, then trace light energy into the chloroplast")).toEqual([]);
    expect(validateVisualBeat("Label the \u03b2-carbon on the glucose ring")).toEqual([]);
  });

  it("tags each finding with its scene id", () => {
    const issues = validateVisualBeats({ scenes: [{ id: sceneA, visualBeat: "Show it" }] });
    expect(issues[0]?.evidence).toMatchObject({ sceneId: sceneA });
  });
});

describe("composite input hash", () => {
  it("binds the fact pack and the frozen snapshot and differs from the fact-pack-only hash", () => {
    const factPack = { schemaVersion: "verified-fact-pack/v1", claims: [{ id: claimA }] };
    const snapshotHash = "a".repeat(64);
    const factPackOnly = createHash("sha256").update(JSON.stringify(factPack)).digest("hex");
    expect(blueprintInputHash(factPack, snapshotHash)).toBe(blueprintInputHash(factPack, snapshotHash));
    expect(blueprintInputHash(factPack, snapshotHash)).not.toBe(blueprintInputHash(factPack, "b".repeat(64)));
    expect(blueprintInputHash(factPack, snapshotHash)).not.toBe(blueprintInputHash({ ...factPack, claims: [] }, snapshotHash));
    expect(blueprintInputHash(factPack, snapshotHash)).not.toBe(factPackOnly);
  });
});
