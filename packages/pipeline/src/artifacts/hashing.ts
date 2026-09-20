import { createHash } from "node:crypto";

/** Content hash over any JSON-serializable value. Pure extraction from `stages.ts`. */
export const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Content hash over a UTF-8 text value. Pure extraction from `stages.ts`. */
export const textSha = (value: string) => createHash("sha256").update(value).digest("hex");