import assert from "node:assert/strict";
import { resolveModelRoute } from "@upcraft/providers";
import { withFallback } from "@upcraft/pipeline/stages";
import { classifyTransportError, fetchWithTimeout, startFlakyServer, withTransportRetry, TransportError, TRANSPORT_TRUNCATED, type RetryAttempt } from "./transport-hardening.ts";

/**
 * s02 — Gap 4 transport hardening (deterministic, local flaky server).
 *
 * Asserts:
 *   1. a truncated body surfaces as a classified retryable TransportError
 *      (TRANSPORT_TRUNCATED), and a bounded retry then succeeds;
 *   2. a hung socket aborts on timeout and is classified `timeout`;
 *   3. a classified transport failure on the primary route advances to the
 *      declared fallback route through the existing `withFallback` policy.
 */
const main = async () => {
  // --- truncated stream → retryable → bounded retry succeeds ---
  const truncating = await startFlakyServer({ failFirst: 1, body: JSON.stringify({ ok: true, payload: "x".repeat(200) }) });
  try {
    const attempts: RetryAttempt[] = [];
    const value = await withTransportRetry({
      maxAttempts: 3,
      attempt: async () => {
        const response = await fetchWithTimeout(truncating.url, { timeoutMs: 5_000 });
        return (await response.json()) as { ok: boolean };
      },
      onAttempt: (record) => {
        attempts.push(record);
      },
    });
    assert.equal(value.ok, true);
    assert.deepEqual(attempts.map((entry) => entry.outcome), ["transport-truncated", "completed"]);
    assert.equal(attempts[0]!.errorCode, TRANSPORT_TRUNCATED);
    console.log(`  Gap 4: truncated stream retried → ${attempts.map((entry) => entry.outcome).join(" → ")}`);
  } finally {
    await truncating.close();
  }

  // --- hang → timeout → classified, bounded, then terminal ---
  const hanging = await startFlakyServer({ hangFirst: 5 });
  try {
    const attempts: RetryAttempt[] = [];
    let terminal: unknown = null;
    try {
      await withTransportRetry({
        maxAttempts: 2,
        attempt: () => fetchWithTimeout(hanging.url, { timeoutMs: 150 }),
        onAttempt: (record) => {
          attempts.push(record);
        },
      });
    } catch (error) {
      terminal = error;
    }
    assert.deepEqual(attempts.map((entry) => entry.outcome), ["transport-timeout", "transport-timeout"]);
    assert.equal(classifyTransportError(terminal).code, "TRANSPORT_TIMEOUT");
    console.log(`  Gap 4: hang → ${attempts.map((entry) => entry.outcome).join(" → ")} (terminal TRANSPORT_TIMEOUT)`);
  } finally {
    await hanging.close();
  }

  // --- fallback route on a classified transport failure ---
  const route = resolveModelRoute("planning"); // has a declared fallback (gpt-5.6-sol)
  const used: string[] = [];
  const fallbackValue = await withFallback(
    route,
    async (attemptRoute) => {
      used.push(attemptRoute.model);
      if (attemptRoute.model === route.model) throw new TransportError("truncated", "simulated transport truncation");
      return { ok: true };
    },
    async () => undefined,
  );
  assert.deepEqual(used, [route.model, "gpt-5.6-sol"], "a retryable transport failure must advance to the declared fallback route");
  assert.equal(fallbackValue.route.model, "gpt-5.6-sol");
  console.log(`  Gap 4: fallback route used → ${used.join(" → ")}`);

  console.log("transport PASS");
};

main().catch((error) => {
  console.error("transport FAIL:", error);
  process.exit(1);
});