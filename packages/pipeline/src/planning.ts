import {
  DiagramModelSchema,
  SceneAssetBriefBundleSchema,
  SceneAssetBriefSchema,
  ScenePlanBundleSchema,
  ScenePlanSchema,
  type ApprovedScript,
  type Blueprint,
  type DiagramModel,
  type FactPack,
  type SceneAssetBrief,
  type ScenePlan,
} from "@upcraft/contracts";

/**
 * Deterministic scene planning: the scene plan, asset brief, and diagram model
 * for every narrated scene are derived only from locked artifacts (verified fact
 * pack, lesson blueprint, approved script). No model call is needed and no label
 * can be invented, which is what keeps factual diagrams source-grounded.
 */
export type SceneDirection = {
  sceneId: string;
  purpose: string;
  visualBeat: string;
  visualAction: string;
  narrationText: string;
  claimIds: string[];
  claimTexts: string[];
};

const MAX_LABEL_LENGTH = 46;
const MAX_LABELS = 6;

/** Lowercased word vocabulary used to prove a label was taken from locked text. */
export const lockedWordVocabulary = (texts: string[]) => {
  const words = new Set<string>();
  for (const text of texts) {
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (token) words.add(token);
  }
  return words;
};

const clauseCandidates = (text: string) =>
  text
    .split(/[\n.;:!?]|,\s|\s(?:and|then|because|which|that|while|so|becomes?|converts?|produces?|transfers?|releases?|absorbs?|forms?|creates?|combines?)\s/i)
    .map((clause) => clause.replace(/\s+/g, " ").trim())
    .filter((clause) => clause.length >= 3);

const numbersIn = (text: string) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map((value) => Number(value)).filter((value) => Number.isFinite(value));

const trimLabel = (value: string) => {
  const collapsed = value.replace(/\s+/g, " ").trim().replace(/^[-–—•]+/, "").trim();
  if (collapsed.length <= MAX_LABEL_LENGTH) return collapsed;
  return collapsed.slice(0, MAX_LABEL_LENGTH).replace(/\s+\S*$/, "").trim();
};

const collectClauseLabels = (sources: string[]) => {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const clause of clauseCandidates(source)) {
      const label = trimLabel(clause);
      const key = label.toLowerCase();
      if (label.length < 3 || seen.has(key)) continue;
      seen.add(key);
      labels.push(label);
    }
  }
  return labels;
};

/**
 * Prefers verified claim text over narration and never rewrites a clause into
 * new wording. Narration is only a fallback when no verified claim clause is
 * usable, so a diagram label always originates from source-grounded evidence.
 */
export const pickLabels = (claimTexts: string[], narrationText: string, limit = MAX_LABELS) => {
  const fromClaims = collectClauseLabels(claimTexts);
  const pool = fromClaims.length ? fromClaims : collectClauseLabels([narrationText]);
  return pool.sort((a, b) => a.length - b.length).slice(0, limit);
};

/** Numeric values must be literally present in locked text; nothing is computed. */
export const pickChartPairs = (texts: string[]) => {
  const pairs: Array<{ label: string; value: number }> = [];
  for (const text of texts) {
    for (const clause of clauseCandidates(text)) {
      const values = numbersIn(clause);
      if (values.length !== 1) continue;
      const withoutNumber = trimLabel(clause.replace(/-?\d+(?:\.\d+)?/g, " ").replace(/\s+/g, " ").trim());
      if (withoutNumber.length < 3) continue;
      pairs.push({ label: withoutNumber, value: values[0]! });
    }
  }
  return pairs.slice(0, MAX_LABELS);
};

/**
 * Only an expression that already exists verbatim in locked text is used. An
 * operand is joined to the next by a math operator, so trailing prose after the
 * expression ("... is the relationship") is never swallowed into the equation.
 */
const OPERAND = String.raw`[^\s=()]+`;
const EXPRESSION_PATTERN = new RegExp(
  `(${OPERAND}(?:\\s*[-+*/^]\\s*${OPERAND})*)\\s*=\\s*(${OPERAND}(?:\\s*[-+*/^]\\s*${OPERAND})*)`,
  "u",
);

export const pickExpression = (texts: string[]) => {
  for (const text of texts) {
    const match = EXPRESSION_PATTERN.exec(text);
    if (!match) continue;
    const expression = match[0].replace(/\s+/g, " ").trim();
    if (expression.length >= 3 && expression.length <= 240) return expression;
  }
  return undefined;
};

const processPattern = /\b(process|step|stage|stages|flow|cycle|sequence|first|then|next|becomes|converts|produces|transfers|moves)\b/i;
const comparisonPattern = /\b(compare|comparison|versus|vs\.?|difference|differences|contrast|unlike|whereas|instead)\b/i;
const systemPattern = /\b(system|structure|parts|anatomy|labelled|labeled|components|organ|organelle|circuit|diagram|model)\b/i;
const chartPattern = /\b(chart|graph|trend|data|percent|percentage|rate|measured|increases|decreases|higher|lower|amount)\b/i;

export const classifyDiagramKind = (params: {
  directionText: string;
  labels: string[];
  chartPairs: Array<{ label: string; value: number }>;
  expression?: string;
}): DiagramModel["kind"] => {
  const { directionText, labels, chartPairs, expression } = params;
  if (expression && labels.length >= 1) return "equation";
  if (chartPairs.length >= 2 && chartPattern.test(directionText)) return "chart";
  if (labels.length >= 2 && comparisonPattern.test(directionText)) return "comparison";
  if (labels.length >= 2 && systemPattern.test(directionText)) return "labelled-system";
  if (labels.length >= 2 && processPattern.test(directionText)) return "process";
  if (labels.length >= 2) return "process";
  return "none";
};

