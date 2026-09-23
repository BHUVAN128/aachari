# s02 Brave web research (source-less runs) — iteration log

## Scope
Source-less runs retrieve authoritative grounding through the official Brave
Search MCP server's `brave_llm_context` tool, then feed the existing locked
source-evidence-map → fact-pack path unchanged. This folder holds the sandbox
double and the deterministic suite; the client, ladder, and policy are shipped in
`packages/providers` and `packages/pipeline` (Phase 6 promotion done in the same
change).

## Evidence basis (server v2.1.4)
- `brave_llm_context` declares `count`, `maximum_number_of_tokens`,
  `maximum_number_of_tokens_per_url`, `maximum_number_of_snippets`, and
  `context_threshold_mode`, so the threshold ladder works against the unpatched
  server. No fork.
- The server embeds the HTTP status at the start of the flattened tool-error
  string (`new Error(\`${status} ${statusText}\n${body}\`)`), so auth/quota is
  classified from text, never an HTTP status.

## Modules
| Concern | Location |
| --- | --- |
| MCP stdio client, string classifier, pinned-schema assertion | `packages/providers/src/brave-mcp.ts` |
| Five-attempt escalating-timeout ladder, grounding parse, research entry | `packages/providers/src/brave.ts` |
| Untrusted-input policy + per-URL document assembly | `packages/pipeline/src/web-research.ts` |
| s02 retrieval branch (source-less) | `packages/pipeline/src/pipeline/stages/s02-research.ts` |
| Gap 3 semantic segmentation (promoted) | `packages/pipeline/src/context.ts` |
| Deterministic double | `fake-brave-mcp.ts` |
| DB-backed retrieval-half runner | `research-brave.ts` |

## Locked decisions
- Official `@brave/brave-search-mcp-server@2.1.4` via stdio. Version pinned; the
  client asserts the required schema keys at init and blocks loudly on drift
  (`BRAVE_SCHEMA_DRIFT`), so a narrowed schema can never silently no-op the ladder.
- No model fallback. Auth/quota are terminal; everything else retries.
- Five attempts, ceiling-compressed: timeouts 10/15/20/35/40 s, thresholds
  `strict → balanced → lenient → disabled → disabled`, attempt 5 broadens the
  query to topic keywords. Jittered backoff 1/2/4/8 s (~135 s worst case).
- Exhaustion throws `BraveResearchUnavailableError` with the client-safe message
  `Something went wrong. Please try again later.`; every attempt is written to the
  usage ledger first.

## Assertions (deterministic, zero network)
1. Classifier: 401/403/402/invalid-key/quota terminal; 429/5xx/malformed retryable.
2. Grounding parse drops malformed entries and ignores `poi`/`map`.
3. Ladder constants match the approved matrix.
4. Stub ladder: success on attempt 1; empty grounding exhausts all 5 with the
   client-safe message and backoff 1/2/4/8 s; terminal auth stops at 1 attempt.
5. Real fake MCP process: realistic string errors, schema drift blocked, child
   exit at startup is credential-class.
6. Policy: HTTPS-only, dedupe, minimum length, provenance hashes + byte size.
7. Promoted segmentation tiles losslessly and emits bounded overlap evidence.
8. Harness DB: source-less run → 2 `source_documents` rows + valid
   `source-evidence-map/v1` before the planning call; empty grounding yields zero
   fabricated sources and the client-safe failure message.

## How to run
```bash
node test/pipeline/steps/s02-research/brave/test.ts   # deterministic, zero network
```

## Status
- [x] deterministic suite green (zero network)
- [ ] live run green (real `BRAVE_API_KEY` + planning key)

## Live-run note
With no `OPENAI_API_KEY`, the planning call is visibly blocked after retrieval —
by design, the test asserts retrieval only.
