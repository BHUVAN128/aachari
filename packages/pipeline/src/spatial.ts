import { ResolvedLayoutSchema, type AssetAnchor, type Point, type ResolvedLayer, type ResolvedLayout } from "@upcraft/contracts";

export type Canvas = { width: number; height: number };
export type MeasuredAsset = {
  id: string;
  width: number;
  height: number;
  anchors: AssetAnchor[];
};
export type AttachConstraint = {
  subjectId: string;
  subjectAnchor: string;
  targetId: string;
  targetAnchor: string;
  /** Scale of the subject relative to its native asset dimensions. */
  scale: number;
  zIndex: number;
  /** A semantic relation is an invariant, not prompt prose. */
  relation: "attach" | "behind-mask";
  clipPath?: string;
};

const findAnchor = (asset: MeasuredAsset, name: string) => {
  const anchor = asset.anchors.find((candidate) => candidate.name === name);
  if (!anchor) throw new Error(`Asset ${asset.id} has no measured anchor named ${name}.`);
  return anchor;
};

const equalsWithin = (a: number, b: number, tolerance = 0.75) => Math.abs(a - b) <= tolerance;

/**
 * Solves image overlays from measured coordinates. The LLM may request a semantic
 * attachment, but it never supplies the final pixels. The final transform comes
 * only from validated anchors emitted by deterministic SVG geometry, masks,
 * landmarks, detections, or a reviewer correction.
 */
export const solveAttachment = (canvas: Canvas, subject: MeasuredAsset, target: MeasuredAsset, constraint: AttachConstraint): ResolvedLayer => {
  if (constraint.subjectId !== subject.id || constraint.targetId !== target.id) throw new Error("Attachment constraint does not match its measured assets.");
  if (!Number.isFinite(constraint.scale) || constraint.scale <= 0) throw new Error("Attachment scale must be a positive finite number.");

  const subjectAnchor = findAnchor(subject, constraint.subjectAnchor);
  const targetAnchor = findAnchor(target, constraint.targetAnchor);
  const width = subject.width * constraint.scale;
  const height = subject.height * constraint.scale;
  const targetX = targetAnchor.point.x * target.width;
  const targetY = targetAnchor.point.y * target.height;
  const subjectAnchorX = subjectAnchor.point.x * width;
  const subjectAnchorY = subjectAnchor.point.y * height;
  const x = targetX - subjectAnchorX;
  const y = targetY - subjectAnchorY;

  if (x + width < 0 || y + height < 0 || x > canvas.width || y > canvas.height) {
    throw new Error(`Attachment ${subject.id} -> ${target.id} is entirely outside the canvas.`);
  }
  return {
    id: subject.id,
    matrix: [constraint.scale, 0, 0, constraint.scale, x, y],
    bounds: { x, y, width, height },
    zIndex: constraint.zIndex,
    ...(constraint.clipPath ? { clipPath: constraint.clipPath } : {}),
  };
};

export const assertAttachment = (subject: MeasuredAsset, target: MeasuredAsset, layer: ResolvedLayer, constraint: AttachConstraint) => {
  const subjectAnchor = findAnchor(subject, constraint.subjectAnchor);
  const targetAnchor = findAnchor(target, constraint.targetAnchor);
  const actualX = layer.bounds.x + subjectAnchor.point.x * layer.bounds.width;
  const actualY = layer.bounds.y + subjectAnchor.point.y * layer.bounds.height;
  const expectedX = targetAnchor.point.x * target.width;
  const expectedY = targetAnchor.point.y * target.height;
  if (!equalsWithin(actualX, expectedX) || !equalsWithin(actualY, expectedY)) {
    throw new Error(`Resolved attachment drifted from ${target.id}:${targetAnchor.name}.`);
  }
  if (constraint.relation === "behind-mask" && !layer.clipPath) throw new Error("A behind-mask relation requires a validated clip path.");
};

