import assert from "node:assert/strict";
import { buildLineStructuredNarration, LINE_BREAK, mapStructuredAlignment, validateMonotonicWords, type Alignment } from "./line-synthesis.ts";

/**
 * s08 — Voiceover.
 *
 * Gap 2: line-structured synthesis inserts a deterministic break between approved
 * lines; the alignment mapper accounts for those break offsets and asserts
 * monotonic timestamps. A dropped break or a backwards timestamp is a visible
 * alignment defect.
 */
const buildAligned = (text: string): Alignment => {
  const characters = [...text];
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (const char of characters) {
    const perChar = 0.05;
    starts.push(cursor);
    cursor += perChar;
    ends.push(cursor);
    void char;
  }
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
};

const main = () => {
  const lines = ["Chlorophyll absorbs light energy.", "The Calvin cycle fixes carbon dioxide."];
  const structured = buildLineStructuredNarration(lines);
  assert.equal(structured, `Chlorophyll absorbs light energy.${LINE_BREAK}The Calvin cycle fixes carbon dioxide.`);

  const mapped = mapStructuredAlignment(buildAligned(structured), lines);
  assert.deepEqual(mapped.issues, [], `alignment must be valid: ${JSON.stringify(mapped.issues)}`);
  assert.equal(mapped.breaks.length, lines.length - 1, "each line boundary must be observed as a break");
  assert.deepEqual(mapped.words.map((word) => word.text), ["Chlorophyll", "absorbs", "light", "energy.", "The", "Calvin", "cycle", "fixes", "carbon", "dioxide."]);
  console.log(`  Gap 2: structured alignment → ${mapped.words.length} words, ${mapped.breaks.length} break(s), monotonic.`);

  // A non-monotonic alignment is rejected.
  const bad = buildAligned(structured);
  bad.character_start_times_seconds[0] = 10; // first word now starts after it ends
  const badIssues = validateMonotonicWords(mapStructuredAlignment(bad, lines).words);
  assert.ok(badIssues.some((issue) => issue.rule === "alignment-non-monotonic" || issue.rule === "alignment-word-nonpositive"), "non-monotonic alignment must be reported");
  console.log(`  Gap 2: non-monotonic alignment rejected (${badIssues[0]?.rule}).`);

  // A missing break is rejected.
  const flat = mapStructuredAlignment(buildAligned(lines.join(" ")), lines);
  assert.ok(flat.issues.some((issue) => issue.rule === "alignment-break-count"), "a dropped break must be reported");
  console.log("  Gap 2: dropped break rejected.");

  console.log("s08 PASS");
};

try {
  main();
} catch (error) {
  console.error("s08 FAIL:", error);
  process.exit(1);
}