import Link from "next/link";
import { listRuns } from "@upcraft/pipeline";
import { StatusBadge } from "@/components/status-badge";

export const dynamic = "force-dynamic";

export default async function Home() {
  const runs = await listRuns();
  const completed = runs.filter((run) => run.status === "completed").length;
  const blocked = runs.filter((run) => run.status === "failed" || run.status === "awaiting_approval").length;
  return <main className="page"><div className="eyebrow">Local control plane</div><h1>Educational videos with evidence, not theater.</h1><p className="lede">Every run is frozen, traceable, capability-gated, and rendered from a typed manifest. PostgreSQL is the authority; workers may restart without pretending a video exists.</p>
    <div className="grid grid-3" style={{ marginTop: 36 }}><div className="card"><div className="card-label">Recent runs</div><div className="metric">{runs.length}</div></div><div className="card"><div className="card-label">Completed</div><div className="metric">{completed}</div></div><div className="card"><div className="card-label">Needs attention</div><div className="metric">{blocked}</div></div></div>
    <div className="card" style={{ marginTop: 24 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 12 }}><h2>Generation runs</h2><Link className="button button-primary" href="/runs/new">New run</Link></div>{runs.length ? runs.map((run) => <Link className="run-row" href={`/runs/${run.id}`} key={run.id}><div><div style={{ fontWeight: 600 }}>{run.title}</div><div className="mono muted" style={{ fontSize: 12, marginTop: 5 }}>{run.id}</div></div><div className="muted">{run.domain}</div><div className="muted">{run.currentStage ?? "reserved"}</div><StatusBadge status={run.status} /></Link>) : <div className="muted" style={{ padding: "30px 0" }}>No runs yet. Create one with a real source to begin.</div>}</div>
  </main>;
}
