import { ResolvedLayoutSchema, type AssetAnchor, type Point, type ResolvedLayer } from "@upcraft/contracts";

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
