/**
 * Telemetry must not duplicate private prompts or source text. The generation
 * process record only needs hashes, counts, projection names, and provider
 * metadata, so any private-payload key is a hard failure rather than a warning.
 */
const normalize = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

const forbiddenKeys = new Set([
  "prompt",
  "prompts",
  "systemprompt",
  "userprompt",
  "rawprompt",
  "sourcetext",
  "sources",
  "extractedtext",
  "sourcedocument",
  "narration",
  "narrationtext",
  "scripttext",
  "fulltext",
  "completion",
  "rawresponse",
  "responsebody",
  "apikey",
  "secret",
  "accesstoken",
]);

export class TelemetryLeakageError extends Error {
  constructor(path: string) {
    super(`Telemetry record contains a private payload key at ${path}`);
    this.name = "TelemetryLeakageError";
  }
}

const walk = (value: unknown, path: string) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenKeys.has(normalize(key))) throw new TelemetryLeakageError(`${path}.${key}`);
    walk(entry, `${path}.${key}`);
  }
};

/** Throws when a telemetry record would store a raw prompt, source, or secret. */
export const assertTelemetrySafe = (record: Record<string, unknown>, path = "telemetry") => {
  walk(record, path);
  return record;
};

/** Returns a JSON string only if the record is safe to persist. */
export const safeTelemetryJson = (record: Record<string, unknown>) => JSON.stringify(assertTelemetrySafe(record));
