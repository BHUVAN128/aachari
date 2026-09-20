import { describe, expect, it } from "vitest";
import { BlueprintV2Schema, type Blueprint } from "@upcraft/contracts";
import { validateBlueprint } from "../src/blueprint-qa.ts";

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
