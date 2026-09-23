import { describe, expect, it } from "vitest";
import type { WordTiming } from "@upcraft/contracts";
import {
  AlignmentDefectExhaustedError,
  CAPTION_FONT_SIZE,
  MAX_ALIGNMENT_ATTEMPTS,
  buildCuratedTerms,
  captionLineCount,
  captionZoneForScene,
  deriveDomainTerms,
  estimateCaptionWidth,
  lineBoundaryIndexes,
  packCaptionCues,
  pauseForVisualAction,
  runBoundedAlignmentSynthesis,
  runBoundedVisualActionLanguageLoop,
  sceneWordRanges,
  ScriptLanguageDirectiveExhaustedError,
  validateAlignmentIntegrity,
  validateCaptionSafeArea,
  validateCaptionZoneClearance,
  validateEntityDescriptionLanguage,
  validateMeasuredBreaks,
  validateOneDiagramPerScene,
  validatePacedAudio,
  validatePacing,
  validateScriptLanguageDirective,
  validateVisualActionLanguage,
  validateVoiceAlignment,
  voiceoverInputHash,
} from "../src/media-qa.ts";

const words = (count: number): WordTiming[] => Array.from({ length: count }, (_, index) => ({ text: `word${index}`, startMs: index * 400, endMs: index * 400 + 380 }));
const CANVAS = { width: 1920, height: 1080 };
const SAFE = { top: 0.04, right: 0.05, bottom: 0.08, left: 0.05 };

describe("W2 alignment integrity", () => {
  it("rejects the floor/ceil zero-length word and non-monotonic timestamps", () => {
    expect(validateVoiceAlignment({ words: [{ text: "a", startMs: 1200, endMs: 1200 }], measuredDurationMs: 2000 }).map((issue) => issue.rule)).toContain("voice-alignment-word-nonpositive");
    expect(validateAlignmentIntegrity([])[0]?.rule).toBe("alignment-empty");
    expect(validateAlignmentIntegrity([{ text: "a", startMs: 500, endMs: 500 }]).map((issue) => issue.rule)).toContain("voice-alignment-word-nonpositive");
  });

  it("recovers a transient defect on a bounded retry and exhausts permanently failing ones", async () => {
    const good = words(3);
    const bad = [{ text: "a", startMs: 100, endMs: 100 }];
    const healed = await runBoundedAlignmentSynthesis({ synthesize: async (attempt) => ({ words: attempt === 1 ? bad : good, value: attempt }) });
    expect(healed.attempts.map((attempt) => attempt.outcome)).toEqual(["alignment-defect", "completed"]);
    await expect(runBoundedAlignmentSynthesis({ synthesize: async () => ({ words: bad, value: 0 }) })).rejects.toBeInstanceOf(AlignmentDefectExhaustedError);
    try {
      await runBoundedAlignmentSynthesis({ synthesize: async () => ({ words: bad, value: 0 }) });
    } catch (error) {
      expect((error as AlignmentDefectExhaustedError).attempts).toHaveLength(MAX_ALIGNMENT_ATTEMPTS);
    }
  });
});

describe("W1 curated terms and replay identity", () => {
  it("never lets long verified-claim terms starve a narration term", () => {
    const longClaims = Array.from({ length: 45 }, (_, index) => `${"x".repeat(30)}${index}`);
    const terms = buildCuratedTerms({ narrationText: "Mitochondria release energy.", verifiedClaimTexts: longClaims });
    expect(terms[0]).toBe("mitochondria");
    expect(terms).toHaveLength(40);
    expect(deriveDomainTerms(["Photosynthesis uses ATP."]).sort()).toEqual(["atp", "photosynthesis"].sort());
  });

  it("binds the voiceover hash to the verified pack and voice identity", () => {
    const script = { narration: [{ text: "Text" }] };
    const verified = { claims: [{ text: "Mitochondria release energy." }] };
    const voice = { provider: "elevenlabs", model: "m1", voiceId: "v1" };
    const base = voiceoverInputHash({ script, verifiedFactPack: verified, voice });
    expect(voiceoverInputHash({ script, verifiedFactPack: verified, voice: { ...voice } })).toBe(base);
    expect(voiceoverInputHash({ script, verifiedFactPack: verified, voice: { ...voice, voiceId: "v2" } })).not.toBe(base);
    expect(voiceoverInputHash({ script, verifiedFactPack: { claims: [{ text: "changed" }] }, voice })).not.toBe(base);
  });
});

describe("W3 renderer-language directive", () => {
  it("rejects localized and non-directive visualActions and keeps narration verbatim", async () => {
    expect(validateVisualActionLanguage("இலை").map((issue) => issue.rule)).toContain("script-visual-action-localized");
    expect(validateVisualActionLanguage("The leaf is shown").map((issue) => issue.rule)).toContain("script-visual-action-non-directive");
    expect(validateEntityDescriptionLanguage({ id: "e", description: "பச்சையம்" }).map((issue) => issue.rule)).toContain("bible-entity-description-localized");
    expect(pauseForVisualAction("Reveal the leaf")).toBe(1000);
    expect(pauseForVisualAction("Inspect the label")).toBe(2000);

    const baseline = new Map([["l1", "Tamil narration"]]);
    expect(validateScriptLanguageDirective({ narration: [{ id: "l1", text: "changed", visualAction: "Reveal" }] }, baseline).map((issue) => issue.rule)).toContain("script-narration-mutated");

    const outcomes: string[] = [];
    const repaired = await runBoundedVisualActionLanguageLoop({
      generate: async (correction) => ({ narration: [{ id: "l1", text: "Tamil narration", visualAction: correction ? "Reveal the leaf" : "இலை" }] }),
      onAttempt: (attempt) => outcomes.push(attempt.outcome),
    });
    expect(outcomes).toEqual(["rejected-by-language-directive", "completed"]);
    expect(repaired.value.narration[0]!.text).toBe("Tamil narration");
    await expect(runBoundedVisualActionLanguageLoop({ generate: async () => ({ narration: [{ id: "l1", text: "Tamil narration", visualAction: "இலை" }] }) })).rejects.toBeInstanceOf(ScriptLanguageDirectiveExhaustedError);
  });
});

