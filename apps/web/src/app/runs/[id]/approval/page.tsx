import { notFound } from "next/navigation";
import { getRun } from "@upcraft/pipeline";
import { ApproveButton } from "@/components/approve-button";

export const dynamic = "force-dynamic";
export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();
  if (run.status !== "awaiting_approval") return <main className="page"><h1>Approval is unavailable.</h1><p className="lede">This run is not at the approval checkpoint.</p></main>;
  return <main className="page"><div className="eyebrow">Release gate</div><h1>Review before final render.</h1><p className="lede">This action releases the approved preview to the final render queue.</p><section className="card" style={{ marginTop: 30, maxWidth: 760 }}><h2>{run.title}</h2><div className="mono muted" style={{ margin: "10px 0 22px" }}>{run.id}</div><ApproveButton runId={run.id} /></section></main>;
}
