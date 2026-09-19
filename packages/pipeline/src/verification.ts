import type { ApprovedScript, ClaimVerification, FactPack, ScriptVerification } from "@upcraft/contracts";

/**
 * Pure reducers over separately routed verification output. A generator must
 * never be the sole authority on its own artifact, so these checks are the
 * deterministic gate that decides whether a verified fact pack or script may
 * advance.
 */
export const unsupportedClaimIds = (verification: ClaimVerification) =>
  verification.evidence.filter((entry) => !entry.supported).map((entry) => entry.claimId);

export const assertClaimVerificationComplete = (verification: ClaimVerification, factPack: FactPack) => {
  const claims = factPack.claims;
  const evaluated = verification.evidence;
  if (evaluated.length !== claims.length || new Set(evaluated.map((entry) => entry.claimId)).size !== claims.length || claims.some((claim) => !evaluated.some((entry) => entry.claimId === claim.id))) {
    throw new Error("Independent verification did not check every fact-pack claim exactly once");
  }
  for (const entry of evaluated) {
    const claim = claims.find((candidate) => candidate.id === entry.claimId);
    if (!claim || claim.evidence.sourceId !== entry.sourceId) throw new Error(`Independent verification changed evidence identity for claim ${entry.claimId}`);
  }
  const unsupported = unsupportedClaimIds(verification);
  if (unsupported.length) throw new Error(`Independent verification rejected claims: ${unsupported.join(", ")}`);
};

export const assertScriptVerificationComplete = (verification: ScriptVerification, script: ApprovedScript) => {
  const lines = script.narration;
  const evaluated = verification.evidence;
  if (evaluated.length !== lines.length || new Set(evaluated.map((entry) => entry.lineId)).size !== lines.length || lines.some((line) => !evaluated.some((entry) => entry.lineId === line.id))) {
    throw new Error("Independent script verification did not check every script line exactly once");
  }
  if (evaluated.some((entry) => !entry.supported || entry.unsupportedClaimIds.length)) throw new Error("Independent script verification rejected unsupported narration");
};
