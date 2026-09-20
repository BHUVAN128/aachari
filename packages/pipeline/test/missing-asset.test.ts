import { describe, expect, it } from "vitest";
import { missingRenderAssets } from "../src/stages.ts";

describe("missing required render assets", () => {
  it("names exactly the manifest layers whose selected asset is not available", () => {
    const layers = [
      { id: "diagram-scene-1", assetId: "asset-a" },
      { id: "illustration-scene-1", assetId: "asset-b" },
      { id: "background", assetId: undefined },
    ];
    expect(missingRenderAssets(layers, ["asset-a"])).toEqual([{ id: "illustration-scene-1", assetId: "asset-b" }]);
  });

  it("reports nothing when every named asset is available", () => {
    expect(missingRenderAssets([{ id: "diagram-scene-1", assetId: "asset-a" }], ["asset-a", "asset-b"])).toEqual([]);
  });

  it("never invents a placeholder for a layer with no named asset", () => {
    expect(missingRenderAssets([{ id: "diagram-scene-1", assetId: undefined }], [])).toEqual([]);
  });
});