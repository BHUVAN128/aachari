import { z } from "zod";

/**
 * Validates a step's emitted artifact against the artifact contract stored in
 * `expected-output.json`. The contract checks schema shape and invariants, never
 * exact model text, so a model can vary in wording without failing the step.
 *
 * Contract grammar (a small, explicit subset of JSON Schema):
 *   {
 *     "schemaVersion": "fact-pack/v2",      // exact literal if present
 *     "checks": [
 *       { "path": "claims", "assert": "array-min", "value": 1 },
 *       { "path": "claims[].id", "assert": "uuid" },
 *       { "path": "claims[].evidence.segmentIds", "assert": "array-min", "value": 1 },
 *       { "path": "caveats", "assert": "array" }
 *     ]
 *   }
 */
export type ContractCheck = {
  path: string;
  assert:
    | "exists"
    | "array"
    | "array-min"
    | "uuid"
    | "string"
    | "number"
    | "boolean"
    | "non-empty-string"
    | "schema-version"
    | "lossless-join";
  value?: unknown;
};

export type ArtifactContract = {
  schemaVersion?: string;
  checks: ContractCheck[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolvePath = (content: unknown, path: string): unknown[] => {
  const segments = path.split(".");
  let current: unknown[] = [content];
  for (const segment of segments) {
    const isArrayWildcard = segment.endsWith("[]");
    const key = isArrayWildcard ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const node of current) {
      if (key === "") {
        next.push(node);
        continue;
      }
      if (node && typeof node === "object" && key in (node as Record<string, unknown>)) {
        const value = (node as Record<string, unknown>)[key];
        if (isArrayWildcard && Array.isArray(value)) next.push(...value);
        else if (!isArrayWildcard) next.push(value);
      }
    }
    current = next;
  }
  return current;
};

export const validateArtifactContract = (content: unknown, contract: ArtifactContract): string[] => {
  const failures: string[] = [];
  if (contract.schemaVersion !== undefined) {
    const actual = (content as { schemaVersion?: unknown })?.schemaVersion;
    if (actual !== contract.schemaVersion) failures.push(`schemaVersion expected "${contract.schemaVersion}" but got "${String(actual)}"`);
  }
  for (const check of contract.checks) {
    const values = resolvePath(content, check.path);
    const at = check.path;
    if (check.assert !== "exists" && values.length === 0 && check.assert !== "lossless-join") {
      failures.push(`${at}: expected ${check.assert} but path resolved to nothing`);
      continue;
    }
    switch (check.assert) {
      case "exists":
        if (values.length === 0) failures.push(`${at}: expected to exist`);
        break;
      case "array":
        if (!Array.isArray(values[0])) failures.push(`${at}: expected array`);
        break;
      case "array-min":
        if (!Array.isArray(values[0]) || values[0].length < Number(check.value ?? 1)) failures.push(`${at}: expected array with at least ${String(check.value ?? 1)} item(s)`);
        break;
      case "uuid":
        if (values.some((value) => typeof value !== "string" || !UUID.test(value))) failures.push(`${at}: expected uuid`);
        break;
      case "string":
        if (values.some((value) => typeof value !== "string")) failures.push(`${at}: expected string`);
        break;
      case "non-empty-string":
        if (values.some((value) => typeof value !== "string" || value.trim().length === 0)) failures.push(`${at}: expected non-empty string`);
        break;
      case "number":
        if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) failures.push(`${at}: expected finite number`);
        break;
      case "boolean":
        if (values.some((value) => typeof value !== "boolean")) failures.push(`${at}: expected boolean`);
        break;
      case "schema-version":
        if (values[0] !== check.value) failures.push(`${at}: expected "${String(check.value)}"`);
        break;
      case "lossless-join": {
        const joined = (content as { primaryJoin?: string })?.primaryJoin;
        if (typeof joined !== "string") failures.push(`${at}: expected a "primaryJoin" field for lossless-join check`);
        break;
      }
    }
  }
  return failures;
};

export const loadContract = async (path: string): Promise<ArtifactContract> => {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as ArtifactContract;
};

export const firstFailure = (failures: string[]) => (failures.length ? failures[0]! : null);
export const zParseOr = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} failed artifact schema: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return parsed.data;
};