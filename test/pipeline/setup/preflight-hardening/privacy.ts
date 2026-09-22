import { createHash } from "node:crypto";

/**
 * s01 Preflight hardening — privacy / secret scan (risk R2).
 *
 * User-supplied sources can carry personal data or live credentials that would
 * otherwise flow straight to third-party providers (OpenAI, Google, ElevenLabs),
 * which is a GDPR / India-DPDP exposure. This module detects candidate PII and
 * secrets deterministically and records only category names, counts, and SHA-256
 * hashes — never the raw matched value. That keeps the compliance artifact itself
 * from becoming a second copy of the private data.
 */

export type PiiKind = "email" | "phone" | "card" | "api-key" | "secret" | "iban";

export type PiiFinding = {
  kind: PiiKind;
  count: number;
  sampleHash: string | null;
};

export type PrivacyScan = {
  findings: PiiFinding[];
  total: number;
};

/** Credentials and high-risk financial identifiers block; contact PII records. */
export const PRIVACY_BLOCKING_KINDS: readonly PiiKind[] = ["card", "api-key", "secret", "iban"];
export const PRIVACY_RECORD_ONLY_KINDS: readonly PiiKind[] = ["email", "phone"];

const hashed = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const matches = (text: string, pattern: RegExp): string[] => {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return [...text.matchAll(global)].map((match) => match[0]).filter((value) => value.trim().length > 0);
};

const digitsOnly = (value: string) => value.replace(/\D/g, "");

/** Standard Luhn checksum so a random 16-digit number is not treated as a card. */
export const passesLuhn = (value: string): boolean => {
  const digits = digitsOnly(value);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

/**
 * Candidate payment-card numbers. Luhn is applied afterward so counts and hashes
 * only ever cover values that pass the checksum.
 */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Contact-shaped patterns: require a separator so a bare card number is not also a phone. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /\b(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}\b/g;

/** Common credential/key shapes. These are blocking because they are secrets. */
const API_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

const SECRET_ASSIGNMENT = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/gi;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

const findingFor = (kind: PiiKind, values: string[]): PiiFinding | null =>
  values.length ? { kind, count: values.length, sampleHash: hashed(values[0]!) } : null;

/** Scans one text for candidate PII/secrets and returns counts plus hashes only. */
export const scanForPii = (text: string): PrivacyScan => {
  const cards = matches(text, CARD_CANDIDATE).filter(passesLuhn);
  const apiKeys = API_KEY_PATTERNS.flatMap((pattern) => matches(text, pattern));
  const candidates: Array<PiiFinding | null> = [
    findingFor("email", matches(text, EMAIL)),
    findingFor("phone", matches(text, PHONE)),
    findingFor("card", cards),
    findingFor("api-key", apiKeys),
    findingFor("secret", matches(text, SECRET_ASSIGNMENT)),
    findingFor("iban", matches(text, IBAN)),
  ];
  const findings = candidates.filter((finding): finding is PiiFinding => finding !== null);
  return { findings, total: findings.reduce((sum, finding) => sum + finding.count, 0) };
};

export type PrivacyGateDecision = {
  allowed: boolean;
  failureCode: "privacy_blocked" | null;
  blockingKinds: PiiKind[];
};

/**
 * Credentials and high-risk financial identifiers block the run; benign contact
 * PII is recorded for due diligence without stopping an otherwise valid lesson.
 * A block is terminal and must never be retried.
 */
export const decidePrivacyGate = (scan: PrivacyScan): PrivacyGateDecision => {
  const blockingKinds = scan.findings
    .filter((finding) => finding.count > 0 && PRIVACY_BLOCKING_KINDS.includes(finding.kind))
    .map((finding) => finding.kind);
  return blockingKinds.length
    ? { allowed: false, failureCode: "privacy_blocked", blockingKinds }
    : { allowed: true, failureCode: null, blockingKinds: [] };
};

/** Merges per-source scans into one report-level scan without losing counts. */
export const mergePrivacyScans = (scans: ReadonlyArray<PrivacyScan>): PrivacyScan => {
  const byKind = new Map<PiiKind, PiiFinding>();
  for (const scan of scans) {
    for (const finding of scan.findings) {
      const existing = byKind.get(finding.kind);
      if (!existing) byKind.set(finding.kind, { ...finding });
      else existing.count += finding.count;
    }
  }
  const findings = [...byKind.values()];
  return { findings, total: findings.reduce((sum, finding) => sum + finding.count, 0) };
};
