import { describe, expect, it } from "vitest";
import { VerifiedFactPackSchema } from "@upcraft/contracts";

const claim = { id: "11111111-1111-4111-8111-111111111111", text: "Leaves contain chlorophyll.", evidence: { sourceId: "22222222-2222-4222-8222-222222222222", sourceHash: "a".repeat(64), segmentIds: ["segment-aaaaaaaa"], locator: "p1" }, critical: true };

describe("verified-fact-pack/v1", () => {
  it("accepts a verified pack with an explicit omission record", () => {
    const pack = VerifiedFactPackSchema.parse({
      schemaVersion: "verified-fact-pack/v1",
      claims: [claim],
      caveats: [{ text: "Use context." }],
      omissions: [{ claimId: "33333333-3333-4333-8333-333333333333", text: "Dropped claim.", rationale: "Unsupported.", attempts: 3 }],
      attempts: 3,
      verifierModel: "gemini/gemini-3.8-flash",
    });
    expect(pack.omissions[0]?.attempts).toBe(3);
    expect(pack.verifierModel).toBe("gemini/gemini-3.8-flash");
  });

  it("requires a schema version, attempts, and omission rationale", () => {
    expect(() => VerifiedFactPackSchema.parse({ schemaVersion: "verified-fact-pack/v1", claims: [claim], caveats: [], omissions: [{ claimId: "33333333-3333-4333-8333-333333333333", text: "x", rationale: "", attempts: 0 }], attempts: 0, verifierModel: null })).toThrow();
    expect(() => VerifiedFactPackSchema.parse({ schemaVersion: "fact-pack/v2", claims: [claim], caveats: [], omissions: [], attempts: 1, verifierModel: null })).toThrow();
  });
});
