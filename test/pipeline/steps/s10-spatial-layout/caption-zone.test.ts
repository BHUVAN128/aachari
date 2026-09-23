import assert from "node:assert/strict";
import type { WordTiming } from "@upcraft/contracts";
import {
  CAPTION_FONT_SIZE,
  CAPTION_LINE_HEIGHT,
  CAPTION_MAX_WORDS,
  CAPTION_VERTICAL_PADDING,
  CaptionSafeAreaSchema,
  captionLineCount,
  captionZoneForScene,
  classifyScript,
  estimateCaptionWidth,
  lineBoundaryIndexes,
  packCaptionCues,
  sceneWordRanges,
  validateCaptionSafeArea,
  validateCaptionZoneClearance,
  validateOneDiagramPerScene,
} from "./caption-zone.ts";

/**
 * W4 — deterministic caption geometry (zero keys, zero database).
 *
 * Proves the three disconnected geometry sources are now one: the s06 safe-area
 * bound, the per-scene caption zone, and the s10 clearance assertion. A bible
 * `bottom: 0.30` that would die at s13 is caught at s10 for free.
 */
const CANVAS = { width: 1920, height: 1080 };
const SAFE = { top: 0.04, right: 0.05, bottom: 0.08, left: 0.05 };
const words = (count: number): WordTiming[] => Array.from({ length: count }, (_, index) => ({ text: `word${index}`, startMs: index * 400, endMs: index * 400 + 380 }));

