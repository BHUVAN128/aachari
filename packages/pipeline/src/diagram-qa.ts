import { contrastRatio, estimatedTextWidth, plateOverlaps, renderDiagramSvg, type DiagramArea, type DiagramCanvas, type DiagramLayout, type DiagramPalette } from "@upcraft/compositor";
import type { DiagramModel } from "@upcraft/contracts";
import { expectedPlateIds, lockedWordVocabulary } from "./planning.ts";

/** Benchmark gate: legible labels and no misleading diagrams. */
export const MIN_LABEL_CONTRAST = 4.5;
export const LABEL_PADDING = 28;

export type DiagramIssue = { rule: string; evidence: Record<string, unknown>; remediation: string };

const tokensIn = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const numbersOf = (value: string) => (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map((entry) => Number(entry));

/**
 * Model-level checks. Every word a learner sees must already exist in the locked
 * source/claim/script corpus, so a diagram can never introduce a new fact label.
 */
export const validateDiagramModel = (params: {
  model: DiagramModel;
  lockedTexts: string[];
  allowedClaimIds: Set<string>;
}): DiagramIssue[] => {
  const { model, lockedTexts } = params;
  const issues: DiagramIssue[] = [];
  const vocabulary = lockedWordVocabulary(lockedTexts);
  const lockedText = lockedTexts.join("\n");

  const fields: Array<[string, string]> = [["title", model.title], ...model.labels.map((label, index) => [`labels[${index}]`, label] as [string, string])];
  for (const [field, value] of fields) {
    const unknown = tokensIn(value).filter((token) => !vocabulary.has(token));
    if (unknown.length) {
      issues.push({
        rule: "diagram-label-not-in-locked-vocabulary",
        evidence: { field, value, unknown },
        remediation: "Rebuild the scene asset brief from the locked fact pack and script; never invent a diagram label.",
      });
    }
  }

  if (model.expression) {
    const normalizedExpression = model.expression.replace(/\s+/g, " ").trim();
    const normalizedLocked = lockedText.replace(/\s+/g, " ");
    if (!normalizedLocked.includes(normalizedExpression)) {
      issues.push({
        rule: "diagram-expression-not-locked",
        evidence: { expression: model.expression },
        remediation: "Only render an equation that appears verbatim in locked source or claim text.",
      });
    }
  }

  const lockedNumbers = new Set(numbersOf(lockedText));
  for (const value of model.values) {
    if (!lockedNumbers.has(value)) {
      issues.push({
        rule: "diagram-value-not-in-locked-source",
        evidence: { value },
        remediation: "Chart values must be copied from locked source text; never compute or estimate a plotted value.",
      });
    }
  }

  const unknownClaims = model.claimIds.filter((id) => !params.allowedClaimIds.has(id));
  if (unknownClaims.length) {
    issues.push({
      rule: "diagram-claim-reference-invalid",
      evidence: { unknownClaims },
      remediation: "Reference only claim IDs locked in the verified fact pack.",
    });
  }

  if (model.kind !== "none" && model.kind !== "chart" && model.labels.length < 2) {
    issues.push({
      rule: "diagram-under-specified",
      evidence: { kind: model.kind, labels: model.labels.length },
      remediation: "Use a semantic diagram only when at least two locked labels exist; otherwise lock the concept-board fallback.",
    });
  }

  return issues;
};

/** Geometry-level checks recomputed from the rendered layout itself. */
export const validateDiagramLayout = (params: { model: DiagramModel; layout: DiagramLayout }): DiagramIssue[] => {
  const { model, layout } = params;
  const issues: DiagramIssue[] = [];
  const expected = expectedPlateIds(model);
  const present = layout.plates.map((plate) => plate.id);
  const missing = expected.filter((id) => !present.includes(id));
  if (missing.length) {
    issues.push({
      rule: "diagram-plate-missing",
      evidence: { missing, expected, present },
      remediation: "Render exactly the plate identities the typed scene plan declares.",
    });
  }

  for (let left = 0; left < layout.plates.length; left += 1) {
    for (let right = left + 1; right < layout.plates.length; right += 1) {
      const a = layout.plates[left]!;
      const b = layout.plates[right]!;
      if (plateOverlaps(a.bounds, b.bounds)) {
        issues.push({
          rule: "diagram-plate-overlap",
          evidence: { first: a.id, second: b.id, firstBounds: a.bounds, secondBounds: b.bounds },
          remediation: "Fix the deterministic layout geometry; overlapping plates are an illegibility defect.",
        });
      }
    }
  }

  for (const plate of layout.plates) {
    const contrast = contrastRatio(plate.textColor, plate.fill);
    if (contrast < MIN_LABEL_CONTRAST) {
      issues.push({
        rule: "diagram-label-contrast",
        evidence: { plate: plate.id, contrast, textColor: plate.textColor, fill: plate.fill, minimum: MIN_LABEL_CONTRAST },
        remediation: "Choose a palette/text pairing that meets the 4.5:1 contrast gate.",
      });
    }
    if (estimatedTextWidth(plate.label, plate.fontSize) > plate.bounds.width - LABEL_PADDING + 1) {
      issues.push({
        rule: "diagram-label-overflow",
        evidence: { plate: plate.id, label: plate.label, fontSize: plate.fontSize, width: plate.bounds.width },
        remediation: "Shorten the locked label selection or widen the plate; never truncate label text.",
      });
    }
  }

  return issues;
};

/**
 * Renders and validates in one step. Labels are checked against the locked
 * corpus and geometry is recomputed independently of the generator, which keeps
 * the validator from simply approving its own output.
 */
export const renderAndValidateDiagram = (params: {
  model: DiagramModel;
  palette: DiagramPalette;
  canvas: DiagramCanvas;
  area: DiagramArea;
  lockedTexts: string[];
  allowedClaimIds: Set<string>;
}) => {
  const { svg, layout } = renderDiagramSvg(params.model, params.palette, params.canvas, params.area);
  const issues = [
    ...validateDiagramModel({ model: params.model, lockedTexts: params.lockedTexts, allowedClaimIds: params.allowedClaimIds }),
    ...validateDiagramLayout({ model: params.model, layout }),
  ];
  return { svg, layout, issues, passed: issues.length === 0 };
};

export { renderDiagramSvg };
export type { DiagramLayout, DiagramPalette };
