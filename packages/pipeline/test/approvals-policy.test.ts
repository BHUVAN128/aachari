import { describe, expect, it } from "vitest";
import { assertApprovalPolicy } from "../src/approvals.ts";

describe("approval policy", () => {
  it("refuses to approve a run that is not awaiting approval", () => {
    expect(() => assertApprovalPolicy({ status: "running", domain: "standard" }, { reviewerId: "reviewer-1" })).toThrow("not awaiting approval");
  });

  it("allows approval for every domain once a run is awaiting approval", () => {
    expect(() => assertApprovalPolicy({ status: "awaiting_approval", domain: "standard" }, { reviewerId: "reviewer-1" })).not.toThrow();
    expect(() => assertApprovalPolicy({ status: "awaiting_approval", domain: "engineering" }, { reviewerId: "reviewer-1" })).not.toThrow();
    expect(() => assertApprovalPolicy({ status: "awaiting_approval", domain: "client-production" }, { reviewerId: "reviewer-1" })).not.toThrow();
  });
});
