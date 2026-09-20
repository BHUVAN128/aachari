import { describe, expect, it } from "vitest";
import { ApprovedScriptSchema, BlueprintSchema, FactPackSchema } from "@upcraft/contracts";
import { buildSceneAssetBrief, buildSceneAssetBriefs, buildSceneDirections, buildScenePlan, buildScenePlans, buildSoundPlan, classifyDiagramKind, decideIllustration, expectedPlateIds, lockedWordVocabulary, pickChartPairs, pickExpression, pickLabels } from "../src/planning.ts";
import { renderDiagramSvg, type DiagramPalette } from "@upcraft/compositor";

const sourceId = "11111111-1111-4111-8111-111111111111";
const sceneId = "22222222-2222-4222-8222-222222222222";
const lineId = "33333333-3333-4333-8333-333333333333";
const claimId = "44444444-4444-4444-8444-444444444444";
const sourceHash = "a".repeat(64);

const policyPalette: DiagramPalette = {
  canvasTexture: "#f1f5f9",
  palette: ["#1d4ed8", "#b45309"],
  typography: { heading: "Arial", body: "Arial" },
};

const claim = (text: string, id = claimId) => ({ id, text, evidence: { sourceId, sourceHash, segmentIds: ["segment-one"], locator: "p1" }, critical: true });

const factPack = FactPackSchema.parse({ schemaVersion: "fact-pack/v2", claims: [claim("Light energy becomes chemical energy in the leaf")], caveats: [] });
const blueprint = BlueprintSchema.parse({ schemaVersion: "lesson-blueprint/v2", objective: "Explain photosynthesis", prerequisites: ["none required"], hook: "Why do leaves need light?", recap: "Light energy becomes chemical energy.", scenes: [{ id: sceneId, order: 0, purpose: "Show light energy becoming chemical energy", claimIds: [claimId], visualBeat: "Light energy becomes chemical energy" }] });
const script = ApprovedScriptSchema.parse({ schemaVersion: "approved-script/v2", narration: [{ id: lineId, sceneId, text: "Light energy becomes chemical energy in the leaf.", claimIds: [claimId], visualAction: "Reveal each step of the process" }] });

