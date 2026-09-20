# WF3 — Transport recovery

## Scenario
A provider call is cut mid-response, hangs, or the worker crashes after paying for
TTS bytes but before its checkpoint commits. The run must retry only classified
transient transport failures, use the declared fallback route on a persistent
failure, and resume from the last valid checkpoint without paying twice.

## Recovery matrix
| Fault | Classification | Action |
| --- | --- | --- |
| truncated / closed body | `TRANSPORT_TRUNCATED` (retryable) | bounded retry, same route |
| hung socket | `TRANSPORT_TIMEOUT` (retryable) | abort, then retry; on exhaustion use declared fallback |
| crash before checkpoint | idempotent input hash | replay returns the existing artifact, no new provider call |

## Assertions (`run.ts`)
- truncated stream: attempt 1 `transport-truncated`, attempt 2 `completed`;
- hang: aborts, is classified `TRANSPORT_TIMEOUT`, and a retryable transport
  failure advances to the declared fallback route (`gpt-5.6-terra` → `gpt-5.6-sol`);
- idempotent replay: a second `saveArtifact` with the same `inputHash` returns the
  existing artifact and records no additional provider usage.

## Run
```bash
node test/pipeline/workflows/wf3-transport-recovery/run.ts
```
Gap 4 is test-local (`steps/s02-research/transport-hardening.ts`) and is promoted
to `packages/providers/src/errors.ts`, `openai.ts`, `gemini.ts`, and
`elevenlabs.ts` at Phase 6.
