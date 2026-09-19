import { resolveCapabilities } from "@upcraft/providers";

export const dynamic = "force-dynamic";
export default function CapabilitiesPage() {
  const capabilities = resolveCapabilities("medical");
  return <main className="page"><div className="eyebrow">Capability preflight</div><h1>Configuration is a release gate.</h1><p className="lede">Provider and renderer credentials are only assessed server-side. This page exposes availability, never secret values.</p><div className="card" style={{ marginTop: 32 }}>{capabilities.map((capability) => <div className="run-row" key={capability.capability}><div style={{ fontWeight: 600 }}>{capability.capability}</div><div className="muted" style={{ gridColumn: "span 2" }}>{capability.available ? "Available" : capability.reason}</div><span className={`status ${capability.available ? "status-completed" : "status-failed"}`}><span className="dot" />{capability.available ? "ready" : "blocked"}</span></div>)}</div></main>;
}