const main = () => {
  // --- s06: safe-area bounds are enforced pre-save ---
  assert.equal(CaptionSafeAreaSchema.safeParse({ top: 0, right: 0, bottom: 3, left: 0 }).success, false, "an out-of-range edge must fail the schema");
  assert.equal(CaptionSafeAreaSchema.safeParse({ top: 0.3, right: 0, bottom: 0.3, left: 0 }).success, false, "a vertical pair sum above 0.5 must fail the schema");
  assert.equal(CaptionSafeAreaSchema.safeParse(SAFE).success, true);
  assert.equal(validateCaptionSafeArea({ top: 0, right: 0, bottom: 3, left: 0 })[0]?.rule, "bible-safe-area-edge-bound");
  assert.equal(validateCaptionSafeArea({ top: 0.3, right: 0, bottom: 0.3, left: 0 })[0]?.rule, "bible-safe-area-vertical-overflow");
  console.log("  W4: safe-area schema/gate rejects out-of-range and over-large margins at s06.");

  // --- script classification and width correction ---
  assert.equal(classifyScript("Chlorophyll"), "latin");
  assert.equal(classifyScript("இலை"), "indic");
  assert.equal(classifyScript("叶片"), "cjk");
  const latinSample = "mitochondrion";
  const tamilSample = "மைட்டோகாண்ட்ரியா";
  assert.ok(estimateCaptionWidth(tamilSample) > estimateCaptionWidth(latinSample), "Tamil must wrap wider than the Latin calibration");
  const longCompound = "Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz";
  const manyLines = captionLineCount(longCompound + " " + longCompound, 1232);
  assert.ok(manyLines >= 3, `a long compound must wrap to at least 3 lines (got ${manyLines})`);
  console.log(`  W4: script-class width correction active; compound wraps to ${manyLines} lines.`);

  // --- the real collision: bible bottom 0.30 overlapping the diagram area ---
  const collisionSafe = { top: 0.04, right: 0.05, bottom: 0.3, left: 0.05 };
  const collisionCue = { text: "The diagram labels every stage", startMs: 0, endMs: 1000, wordIndexes: [0, 1, 2, 3, 4] };
  const zone = captionZoneForScene({ canvas: CANVAS, safeArea: collisionSafe, cues: [collisionCue], words: words(5) });
  assert.equal(zone.y + zone.height, CANVAS.height - Math.round(0.3 * CANVAS.height));
  // Diagram area (scene-area.ts): y = 0.28h, height = 0.48h → bottom 0.76h.
  const diagramLayer = { id: "diagram-scene", bounds: { x: 230, y: 302, width: 1459, height: 518 } };
  const clearance = validateCaptionZoneClearance({ layouts: [{ sceneId: "scene", layers: [diagramLayer] }], zones: new Map([["scene", zone]]) });
  assert.equal(clearance[0]?.rule, "spatial-caption-overlap", "the 0.30 bible must be caught at s10, not s13");
  // A safe caption band does not collide.
  const safeZone = captionZoneForScene({ canvas: CANVAS, safeArea: SAFE, cues: [collisionCue], words: words(5) });
  assert.deepEqual(validateCaptionZoneClearance({ layouts: [{ sceneId: "scene", layers: [diagramLayer] }], zones: new Map([["scene", safeZone]]) }), []);
  console.log("  W4: s10 clearance assertion catches the guaranteed s13 collision for free.");

  // --- wrapping grows the zone but keeps it inside the canvas ---
  const tallCue = { text: longCompound + " " + longCompound, startMs: 0, endMs: 1000, wordIndexes: [0] };
  const tallZone = captionZoneForScene({ canvas: CANVAS, safeArea: SAFE, cues: [tallCue], words: [{ text: tallCue.text, startMs: 0, endMs: 1000 }] });
  const expectedHeight = captionLineCount(tallCue.text, Math.min(1300, CANVAS.width - 96 - 96) - 68) * CAPTION_FONT_SIZE * CAPTION_LINE_HEIGHT + CAPTION_VERTICAL_PADDING * 2;
  assert.equal(tallZone.height, expectedHeight);
  assert.ok(tallZone.y + tallZone.height <= CANVAS.height, "the wrapped caption zone must stay inside the canvas");
  console.log("  W4: wrapped zone height tracks the true line count and stays contained.");

  // --- cue packing respects line boundaries, pauses, words, and width ---
  const spoken = words(6);
  const boundaries = lineBoundaryIndexes([{ text: "one two three" }, { text: "four five six" }]);
  assert.deepEqual(boundaries, [0, 3]);
  const packed = packCaptionCues({ words: spoken, lineBoundaries: boundaries });
  assert.ok(packed.every((cue) => cue.wordIndexes.every((index) => (index < 3) === (cue.wordIndexes[0]! < 3))), "a cue must never straddle a script-line boundary");
  const ranges = sceneWordRanges([{ sceneId: "a", text: "one two three" }, { sceneId: "b", text: "four five six" }]);
  assert.deepEqual(ranges.get("a"), { startWordIndex: 0, endWordIndex: 3 });
  assert.deepEqual(ranges.get("b"), { startWordIndex: 3, endWordIndex: 6 });

  const paused: WordTiming[] = [
    { text: "word0", startMs: 0, endMs: 380 },
    { text: "word1", startMs: 400, endMs: 780 },
    { text: "word2", startMs: 2_500, endMs: 2_880 },
    { text: "word3", startMs: 3_000, endMs: 3_380 },
  ];
  const pauseCues = packCaptionCues({ words: paused, longPauseMs: 700 });
  assert.ok(!pauseCues.some((cue) => cue.wordIndexes.includes(1) && cue.wordIndexes.includes(2)), "a long inspection pause must start a new cue");
  assert.ok(pauseCues.some((cue) => cue.wordIndexes[0] === 2), "the post-pause cue begins at the first word after the gap");
  assert.ok(pauseCues.length < paused.length, "packing must still group words between breaks");

  const widthCues = packCaptionCues({ words: spoken, maxCueWidth: CAPTION_FONT_SIZE * 0.58 * 12 });
  assert.ok(widthCues.length > 1, "width-aware packing must split an over-wide cue");
  const wordCapped = packCaptionCues({ words: words(20), maxWords: 3 });
  assert.ok(wordCapped.every((cue) => cue.wordIndexes.length <= 3) && wordCapped.length === Math.ceil(20 / 3));
  console.log(`  W4: packing → line-safe, pause-safe, width-aware, word cap ${CAPTION_MAX_WORDS} respected.`);

  // --- N9 invariant: exactly one diagram asset per scene ---
  assert.deepEqual(validateOneDiagramPerScene({ sceneIds: ["s1"], assets: [{ sceneId: "s1", role: "diagram-s1" }] }), []);
  assert.equal(validateOneDiagramPerScene({ sceneIds: ["s1"], assets: [] })[0]?.rule, "scene-diagram-invariant");
  assert.equal(validateOneDiagramPerScene({ sceneIds: ["s1"], assets: [{ sceneId: "s1", role: "diagram-s1" }, { sceneId: "s1", role: "diagram-s1" }] })[0]?.evidence.count, 2);
  console.log("  W4: one-diagram-per-scene invariant enforced.");

  console.log("s10 caption-zone PASS");
};

try {
  main();
} catch (error) {
  console.error("s10 caption-zone FAIL:", error);
  process.exit(1);
}
