/**
 * §11 M10 Tier C approval is a human gate, not a model stage. It is
 * handled directly by the executor (`processPipelineStage`) because the decision
 * is recorded through `approvals` and the run status transition, and because an
 * automated standard school/college release may advance without a handler.
 *
 * Keeping this module documents that the approval stage intentionally has no
 * `StageHandler` in the registry.
 */
export const APPROVAL_STAGE_IS_EXECUTOR_OWNED = true;