export const resolveAttachmentLayout = (params: {
  sceneId: string;
  canvas: Canvas;
  background: ResolvedLayer;
  subject: MeasuredAsset;
  target: MeasuredAsset;
  constraint: AttachConstraint;
}) => {
  const overlay = solveAttachment(params.canvas, params.subject, params.target, params.constraint);
  assertAttachment(params.subject, params.target, overlay, params.constraint);
  return ResolvedLayoutSchema.parse({
    schemaVersion: "resolved-layout/v1",
    sceneId: params.sceneId,
    canvas: params.canvas,
    layers: [params.background, overlay].sort((a, b) => a.zIndex - b.zIndex),
  });
};

export const normalizedPoint = (x: number, y: number, width: number, height: number): Point => {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("Anchor geometry must have positive finite dimensions.");
  const point = { x: x / width, y: y / height };
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new Error("Anchor lies outside its source asset.");
  return point;
};

export type Bounds = { x: number; y: number; width: number; height: number };

/**
 * A scene's measured diagram: its selected asset identity, intrinsic size, the
 * resolved placement of that asset, and the measured anchor points persisted
 * from deterministic SVG geometry.
 */
export type MeasuredDiagram = {
  assetId: string;
  width: number;
  height: number;
  bounds: Bounds;
  anchors: AssetAnchor[];
  zIndex: number;
};

/**
 * Solves one scene's `resolved-layout/v1` from measured anchors. The base
 * diagram is placed at its computed area; an optional illustration overlay is
 * attached to a measured diagram anchor with `solveAttachment` and re-checked by
 * `assertAttachment`, so the overlay transform is never guessed or supplied by a
 * model. Layers are emitted sorted by z-index.
 */
export const solveSceneLayout = (params: {
  sceneId: string;
  canvas: Canvas;
  diagram: MeasuredDiagram;
  illustration?: { assetId: string; width: number; height: number; targetAnchor: string; zIndex: number; coverage?: number };
}): ResolvedLayout => {
  const { sceneId, canvas, diagram } = params;
  const base: ResolvedLayer = {
    id: `diagram-${sceneId}`,
    assetId: diagram.assetId,
    matrix: [1, 0, 0, 1, diagram.bounds.x, diagram.bounds.y],
    bounds: diagram.bounds,
    zIndex: diagram.zIndex,
  };
  if (!params.illustration) {
    return ResolvedLayoutSchema.parse({ schemaVersion: "resolved-layout/v1", sceneId, canvas, layers: [base] });
  }

  const { illustration } = params;
  const subject: MeasuredAsset = {
    id: illustration.assetId,
    width: illustration.width,
    height: illustration.height,
    anchors: [{ name: "center", point: { x: 0.5, y: 0.5 }, provider: "detection", confidence: 1 }],
  };
  const target: MeasuredAsset = { id: diagram.assetId, width: diagram.width, height: diagram.height, anchors: diagram.anchors };
  const coverage = illustration.coverage ?? 0.28;
  const scale = Math.min(1.5, (canvas.width * coverage) / illustration.width, (canvas.height * coverage) / illustration.height);
  const constraint: AttachConstraint = {
    subjectId: illustration.assetId,
    subjectAnchor: "center",
    targetId: diagram.assetId,
    targetAnchor: illustration.targetAnchor,
    scale,
    zIndex: illustration.zIndex,
    relation: "attach",
  };
  const overlay = solveAttachment(canvas, subject, target, constraint);
  assertAttachment(subject, target, overlay, constraint);
  const overlayLayer: ResolvedLayer = { ...overlay, id: `illustration-${sceneId}`, assetId: illustration.assetId };
  return ResolvedLayoutSchema.parse({
    schemaVersion: "resolved-layout/v1",
    sceneId,
    canvas,
    layers: [overlayLayer, base].sort((a, b) => a.zIndex - b.zIndex),
  });
};
