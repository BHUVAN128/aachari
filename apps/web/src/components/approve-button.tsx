"use client";
import { useState, useTransition } from "react";
import { motion } from "framer-motion";
import { approveRunAction } from "@/app/actions";

export const ApproveButton = ({ runId }: { runId: string }) => {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  return <div><motion.button className="button button-primary" disabled={pending} whileTap={{ scale: .98 }} onClick={() => startTransition(async () => { try { setError(undefined); await approveRunAction(runId); window.location.assign(`/runs/${runId}`); } catch (reason) { setError(reason instanceof Error ? reason.message : "Approval failed"); } })}>{pending ? "Recording approval…" : "Approve and render"}</motion.button>{error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}</div>;
};