describe("locked-vocabulary label selection", () => {
  it("builds the allowed vocabulary only from locked text", () => {
    const vocabulary = lockedWordVocabulary(["Light energy becomes chemical energy"]);
    expect(vocabulary.has("chemical")).toBe(true);
    expect(vocabulary.has("photosynthesis")).toBe(false);
  });

  it("prefers verified claim clauses and never rewrites them", () => {
    const labels = pickLabels(["Light energy becomes chemical energy in the leaf"], "Unrelated narration sentence.", 3);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect("light energy becomes chemical energy in the leaf").toContain(label.toLowerCase());
  });

  it("copies chart values instead of computing them", () => {
    const pairs = pickChartPairs(["Light energy is 12 units", "Chemical energy is 30 units", "The total is 42 units"]);
    expect(pairs.map((pair) => pair.value)).toEqual([12, 30, 42]);
    expect(pairs.every((pair) => !/\d/.test(pair.label))).toBe(true);
  });

  it("only accepts an expression that already exists verbatim", () => {
    expect(pickExpression(["force = mass * acceleration is the relationship"])).toBe("force = mass * acceleration");
    expect(pickExpression(["no expression here at all"])).toBeUndefined();
  });

  it("classifies diagram kinds conservatively from locked text", () => {
    expect(classifyDiagramKind({ directionText: "compare the two options", labels: ["first", "second"], chartPairs: [] })).toBe("comparison");
    expect(classifyDiagramKind({ directionText: "show the process step by step", labels: ["first", "second"], chartPairs: [] })).toBe("process");
    expect(classifyDiagramKind({ directionText: "label the parts of the system", labels: ["leaf", "vein"], chartPairs: [] })).toBe("labelled-system");
    expect(classifyDiagramKind({ directionText: "show a chart of the rate", labels: ["light", "chemical"], chartPairs: [{ label: "light", value: 1 }, { label: "chemical", value: 2 }] })).toBe("chart");
    expect(classifyDiagramKind({ directionText: "show the relationship", labels: ["mass"], chartPairs: [], expression: "force = mass" })).toBe("equation");
    expect(classifyDiagramKind({ directionText: "introduce the topic", labels: ["Light energy"], chartPairs: [] })).toBe("none");
  });
describe("scene direction and asset briefs", () => {
  it("derives one direction per blueprint scene from locked artifacts", () => {
    const directions = buildSceneDirections({ blueprint, script, factPack });
    expect(directions).toHaveLength(1);
    expect(directions[0]).toMatchObject({ sceneId, claimIds: [claimId], claimTexts: [factPack.claims[0]!.text] });
  });

  it("records illustration as an explicit optional fallback, never a silent omission", () => {
    const [direction] = buildSceneDirections({ blueprint, script, factPack });
    const { brief, model } = buildSceneAssetBrief(direction!);
    expect(brief.illustration.required).toBe(false);
    expect(brief.illustration.prohibitedText).toBe(true);
    expect(brief.diagram.kind).toBe(model.kind);
    expect(brief.diagram.labels.every((label) => model.labels.includes(label))).toBe(true);
  });

  it("emits typed scene-plan and brief bundles with the governed schema versions", () => {
    const [direction] = buildSceneDirections({ blueprint, script, factPack });
    const { brief, model } = buildSceneAssetBrief(direction!);
    expect(buildScenePlans([model]).schemaVersion).toBe("scene-plan-bundle/v1");
    expect(buildSceneAssetBriefs([brief]).schemaVersion).toBe("scene-asset-brief-bundle/v1");
    expect(buildScenePlans([model]).plans[0]!.sceneId).toBe(sceneId);
  });

  it("declares plate identities that match what the renderer actually draws", () => {
    const [direction] = buildSceneDirections({ blueprint, script, factPack });
    const { model } = buildSceneAssetBrief(direction!);
    const { layout } = renderDiagramSvg(model, policyPalette, { width: 1920, height: 1080 }, { x: 230, y: 302, width: 1459, height: 518 });
    expect(layout.plates.map((plate) => plate.id)).toEqual(expectedPlateIds(model));
  });

  it("records must-not-overlap and ordering invariants in the scene plan", () => {
    const [direction] = buildSceneDirections({ blueprint, script, factPack });
    const { model } = buildSceneAssetBrief(direction!);
    const plan = buildScenePlan(model);
    const plateIds = expectedPlateIds(model);
    expect(plan.schemaVersion).toBe("scene-plan/v1");
    expect(plan.relations.some((relation) => relation.relation === "must-not-overlap")).toBe(true);
    expect(plan.relations.every((relation) => plateIds.includes(relation.subject) && plateIds.includes(relation.target))).toBe(true);
  });
});
});

describe("optional illustration and sound planning", () => {
  const [direction] = buildSceneDirections({ blueprint, script, factPack });

  it("only recommends an illustration when a locked character is referenced and no diagram exists", () => {
    const character = { id: "mascot", description: "A friendly student character named Ada" };
    const withDiagram = decideIllustration({ direction: direction!, kind: "process", persistentEntities: [character] });
    expect(withDiagram.required).toBe(false);
    expect(withDiagram.role).toBe("none");

    const noEntity = decideIllustration({ direction: direction!, kind: "none", persistentEntities: [{ id: "leaf", description: "A green leaf object" }] });
    expect(noEntity.required).toBe(false);

    const concept = { ...direction!, purpose: "Meet the student Ada as she explores", visualBeat: "A student character appears", narrationText: "Ada the student looks at the leaf." };
    const recommended = decideIllustration({ direction: concept, kind: "none", persistentEntities: [character] });
    expect(recommended).toMatchObject({ required: true, role: "character", entityId: "mascot" });
  });

  it("records the illustration decision on the brief instead of a silent omission", () => {
    const { brief } = buildSceneAssetBrief(direction!, { persistentEntities: [{ id: "mascot", description: "A student character named Ada" }] });
    expect(brief.illustration.reason).toBeTruthy();
    expect(brief.illustration.prohibitedText).toBe(true);
  });

  it("emits an explicit per-scene sound plan with ducking recorded", () => {
    const plan = buildSoundPlan([direction!]);
    expect(plan.schemaVersion).toBe("sound-plan/v1");
    expect(plan.ducking.musicGainDb).toBeLessThan(plan.ducking.narrationGainDb);
    expect(plan.scenes).toHaveLength(1);
    expect(plan.scenes[0]!.music.choice).toBe("omitted");
    expect(plan.scenes[0]!.music.reason).toBeTruthy();
  });
});