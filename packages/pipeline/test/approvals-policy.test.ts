import { describe, expect, it } from "vitest";
import { assertApprovalPolicy } from "../src/approvals.ts";

describe("approval policy", () => {
  it("refuses to approve a run that is not awaiting approval", () => {
    expect(() => assertApprovalPolicy({ status: "running", domain: "standard" }, {})).toThrow("not awaiting approval");
  });

  it("blocks medical publication without an identified clinician approver", () => {
    expect(() => assertApprovalPolicy({ status: "awaiting_approval", domain: "medical" }, {})).toThrow("clinician");
    expect(() => assertApprovalPolicy({ status: "awaiting_approval", domain: "medical" }, { clinicianApproverId: "123e4567-e89b-42d3-a456-426614174000" })).not.toThrow();
  });

  it("allows standard approval when awaiting approval", () => {
    expect(() => assertApprovalPolicy({ status: "awaiting_approval", domain: "standard" }, {})).not.toThrow();
  });
});