describe("W4 caption geometry", () => {
  it("bounds the safe area and catches the bible/diagram collision at s10", () => {
    expect(validateCaptionSafeArea({ top: 0, right: 0, bottom: 3, left: 0 }).map((issue) => issue.rule)).toContain("bible-safe-area-edge-bound");
    expect(validateCaptionSafeArea({ top: 0.3, right: 0, bottom: 0.3, left: 0 }).map((issue) => issue.rule)).toContain("bible-safe-area-vertical-overflow");
    const cue = { text: "The diagram labels every stage", startMs: 0, endMs: 1000, wordIndexes: [0, 1, 2, 3, 4] };
    const zone = captionZoneForScene({ canvas: CANVAS, safeArea: { top: 0.04, right: 0.05, bottom: 0.3, left: 0.05 }, cues: [cue], words: words(5) });
    const diagram = { id: "diagram-scene", bounds: { x: 230, y: 302, width: 1459, height: 518 } };
    expect(validateCaptionZoneClearance({ layouts: [{ sceneId: "s", layers: [diagram] }], zones: new Map([["s", zone]]) })[0]?.rule).toBe("spatial-caption-overlap");
    expect(validateCaptionZoneClearance({ layouts: [{ sceneId: "s", layers: [diagram] }], zones: new Map([["s", captionZoneForScene({ canvas: CANVAS, safeArea: SAFE, cues: [cue], words: words(5) })]]) })).toEqual([]);
  });

  it("corrects width per script class and packs cues without straddling boundaries or pauses", () => {
    expect(estimateCaptionWidth("மைட்டோகாண்ட்ரியா")).toBeGreaterThan(estimateCaptionWidth("mitochondrion"));
    expect(captionLineCount("Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz", 1232)).toBeGreaterThanOrEqual(3);
    const spoken = words(6);
    const boundaries = lineBoundaryIndexes([{ text: "one two three" }, { text: "four five six" }]);
    expect(boundaries).toEqual([0, 3]);
    const packed = packCaptionCues({ words: spoken, lineBoundaries: boundaries });
    expect(packed.every((cue) => cue.wordIndexes.every((index) => (index < 3) === (cue.wordIndexes[0]! < 3)))).toBe(true);
    const paused: WordTiming[] = [
      { text: "a", startMs: 0, endMs: 300 },
      { text: "b", startMs: 320, endMs: 600 },
      { text: "c", startMs: 2600, endMs: 2900 },
    ];
    expect(packCaptionCues({ words: paused, longPauseMs: 700 }).some((cue) => cue.wordIndexes[0] === 2)).toBe(true);
    expect(packCaptionCues({ words: words(4), maxCueWidth: CAPTION_FONT_SIZE * 0.58 * 3 }).length).toBeGreaterThan(1);
    expect(sceneWordRanges([{ sceneId: "a", text: "one two three" }, { sceneId: "b", text: "four five six" }]).get("b")).toEqual({ startWordIndex: 3, endWordIndex: 6 });
    expect(validateOneDiagramPerScene({ sceneIds: ["s"], assets: [{ sceneId: "s", role: "diagram-s" }] })).toEqual([]);
    expect(validateOneDiagramPerScene({ sceneIds: ["s"], assets: [] })[0]?.rule).toBe("scene-diagram-invariant");
  });
});

describe("Gap 2 pacing", () => {
  it("validates the pause budget, paced audio, and measured breaks", () => {
    const script = { narration: [{ text: "Chlorophyll absorbs light energy.", pauseMs: 2000 }, { text: "The Calvin cycle fixes carbon dioxide.", pauseMs: 0 }] };
    expect(validatePacing({ script, durationSeconds: 120 })).toEqual([]);
    expect(validatePacedAudio({ script, measuredDurationMs: 500, toleranceMs: 0 })[0]?.rule).toBe("voice-pacing-underflow");
    const spoken: WordTiming[] = [
      { text: "Chlorophyll", startMs: 0, endMs: 500 }, { text: "absorbs", startMs: 520, endMs: 900 }, { text: "light", startMs: 920, endMs: 1200 }, { text: "energy.", startMs: 1220, endMs: 1600 },
      { text: "The", startMs: 3500, endMs: 3700 }, { text: "Calvin", startMs: 3720, endMs: 4100 }, { text: "cycle", startMs: 4120, endMs: 4400 }, { text: "fixes", startMs: 4420, endMs: 4700 }, { text: "carbon", startMs: 4720, endMs: 5100 }, { text: "dioxide.", startMs: 5120, endMs: 5600 },
    ];
    expect(validateMeasuredBreaks({ lines: script.narration, words: spoken })).toEqual([]);
    const dropped = spoken.map((word, index) => (index >= 4 ? { ...word, startMs: word.startMs - 1800, endMs: word.endMs - 1800 } : word));
    expect(validateMeasuredBreaks({ lines: script.narration, words: dropped })[0]?.rule).toBe("voice-pause-not-rendered");
  });
});
