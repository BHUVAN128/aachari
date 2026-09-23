import { createHash } from "node:crypto";

/**
 * W1 — curated-domain-term consistency + voice-aware idempotency (test-local
 * first; promoted into `packages/pipeline/src/media-qa.ts` and shared by s08/s13
 * at Phase 6).
 *
 * Defects this closes:
 *  - s08 derives curated terms from the *raw* fact pack (`fact-pack/v2`) while s13
 *    re-derives them from `verified-fact-pack/v1`. Two independent derivations can
 *    disagree, and unverified claim tokens land in the `voiceover/v1` content and
 *    `media_assets.provenance.curatedTerms` the release record must preserve.
 *  - `curatedDomainTerms` sorts purely by token length and slices to the limit, so
 *    40+ long hallucinated-claim tokens can starve a short narration term that is
 *    the only enforceable one (`validatePronunciation` only checks terms present
 *    in the narration text).
 *  - `inputHash = sha([script, curatedTerms])` omits voice identity, so changing
 *    `ELEVENLABS_VOICE_ID` or the voice model replays the old voice's audio.
 *
 * The single derivation below gives narration-derived terms absolute priority
 * (they are the only ones the narration guard can enforce) and fills the
 * remaining budget from verified-claim-only terms. There is one function for both
 * s08 and s13, so the two gates can never diverge.
 */

const normalizeTerm = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const ACRONYM_PATTERN = /\b[A-Z]{2,6}\b/g;

/** Mirrors `media-qa.ts::curatedDomainTerms` tokenization so promotion is a move. */
export const deriveDomainTerms = (texts: string[], minLength = 8): string[] => {
  const terms = new Set<string>();
  for (const text of texts) {
    for (const token of text.split(/\s+/)) {
      const cleaned = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const normalized = normalizeTerm(cleaned);
      if (normalized.length >= minLength && /[\p{L}]/u.test(normalized)) terms.add(normalized);
    }
    for (const acronym of text.match(ACRONYM_PATTERN) ?? []) terms.add(normalizeTerm(acronym));
  }
  return [...terms];
};

const rank = (terms: string[]) => [...new Set(terms)].sort((a, b) => b.length - a.length || a.localeCompare(b));

/**
 * The one curated-term derivation. Narration terms are always included first;
 * verified-claim-only terms fill the remaining limit budget longest-first.
 */
export const buildCuratedTerms = (params: {
  narrationText: string;
  verifiedClaimTexts: string[];
  minLength?: number;
  limit?: number;
}): string[] => {
  const limit = params.limit ?? 40;
  const narrationTerms = rank(deriveDomainTerms([params.narrationText], params.minLength ?? 8));
  const narrationSet = new Set(narrationTerms);
  const claimTerms = rank(deriveDomainTerms(params.verifiedClaimTexts, params.minLength ?? 8)).filter((term) => !narrationSet.has(term));
  return [...narrationTerms, ...claimTerms].slice(0, limit);
};

export type VoiceIdentity = { provider: string; model: string; voiceId?: string | null };

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Replay identity for the voiceover stage. Binds the locked script and the
 * verified fact pack (never the raw pack) plus the voice provider/model/id, so a
 * voice change invalidates the cached audio and a re-verification that changes the
 * verified pack invalidates it too, while a raw-pack-only change does not.
 */
export const voiceoverInputHash = (params: { script: unknown; verifiedFactPack: unknown; voice: VoiceIdentity }): string =>
  sha([
    params.script,
    params.verifiedFactPack,
    { provider: params.voice.provider, model: params.voice.model, voiceId: params.voice.voiceId ?? null },
  ]);
