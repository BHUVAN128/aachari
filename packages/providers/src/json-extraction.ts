/**
 * Verifier JSON extraction. Model transports (`verifyClaims`, `generateJsonText`)
 * and any caller that parses a model's JSON reply share this normalizer: it strips
 * a fenced wrapper and extracts the single balanced JSON object, but never repairs
 * syntax. A malformed or ambiguous payload throws so the caller records a bounded,
 * visible failure instead of accepting an invented value.
 */
export class VerifierJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "VerifierJsonError";
  }
}

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;

/** Collects top-level balanced `{...}` substrings, respecting JSON strings and escapes. */
const extractBalancedObjects = (text: string): string[] => {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }

  return objects;
};

/**
 * Accepts clean JSON, a ```json fenced block, or a leading JSON object followed by
 * commentary. Throws on no object, on more than one object (ambiguous), or on any
 * payload that is not valid JSON.
 */
export const parseVerifierJson = (text: string): Record<string, unknown> => {
  if (typeof text !== "string" || !text.trim()) throw new VerifierJsonError("Verifier response was empty");
  const fenced = FENCE.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const objects = extractBalancedObjects(candidate);
  if (objects.length === 0) throw new VerifierJsonError("Verifier response did not contain a JSON object");
  if (objects.length > 1) throw new VerifierJsonError("Verifier response contained more than one JSON object; refusing to guess");

  let value: unknown;
  try {
    value = JSON.parse(objects[0]!);
  } catch (error) {
    throw new VerifierJsonError(`Verifier response was not valid JSON: ${(error as Error).message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VerifierJsonError("Verifier response was not a JSON object");
  return value as Record<string, unknown>;
};