/** Plate identities are a deterministic function of the diagram kind and size. */
export const expectedPlateIds = (model: Pick<DiagramModel, "kind" | "labels" | "values">) => {
  switch (model.kind) {
    case "process": return model.labels.map((_, index) => `step-${index}`);
    case "comparison": return ["column-0", "column-1"];
    case "equation": return ["expression", ...model.labels.slice(0, 4).map((_, index) => `term-${index}`)];
    case "chart": return model.values.map((_, index) => `bar-${index}`);
    case "labelled-system": return ["system", ...model.labels.slice(1, 5).map((_, index) => `entity-${index}`)];
    case "none": return ["concept"];
  }
};

export const buildSceneDirections = (params: { blueprint: Blueprint; script: ApprovedScript; factPack: FactPack }): SceneDirection[] => {
  const claimText = new Map(params.factPack.claims.map((claim) => [claim.id, claim.text]));
  return params.blueprint.scenes
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((scene) => {
      const lines = params.script.narration.filter((line) => line.sceneId === scene.id);
      const claimIds = [...new Set([...scene.claimIds, ...lines.flatMap((line) => line.claimIds)])];
      return {
        sceneId: scene.id,
        purpose: scene.purpose,
        visualBeat: scene.visualBeat,
        visualAction: lines.map((line) => line.visualAction).join(" ").trim() || scene.visualBeat,
        narrationText: lines.map((line) => line.text).join(" ").trim(),
        claimIds,
        claimTexts: claimIds.map((id) => claimText.get(id)).filter((text): text is string => Boolean(text)),
      };
    });
};

/** Builds the typed asset brief and diagram model for one locked scene. */
export const buildSceneAssetBrief = (direction: SceneDirection): { brief: SceneAssetBrief; model: DiagramModel } => {
  const labels = pickLabels(direction.claimTexts, direction.narrationText);
  const directionText = `${direction.purpose} ${direction.visualBeat} ${direction.visualAction}`;
  const chartPairs = pickChartPairs([...direction.claimTexts, direction.narrationText]);
  const expression = pickExpression(direction.claimTexts);
  const kind = classifyDiagramKind({ directionText, labels, chartPairs, ...(expression ? { expression } : {}) });
  const effectiveLabels = kind === "chart" ? chartPairs.map((pair) => pair.label) : labels;
  const model = DiagramModelSchema.parse({
    schemaVersion: "diagram-model/v1",
    sceneId: direction.sceneId,
    kind,
    title: trimLabel(direction.purpose) || trimLabel(direction.visualBeat) || "Lesson scene",
    labels: effectiveLabels,
    values: kind === "chart" ? chartPairs.map((pair) => pair.value) : [],
    ...(kind === "equation" && expression ? { expression } : {}),
    claimIds: direction.claimIds,
  });
  const brief = SceneAssetBriefSchema.parse({
    schemaVersion: "scene-asset-brief/v1",
    sceneId: direction.sceneId,
    purpose: direction.purpose,
    claimIds: direction.claimIds,
    diagram: {
      kind,
      title: model.title,
      labels: model.labels,
      ...(model.values.length ? { values: model.values } : {}),
    },
    // Illustration stays an explicitly recorded optional: factual labels are
    // always drawn by typed SVG, never by an image model.
    illustration: {
      required: false,
      prompt: `Optional illustration supporting the scene purpose: ${direction.purpose}`,
      role: "none",
      prohibitedText: true,
    },
  });
  return { brief, model };
};

/** Scene relations encode layout invariants, so the solver never guesses pixels. */
export const buildScenePlan = (model: DiagramModel): ScenePlan => {
  const plates = expectedPlateIds(model);
  const relations: ScenePlan["relations"] = [];
  for (let left = 0; left < plates.length; left += 1) {
    for (let right = left + 1; right < plates.length; right += 1) {
      relations.push({ relation: "must-not-overlap", subject: plates[left]!, target: plates[right]! });
    }
  }
  if (model.kind === "process") {
    for (let index = 0; index < plates.length - 1; index += 1) {
      relations.push({ relation: "right-of", subject: plates[index + 1]!, target: plates[index]!, targetAnchor: "right" });
    }
  }
  if (model.kind === "comparison") relations.push({ relation: "right-of", subject: "column-1", target: "column-0", targetAnchor: "right" });
  if (model.kind === "labelled-system") {
    for (const entity of plates.filter((plate) => plate.startsWith("entity-"))) {
      relations.push({ relation: "attach", subject: entity, target: "system", targetAnchor: "center" });
    }
  }
  if (model.kind === "equation") {
    for (const term of plates.filter((plate) => plate.startsWith("term-"))) {
      relations.push({ relation: "below", subject: term, target: "expression", targetAnchor: "center" });
    }
  }
  return ScenePlanSchema.parse({ schemaVersion: "scene-plan/v1", sceneId: model.sceneId, relations });
};

export const buildScenePlans = (models: DiagramModel[]) => ScenePlanBundleSchema.parse({ schemaVersion: "scene-plan-bundle/v1", plans: models.map(buildScenePlan) });

export const buildSceneAssetBriefs = (briefs: SceneAssetBrief[]) =>
  SceneAssetBriefBundleSchema.parse({ schemaVersion: "scene-asset-brief-bundle/v1", briefs });
