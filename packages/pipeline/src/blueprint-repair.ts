import type { BlueprintIssue } from "./blueprint-qa.ts";
import { blueprintPromptRules } from "./prompts/blueprint.ts";

/**
 * Bounded Stage-3 blueprint repair loop from `docs/video-generation-process.md` §4.
 *
 * A deterministic QA finding must not kill the run on the first attempt: the
 * generator is re-prompted with the exact failed rules and missing claim ids,
 * bounded to `MAX_BLUEPRINT_ATTEMPTS`. The loop accumulates the union of missing
 * claim ids across attempts so a correction cannot oscillate (fix C04, drop C02,
 * repeat) — a later repair satisfies every outstanding requirement at once.
 */

export const MAX_BLUEPRINT_ATTEMPTS = 3;
export const BLUEPRINT_QA_EXHAUSTED = "BLUEPRINT_QA_EXHAUSTED";

export const BLUEPRINT_CORRECTION_CONTRACT =
  "Keep schemaVersion \"lesson-blueprint/v2\"; preserve every scene and claim id that already passed QA; change only what the listed failures require.";

const stringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

/** Claim ids a rejection demands be covered, read from the standard coverage evidence keys. */
export const missingClaimIdsFromIssues = (issues: BlueprintIssue[]): string[] => {
  const ids = new Set<string>();
  for (const issue of issues) {
    for (const id of stringArray(issue.evidence.uncoveredCritical)) ids.add(id);
    for (const id of stringArray(issue.evidence.missingClaimIds)) ids.add(id);
  }
  return [...ids];
};

/** Typed QA rejection: carries the failed issues and the exact missing claim ids. */
export class BlueprintQaRejectionError extends Error {
  public readonly issues: BlueprintIssue[];
  public readonly missingClaimIds: string[];
  public readonly rationale: string;

  public constructor(params: { issues: BlueprintIssue[]; missingClaimIds?: string[]; rationale?: string }) {
    const missingClaimIds = params.missingClaimIds ?? missingClaimIdsFromIssues(params.issues);
    const rationale = params.rationale ?? params.issues.map((issue) => issue.rule).join(", ");
    super(`Blueprint QA rejected the plan: ${rationale}`);
    this.name = "BlueprintQaRejectionError";
    this.issues = params.issues;
    this.missingClaimIds = missingClaimIds;
    this.rationale = rationale;
  }
}

/** Terminal, visible exhaustion after the bounded attempts are spent. */
export class BlueprintQaExhaustedError extends Error {
  public readonly code = BLUEPRINT_QA_EXHAUSTED;
  public readonly attempts: number;
  public readonly lastMissingClaimIds: string[];
  public readonly lastIssues: BlueprintIssue[];

  public constructor(params: { attempts: number; lastMissingClaimIds: string[]; lastIssues: BlueprintIssue[] }) {
    super(`${BLUEPRINT_QA_EXHAUSTED}: blueprint QA still failed after ${params.attempts} attempts${params.lastMissingClaimIds.length ? ` (missing ${params.lastMissingClaimIds.join(", ")})` : ""}`);
    this.name = "BlueprintQaExhaustedError";
    this.attempts = params.attempts;
    this.lastMissingClaimIds = params.lastMissingClaimIds;
    this.lastIssues = params.lastIssues;
  }
}

export type BlueprintCorrection = {
  attempt: number;
  failedRules: string[];
  failures: BlueprintIssue[];
  /** Union of missing critical claim ids across every failed attempt so far. */
  missingClaimIds: string[];
  rationale: string;
  contract: string;
};

/**
 * Builds the next generator prompt. It names the failed rules, the exact missing
 * critical claim ids, and the language/visual-beat rule so a single repair can
 * address every outstanding failure.
 */
export const buildBlueprintRepairPrompt = (params: { correction: BlueprintCorrection; previous: unknown; rules?: string }): string => {
  const { correction } = params;
  const missing = correction.missingClaimIds;
  return `A deterministic blueprint QA gate rejected the previous lesson blueprint.
Failed rules: ${correction.failedRules.join(", ") || "(none)"}
Missing critical claim ids that must each appear in at least one scene.claimIds: ${missing.join(", ") || "(none)"}.
Cover every listed claim id and do not drop a claim that already passed; never invent claim ids.
Verifier rationale: ${correction.rationale || "(none)"}
Correction contract: ${correction.contract}
${params.rules ?? blueprintPromptRules}

Previous blueprint (ids and scenes that already passed QA are locked; change only what the failures require):
${JSON.stringify(params.previous)}`;
};

export type BlueprintRepairOutcome = "completed" | "rejected-by-qa";

export type BlueprintRepairAttempt<T> = {
  attempt: number;
  outcome: BlueprintRepairOutcome;
  failedRules: string[];
  missingClaimIds: string[];
  rationale: string | null;
  value?: T;
};

/**
 * Runs generate → QA up to `maxAttempts`. On a typed rejection it re-runs only the
 * generator with the accumulated correction. Exhaustion raises
 * `BlueprintQaExhaustedError`, a terminal visible failure: the blueprint is never
 * saved and no downstream stage is scheduled.
 */
export const runBoundedBlueprintRepairLoop = async <T>(params: {
  maxAttempts?: number;
  contract?: string;
  generate: (correction: BlueprintCorrection | null) => Promise<T>;
  verify: (value: T, attempt: number) => Promise<void> | void;
  onAttempt?: (attempt: BlueprintRepairAttempt<T>) => Promise<void> | void;
}): Promise<{ value: T; attempts: BlueprintRepairAttempt<T>[] }> => {
  const maxAttempts = params.maxAttempts ?? MAX_BLUEPRINT_ATTEMPTS;
  const contract = params.contract ?? BLUEPRINT_CORRECTION_CONTRACT;
  const attempts: BlueprintRepairAttempt<T>[] = [];
  const accumulatedMissing = new Set<string>();
  let correction: BlueprintCorrection | null = null;
  let lastIssues: BlueprintIssue[] = [];
  let lastMissing: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await params.generate(correction);
    try {
      await params.verify(generated, attempt);
      const record: BlueprintRepairAttempt<T> = { attempt, outcome: "completed", failedRules: [], missingClaimIds: [], rationale: null, value: generated };
      attempts.push(record);
      await params.onAttempt?.(record);
      return { value: generated, attempts };
    } catch (error) {
      if (!(error instanceof BlueprintQaRejectionError)) throw error;
      error.missingClaimIds.forEach((id) => accumulatedMissing.add(id));
      lastIssues = error.issues;
      lastMissing = [...accumulatedMissing];
      const failedRules = [...new Set(error.issues.map((issue) => issue.rule))];
      const record: BlueprintRepairAttempt<T> = { attempt, outcome: "rejected-by-qa", failedRules, missingClaimIds: [...error.missingClaimIds], rationale: error.rationale };
      attempts.push(record);
      await params.onAttempt?.(record);
      correction = { attempt: attempt + 1, failedRules, failures: error.issues, missingClaimIds: lastMissing, rationale: error.rationale, contract };
    }
  }

  throw new BlueprintQaExhaustedError({ attempts: maxAttempts, lastMissingClaimIds: lastMissing, lastIssues });
};
