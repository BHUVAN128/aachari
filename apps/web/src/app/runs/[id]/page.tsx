import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun, getRunEvents, getRunUsageSummary } from "@upcraft/pipeline";
import { RunEvents } from "@/components/run-events";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [run, events, usage] = await Promise.all([getRun(id), getRunEvents(id), getRunUsageSummary(id)]);
  if (!run) notFound();
  const clientEvents = events.map((event) => ({ ...event, stage: event.stage, type: event.type as "status", data: { ...event.data, sequence: event.sequence }, createdAt: event.createdAt.toISOString() }));
  return <main className="page"><div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 18 }}><div><div className="eyebrow">{run.domain} / immutable run</div><h1 style={{ fontSize: "clamp(34px,4vw,58px)" }}>{run.title}</h1><div className="mono muted">{run.id}</div></div><StatusBadge status={run.status} /></div>
    {run.failureMessage ? <div className="error" style={{ marginTop: 24 }}><strong>{run.failureCode ?? "Failure"}</strong><br />{run.failureMessage}</div> : null}
    <div className="grid grid-2" style={{ marginTop: 28 }}><section className="card"><h2>Pipeline evidence</h2><div style={{ marginTop: 12 }}><RunEvents runId={run.id} initialEvents={clientEvents as never} /></div></section><section className="card"><h2>Locked input</h2><dl style={{ display: "grid", gridTemplateColumns: "130px 1fr", gap: "12px 16px", marginTop: 18, fontSize: 14 }}><dt className="muted">Level</dt><dd>{run.snapshot.learningLevel}</dd><dt className="muted">Duration</dt><dd>{run.snapshot.durationSeconds}s</dd><dt className="muted">Format</dt><dd>{run.snapshot.aspectRatio}</dd><dt className="muted">Language</dt><dd>{run.snapshot.language}</dd><dt className="muted">Snapshot hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{run.snapshotHash}</dd></dl>{run.status === "awaiting_approval" ? <Link href={`/runs/${run.id}/approval`} className="button button-primary" style={{ display: "inline-block", marginTop: 22 }}>Review approval</Link> : null}</section></div>
    <section className="card" style={{ marginTop: 28 }}><h2>Usage accounting</h2><dl style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "10px 16px", marginTop: 18, fontSize: 14 }}><dt className="muted">Provider attempts</dt><dd>{usage.attempts} ({usage.failedAttempts} failed)</dd><dt className="muted">Input tokens</dt><dd>{usage.inputTokens.toLocaleString()} ({usage.cachedInputTokens.toLocaleString()} cached)</dd><dt className="muted">Output tokens</dt><dd>{usage.outputTokens.toLocaleString()} ({usage.reasoningTokens.toLocaleString()} reasoning)</dd><dt className="muted">Input characters</dt><dd>{usage.inputCharacters.toLocaleString()}</dd><dt className="muted">Estimated provider cost</dt><dd>{usage.costMicrounits === null ? `Unpriced (${usage.unpricedAttempts} attempt${usage.unpricedAttempts === 1 ? "" : "s"})` : `$${(usage.costMicrounits / 1_000_000).toFixed(6)}`}</dd></dl></section>
  </main>;
}
