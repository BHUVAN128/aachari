import type { DiagramModel } from "@upcraft/contracts";

/**
 * Typed, deterministic diagram rendering. Factual diagrams, labels, charts, and
 * equations must be editable vector components rather than generated images
 * (`docs/model-recommendations.md`), and every label in the model already comes
 * verbatim from locked source/claim/script text before it reaches this module.
 */
export type DiagramPalette = {
  canvasTexture: string;
  /** Ordered palette; index 0 is the primary accent. */
  palette: string[];
  typography: { heading: string; body: string };
};

export type DiagramCanvas = { width: number; height: number };
export type DiagramArea = { x: number; y: number; width: number; height: number };
export type DiagramBounds = { x: number; y: number; width: number; height: number };

export type DiagramPlate = {
  id: string;
  label: string;
  bounds: DiagramBounds;
  fill: string;
  textColor: string;
  fontSize: number;
};

export type DiagramEdge = { from: string; to: string; points: Array<{ x: number; y: number }> };

export type DiagramLayout = {
  canvas: DiagramCanvas;
  area: DiagramArea;
  /** Plate keys are semantic (`step-0`, `column-1`, `bar-2`) so anchors stay meaningful. */
  plates: DiagramPlate[];
  edges: DiagramEdge[];
  /** Normalized (0..1) measured anchors used by the deterministic spatial solver. */
  anchors: Array<{ name: string; x: number; y: number }>;
};

