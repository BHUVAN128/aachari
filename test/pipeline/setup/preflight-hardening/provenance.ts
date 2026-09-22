import { createHash } from "node:crypto";

/**
 * s01 Preflight hardening — source provenance validation (risk R3).
 *
 * Copyright/IP defensibility requires that the system can always show what it
 * ingested and from where. Every frozen source must carry a kind, a name, and a
 * content hash; a URL source must be HTTPS and must record a concrete origin. The
 * rights/consent declaration is recorded as `unrecorded` unless the caller passes
 * an explicit declaration — the system never fabricates a rights basis.
 */

export type OriginStatus = "https" | "http-insecure" | "not-http" | "not-applicable";
export type RightsDeclaration = "unrecorded" | "declared";

export type ProvenanceSourceInput = {
  id: string;
  kind: string;
  name: string;
  value: string;
  hash: string | null;
  /** A caller-supplied rights/consent basis; absence becomes `unrecorded`, never invented. */
  rightsDeclared?: boolean;
};

export type SourceProvenanceRecord = {
  sourceId: string;
  kind: string;
  nameHash: string;
  contentHash: string | null;
  origin: string | null;
  originStatus: OriginStatus;
  rightsDeclaration: RightsDeclaration;
};

export type ProvenanceValidation = {
  records: SourceProvenanceRecord[];
  complete: boolean;
  failures: string[];
};

const nameHash = (name: string) => (name.trim() ? `sha256:${createHash("sha256").update(name).digest("hex")}` : "");

const describeOrigin = (source: ProvenanceSourceInput, failures: string[]): { origin: string | null; originStatus: OriginStatus } => {
  if (source.kind !== "url") return { origin: null, originStatus: "not-applicable" };
  let url: URL;
  try {
    url = new URL(source.value);
  } catch {
    failures.push(`source ${source.id}: URL source is not a valid URL`);
    return { origin: null, originStatus: "not-http" };
  }
  if (url.protocol === "https:") return { origin: url.origin, originStatus: "https" };
  failures.push(`source ${source.id}: URL source is not HTTPS (${url.protocol}//)`);
  return { origin: url.origin, originStatus: "http-insecure" };
};

/**
 * Validates provenance for every frozen source. `complete` is false when a source
 * is missing its structural identity or a URL source is insecure/unparseable; an
 * incomplete pack blocks the run with the terminal `provenance_incomplete` code.
 */
export const validateSourceProvenance = (sources: ReadonlyArray<ProvenanceSourceInput>): ProvenanceValidation => {
  const records: SourceProvenanceRecord[] = [];
  const failures: string[] = [];

  for (const source of sources) {
    const missing: string[] = [];
    if (!source.kind?.trim()) missing.push("kind");
    if (!source.name?.trim()) missing.push("name");
    if (!source.hash?.trim()) missing.push("hash");
    if (missing.length) failures.push(`source ${source.id}: missing ${missing.join(", ")}`);

    const { origin, originStatus } = describeOrigin(source, failures);
    records.push({
      sourceId: source.id,
      kind: source.kind,
      nameHash: nameHash(source.name),
      contentHash: source.hash,
      origin,
      originStatus,
      rightsDeclaration: source.rightsDeclared ? "declared" : "unrecorded",
    });
  }

  return { records, complete: failures.length === 0, failures };
};
