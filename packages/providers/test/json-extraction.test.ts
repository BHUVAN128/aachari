import { describe, expect, it } from "vitest";
import { VerifierJsonError, parseVerifierJson } from "../src/json-extraction.ts";

describe("verifier JSON extraction", () => {
  it("parses clean JSON and a fenced block", () => {
    expect(parseVerifierJson('{"supported":true}')).toEqual({ supported: true });
    expect(parseVerifierJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("tolerates trailing commentary after a balanced object", () => {
    expect(parseVerifierJson('{"a":1} trailing commentary')).toEqual({ a: 1 });
  });

  it("throws on malformed JSON without repairing it", () => {
    expect(() => parseVerifierJson("{bad json}")).toThrow(VerifierJsonError);
  });

  it("throws on missing or ambiguous payloads", () => {
    expect(() => parseVerifierJson("no json here")).toThrow(VerifierJsonError);
    expect(() => parseVerifierJson('{"a":1}{"b":2}')).toThrow(VerifierJsonError);
  });
});