export type RenderedDiagram = { svg: string; layout: DiagramLayout };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const parseHex = (value: string): { r: number; g: number; b: number } | undefined => {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const int = Number.parseInt(match[1]!, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
};

const linear = (channel: number) => {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (hex: string) => {
  const rgb = parseHex(hex);
  if (!rgb) throw new Error(`Diagram color must be a six-digit hex value: ${hex}`);
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
};

/** WCAG 2.1 contrast ratio; the benchmark requires legible labels. */
export const contrastRatio = (foreground: string, background: string) => {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a >= b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
};

/** Approximate advance width for the bold sans stack used by the composition. */
export const estimatedTextWidth = (label: string, fontSize: number) => label.length * fontSize * 0.58;

export const plateOverlaps = (a: DiagramBounds, b: DiagramBounds, tolerance = 1) =>
  a.x + a.width - tolerance > b.x && b.x + b.width - tolerance > a.x && a.y + a.height - tolerance > b.y && b.y + b.height - tolerance > a.y;

const readableTextColor = (fill: string) => (contrastRatio("#f8fafc", fill) >= contrastRatio("#0b1220", fill) ? "#f8fafc" : "#0b1220");

/** Shrinks a label until it fits one plate line, never truncating or editing it. */
const fitFontSize = (label: string, maxWidth: number, maxFontSize: number) => {
  let size = maxFontSize;
  while (size > 12 && estimatedTextWidth(label, size) > maxWidth - 28) size -= 2;
  return size;
};

const svgText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const accent = (diagramPalette: DiagramPalette, index: number) => {
  const colors = diagramPalette.palette.filter((color) => parseHex(color));
  if (!colors.length) throw new Error("The locked visual bible must provide at least one six-digit hex palette color");
  return colors[index % colors.length]!;
};

const makePlate = (id: string, label: string, bounds: DiagramBounds, fill: string, maxFontSize: number): DiagramPlate => ({
  id,
  label,
  bounds,
  fill,
  textColor: readableTextColor(fill),
  fontSize: fitFontSize(label, bounds.width, maxFontSize),
});

/** Two-row grid keeps wide processes inside the composition safe area. */
const gridColumns = (count: number) => (count <= 4 ? count : Math.ceil(count / 2));

const buildProcessLayout = (model: DiagramModel, area: DiagramArea, palette: DiagramPalette) => {
  const count = model.labels.length;
  const columns = gridColumns(count);
  const rows = Math.ceil(count / columns);
  const gap = 36;
  const bandHeight = Math.min(area.height * (rows === 1 ? 0.44 : 0.62), area.height);
  const cellWidth = (area.width - gap * (columns - 1)) / columns;
  const cellHeight = (bandHeight - gap * (rows - 1)) / rows;
  const top = area.y + area.height * 0.34 + (rows === 1 ? 0 : -gap);
  const plates = model.labels.map((label, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return makePlate(`step-${index}`, label, {
      x: area.x + column * (cellWidth + gap),
      y: top + row * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
    }, accent(palette, index), 40);
  });
  const edges: DiagramEdge[] = [];
  for (let index = 0; index < plates.length - 1; index += 1) {
    const from = plates[index]!;
    const to = plates[index + 1]!;
    const sameRow = Math.abs(from.bounds.y - to.bounds.y) < 1;
    edges.push({
      from: from.id,
      to: to.id,
      points: sameRow
        ? [
            { x: from.bounds.x + from.bounds.width, y: from.bounds.y + from.bounds.height / 2 },
            { x: to.bounds.x, y: to.bounds.y + to.bounds.height / 2 },
          ]
        : [
            { x: from.bounds.x + from.bounds.width / 2, y: from.bounds.y + from.bounds.height },
            { x: to.bounds.x + to.bounds.width / 2, y: to.bounds.y },
          ],
    });
  }
  return { plates, edges };
};

const buildComparisonLayout = (model: DiagramModel, area: DiagramArea, palette: DiagramPalette) => {
  const [left, right, ...details] = model.labels;
  const gap = 40;
  const columnWidth = (area.width - gap) / 2;
  const height = Math.min(area.height * 0.6, area.height);
  const top = area.y + area.height * 0.34;
  const leftBullets = details.filter((_, index) => index % 2 === 0);
  const rightBullets = details.filter((_, index) => index % 2 === 1);
  const body = (header: string | undefined, bullets: string[]) => [header, ...bullets].filter((entry): entry is string => Boolean(entry)).join("  •  ");
  const plates = [
    makePlate("column-0", body(left, leftBullets), { x: area.x, y: top, width: columnWidth, height }, accent(palette, 0), 34),
    makePlate("column-1", body(right, rightBullets), { x: area.x + columnWidth + gap, y: top, width: columnWidth, height }, accent(palette, 1), 34),
  ];
  return { plates, edges: [] as DiagramEdge[] };
};

const buildEquationLayout = (model: DiagramModel, area: DiagramArea, palette: DiagramPalette) => {
  const expression = model.expression ?? model.labels.join("  =  ");
  const expressionHeight = Math.min(area.height * 0.3, area.height);
  const top = area.y + area.height * 0.32;
  const plates = [makePlate("expression", expression, { x: area.x, y: top, width: area.width, height: expressionHeight }, accent(palette, 0), 46)];
  const chipLabels = model.labels.slice(0, 4);
  if (chipLabels.length) {
    const gap = 24;
    const chipWidth = (area.width - gap * (chipLabels.length - 1)) / chipLabels.length;
    const chipHeight = Math.min(area.height * 0.2, area.height);
    chipLabels.forEach((label, index) => {
      plates.push(makePlate(`term-${index}`, label, {
        x: area.x + index * (chipWidth + gap),
        y: top + expressionHeight + gap,
        width: chipWidth,
        height: chipHeight,
      }, accent(palette, index + 1), 30));
    });
  }
  return { plates, edges: [] as DiagramEdge[] };
};

const buildChartLayout = (model: DiagramModel, area: DiagramArea, palette: DiagramPalette) => {
  const values = model.values.slice(0, 6);
  const max = Math.max(...values.map((value) => Math.abs(value)), 1);
  const plotHeight = Math.max(area.height * 0.3, area.height * 0.62);
  const gap = 28;
  const barWidth = (area.width - gap * (values.length - 1)) / values.length;
  const baseline = area.y + area.height * 0.34 + plotHeight;
  const plates: DiagramPlate[] = [];
  const edges: DiagramEdge[] = [{ from: "axis", to: "axis", points: [{ x: area.x, y: baseline }, { x: area.x + area.width, y: baseline }] }];
  values.forEach((value, index) => {
    const barHeight = clamp((Math.abs(value) / max) * (plotHeight - 60), 24, plotHeight - 60);
    const label = `${model.labels[index] ?? `value ${index + 1}`}: ${value}`;
    plates.push(makePlate(`bar-${index}`, label, {
      x: area.x + index * (barWidth + gap),
      y: baseline - barHeight,
      width: barWidth,
      height: barHeight,
    }, accent(palette, index), 28));
  });
  return { plates, edges };
};

const buildLabelledSystemLayout = (model: DiagramModel, area: DiagramArea, palette: DiagramPalette) => {
  const centreLabel = model.labels[0] ?? model.title;
  const satellites = model.labels.slice(1, 5);
  const centreSize = Math.min(area.width * 0.4, area.height * 0.5);
  const centre: DiagramBounds = {
    x: area.x + (area.width - centreSize) / 2,
    y: area.y + area.height * 0.34,
    width: centreSize,
    height: centreSize,
  };
  const plates = [makePlate("system", centreLabel, centre, accent(palette, 0), 38)];
  const edges: DiagramEdge[] = [];
  const corners = [
    { x: area.x, y: area.y + area.height * 0.06 },
    { x: area.x + area.width * 0.7, y: area.y + area.height * 0.06 },
    { x: area.x, y: area.y + area.height * 0.86 },
    { x: area.x + area.width * 0.7, y: area.y + area.height * 0.86 },
  ];
  const satelliteWidth = area.width * 0.28;
  const satelliteHeight = area.height * 0.2;
  satellites.forEach((label, index) => {
    const corner = corners[index]!;
    const bounds = { x: corner.x, y: corner.y, width: satelliteWidth, height: satelliteHeight };
    plates.push(makePlate(`entity-${index}`, label, bounds, accent(palette, index + 1), 26));
    edges.push({
      from: `entity-${index}`,
      to: "system",
      points: [
        { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        { x: centre.x + centre.width / 2, y: centre.y + centre.height / 2 },
      ],
    });
  });
  return { plates, edges };
};

const buildConceptBoardLayout = (model: DiagramModel, area: DiagramArea, palette: DiagramPalette) => {
  const size = Math.min(area.width * 0.5, area.height * 0.6);
  const plates = [makePlate("concept", model.title, {
    x: area.x + (area.width - size) / 2,
    y: area.y + area.height * 0.34,
    width: size,
    height: size,
  }, accent(palette, 0), 40)];
  return { plates, edges: [] as DiagramEdge[] };
};

const buildLayout = (model: DiagramModel, area: DiagramArea, palette: DiagramPalette): { plates: DiagramPlate[]; edges: DiagramEdge[] } => {
  switch (model.kind) {
    case "process": return buildProcessLayout(model, area, palette);
    case "comparison": return buildComparisonLayout(model, area, palette);
    case "equation": return buildEquationLayout(model, area, palette);
    case "chart": return buildChartLayout(model, area, palette);
    case "labelled-system": return buildLabelledSystemLayout(model, area, palette);
    case "none": return buildConceptBoardLayout(model, area, palette);
  }
};
const plateAnchorNames = (plate: DiagramPlate) => [
  { suffix: "left", x: plate.bounds.x, y: plate.bounds.y + plate.bounds.height / 2 },
  { suffix: "right", x: plate.bounds.x + plate.bounds.width, y: plate.bounds.y + plate.bounds.height / 2 },
  { suffix: "top", x: plate.bounds.x + plate.bounds.width / 2, y: plate.bounds.y },
  { suffix: "bottom", x: plate.bounds.x + plate.bounds.width / 2, y: plate.bounds.y + plate.bounds.height },
];

/**
 * Renders a diagram model to deterministic SVG. The returned layout exposes the
 * same geometry that was drawn, so callers can validate it and store measured
 * anchors without ever re-deriving pixel coordinates from a model response.
 */
export const renderDiagramSvg = (model: DiagramModel, palette: DiagramPalette, canvas: DiagramCanvas, area: DiagramArea): RenderedDiagram => {
  const { plates, edges } = buildLayout(model, area, palette);
  const parts: string[] = [
    `<rect x="0" y="0" width="${canvas.width}" height="${canvas.height}" fill="#ffffff"/>`,
    `<rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" rx="28" fill="${palette.canvasTexture}"/>`,
    `<text x="${area.x + 36}" y="${area.y + 62}" font-family="${svgText(palette.typography.heading)}" font-size="42" font-weight="700" fill="#0b1220">${svgText(model.title)}</text>`,
  ];
  for (const plate of plates) {
    parts.push(`<rect x="${plate.bounds.x}" y="${plate.bounds.y}" width="${plate.bounds.width}" height="${plate.bounds.height}" rx="18" fill="${plate.fill}"/>`);
    parts.push(`<text x="${plate.bounds.x + plate.bounds.width / 2}" y="${plate.bounds.y + plate.bounds.height / 2 + plate.fontSize / 3}" text-anchor="middle" font-family="${svgText(palette.typography.body)}" font-size="${plate.fontSize}" font-weight="700" fill="${plate.textColor}">${svgText(plate.label)}</text>`);
  }
  for (const edge of edges) {
    const points = edge.points.map((point) => `${point.x},${point.y}`).join(" ");
    parts.push(`<polyline points="${points}" fill="none" stroke="#334155" stroke-width="6" stroke-linecap="round"/>`);
  }
  const anchors = plates.flatMap((plate) => [
    { name: `${plate.id}:center`, x: (plate.bounds.x + plate.bounds.width / 2) / canvas.width, y: (plate.bounds.y + plate.bounds.height / 2) / canvas.height },
    ...plateAnchorNames(plate).map((anchor) => ({ name: `${plate.id}:${anchor.suffix}`, x: anchor.x / canvas.width, y: anchor.y / canvas.height })),
  ]);
  const layout: DiagramLayout = { canvas, area, plates, edges, anchors };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" role="img" aria-label="${svgText(model.title)}">${parts.join("")}</svg>`;
  return { svg, layout };
};