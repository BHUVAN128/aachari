import { describe, expect, it } from "vitest";
import {
  decideRunRecovery,
  decideStageRecovery,
  nextStageAfter,
  recoveryDispatchKey,
  shouldSweepExpiredCheckpoint,
} from "../src/recovery.ts";

const now = new Date("2026-09-19T10:00:00.000Z");
const expired = new Date(now.getTime() - 1_000);
const active = new Date(now.getTime() + 60_000);

describe("stage lease recovery decisions", () => {
  it("resumes a stage that has no checkpoint at all", () => {
    expect(decideStageRecovery({ now, checkpoint: null })).toEqual({ action: "resume", dispatchKey: "recovery-1", reason: "missing_checkpoint" });
  });

  it("never steals a stage whose lease is still active", () => {
    expect(decideStageRecovery({ now, checkpoint: { outcome: "running", leaseExpiresAt: active, attemptCount: 1 } })).toBeNull();
  });

  it("recovers an expired lease with a new bounded attempt", () => {
    expect(decideStageRecovery({ now, checkpoint: { outcome: "running", leaseExpiresAt: expired, attemptCount: 2 } })).toEqual({
      action: "recover_expired_lease",
      dispatchKey: "recovery-3",
      reason: "expired_lease",
      attemptCount: 2,
    });
  });

  it("recovers a running checkpoint with no recorded expiry", () => {
    expect(decideStageRecovery({ now, checkpoint: { outcome: "running", leaseExpiresAt: null, attemptCount: 0 } })?.action).toBe("recover_expired_lease");
  });

  it("re-drives a stage whose checkpoint committed but whose dispatch was lost", () => {
    expect(decideStageRecovery({ now, checkpoint: { outcome: "failed", leaseExpiresAt: null, attemptCount: 1 } })).toEqual({
      action: "resume",
      dispatchKey: "recovery-2",
      reason: "checkpoint_not_owned",
    });
  });
});

describe("run crash recovery decisions", () => {
  it("re-inserts the preflight dispatch for a run reserved before its outbox row", () => {
    expect(decideRunRecovery({ now, run: { status: "queued", currentStage: null } })).toEqual({ action: "resume_preflight", reason: "queued_before_outbox" });
  });

  it("resumes a crash mid-stage from the latest checkpoint", () => {
    const decision = decideRunRecovery({
      now,
      run: { status: "running", currentStage: "research" },
      checkpoint: { outcome: "running", leaseExpiresAt: expired, attemptCount: 1 },
    });
    expect(decision).toEqual({ action: "resume_stage", stage: "research", dispatchKey: "recovery-2", reason: "expired_lease" });
  });

  it("leaves a stage alone while another worker holds an active lease", () => {
    expect(decideRunRecovery({
      now,
      run: { status: "running", currentStage: "script" },
      checkpoint: { outcome: "running", leaseExpiresAt: active, attemptCount: 1 },
    })).toBeNull();
  });

  it("advances to the next stage when the checkpoint committed but the dispatch was lost", () => {
    expect(decideRunRecovery({
      now,
      run: { status: "running", currentStage: "research" },
      checkpoint: { outcome: "valid", leaseExpiresAt: null, attemptCount: 1 },
    })).toEqual({ action: "advance_stage", stage: "fact-verification", dispatchKey: "recovery-advance", reason: "completed_stage_checkpoint" });
  });

  it("completes a run whose terminal stage checkpoint is already valid", () => {
    expect(decideRunRecovery({
      now,
      run: { status: "running", currentStage: "release-record" },
      checkpoint: { outcome: "valid", leaseExpiresAt: null, attemptCount: 1 },
    })).toEqual({ action: "complete_run", reason: "terminal_stage_checkpoint_valid" });
  });

  it("waits for the human approval instead of auto-advancing an awaiting approval checkpoint", () => {
    expect(decideRunRecovery({
      now,
      run: { status: "running", currentStage: "approval" },
      checkpoint: { outcome: "awaiting_approval", leaseExpiresAt: null, attemptCount: 1 },
    })).toBeNull();
  });

  it("marks a stage-less running run visibly failed rather than successful", () => {
    expect(decideRunRecovery({ now, run: { status: "running", currentStage: null } })).toEqual({ action: "fail_visible", reason: "running_without_stage" });
  });

  it("ignores runs that are already terminal or awaiting approval", () => {
    for (const status of ["completed", "failed", "awaiting_approval"]) {
      expect(decideRunRecovery({ now, run: { status, currentStage: "research" } })).toBeNull();
    }
  });
});

describe("expired checkpoint sweeping", () => {
  it("sweeps only expired running checkpoints", () => {
    expect(shouldSweepExpiredCheckpoint({ now, checkpoint: { outcome: "running", leaseExpiresAt: expired } })).toBe(true);
    expect(shouldSweepExpiredCheckpoint({ now, checkpoint: { outcome: "running", leaseExpiresAt: active } })).toBe(false);
    expect(shouldSweepExpiredCheckpoint({ now, checkpoint: { outcome: "valid", leaseExpiresAt: expired } })).toBe(false);
  });
});

describe("stage order helpers", () => {
  it("follows the governed stage order", () => {
    expect(nextStageAfter("preflight")).toBe("research");
    expect(nextStageAfter("preview-render")).toBe("qa");
    expect(nextStageAfter("release-record")).toBeUndefined();
  });

  it("never produces a duplicate recovery dispatch key", () => {
    expect(recoveryDispatchKey(0)).toBe("recovery-1");
    expect(recoveryDispatchKey(4)).toBe("recovery-5");
  });
});