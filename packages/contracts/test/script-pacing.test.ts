import { describe, expect, it } from "vitest";
import { MAX_SCRIPT_PAUSE_MS, ApprovedScriptSchema, CaptionSafeAreaSchema, VisualBibleSchema } from "@upcraft/contracts";

const line = { id: "11111111-1111-4111-8111-111111111111", sceneId: "22222222-2222-4222-8222-222222222222", text: "Chlorophyll absorbs light.", claimIds: [], visualAction: "Reveal the leaf" };

describe("approved-script pauseMs (Gap 2)", () => {
  it("defaults to 0 and enforces the bounded per-line pause", () => {
    const script = ApprovedScriptSchema.parse({ schemaVersion: "approved-script/v2", narration: [line] });
    expect(script.narration[0]?.pauseMs).toBe(0);
    expect(() => ApprovedScriptSchema.parse({ schemaVersion: "approved-script/v2", narration: [{ ...line, pauseMs: MAX_SCRIPT_PAUSE_MS + 1 }] })).toThrow();
    expect(ApprovedScriptSchema.parse({ schemaVersion: "approved-script/v2", narration: [{ ...line, pauseMs: 2000 }] }).narration[0]?.pauseMs).toBe(2000);
  });
});

describe("caption safe area bounds (Finding 4/N1)", () => {
  const bible = (captionSafeArea: { top: number; right: number; bottom: number; left: number }) => ({
    schemaVersion: "visual-bible/v1", canvasTexture: "paper", lineStyle: "clean", palette: ["#111111", "#ffffff"], typography: { heading: "A", body: "B", caption: "C" },
    captionSafeArea, persistentEntities: [], camera: { behavior: "still", transitions: [] }, prohibitedVisualPatterns: [],
  });

  it("rejects an out-of-range edge and an over-large margin pair, but accepts a valid one", () => {
    expect(CaptionSafeAreaSchema.safeParse({ top: 0, right: 0, bottom: 3, left: 0 }).success).toBe(false);
    expect(CaptionSafeAreaSchema.safeParse({ top: 0.3, right: 0, bottom: 0.3, left: 0 }).success).toBe(false);
    expect(VisualBibleSchema.safeParse(bible({ top: 0.04, right: 0.05, bottom: 0.08, left: 0.05 })).success).toBe(true);
    expect(VisualBibleSchema.safeParse(bible({ top: 0, right: 0, bottom: 3, left: 0 })).success).toBe(false);
  });
});
