import { MODEL_ROUTES, modelEnvKey, resolveCapabilities, resolveModelRoute } from "@upcraft/providers";
import type { ModelCapability } from "@upcraft/contracts";

export const dynamic = "force-dynamic";

const MODEL_CAPABILITIES = Object.keys(MODEL_ROUTES) as ModelCapability[];

export default function CapabilitiesPage() {
  const capabilities = resolveCapabilities("medical");
  return <main className="page"><div className="eyebrow">Capability preflight</div><h1>Configuration is a release gate.</h1><p className="lede">Provider and renderer credentials are only assessed server-side. This page exposes availability and the resolved model route, never secret values.</p><div className="card" style={{ marginTop: 32 }}>{capabilities.map((capability) => <div className="run-row" key={capability.capability}><div style={{ fontWeight: 600 }}>{capability.capability}</div><div className="muted" style={{ gridColumn: "span 2" }}>{capability.available ? "Available" : capability.reason}{capability.model ? ` — ${capability.model}` : ""}</div><span className={`status ${capability.available ? "status-completed" : "status-failed"}`}><span className="dot" />{capability.available ? "ready" : "blocked"}</span></div>)}</div><div className="eyebrow" style={{ marginTop: 40 }}>Resolved model routes</div><p className="lede">Routing is defined in <code>packages/providers/src/model-config.ts</code>. Change one registry entry or one environment ref to reroute a stage.</p><div className="card">{MODEL_CAPABILITIES.map((capability) => { const route = resolveModelRoute(capability); return <div className="run-row" key={capability}><div style={{ fontWeight: 600 }}>{capability}</div><div className="muted">{route.modelRef}</div><div className="muted">{route.resolvedFrom === "env" ? `override via ${modelEnvKey(capability)}` : "approved default"}</div></div>; })}</div></main>;
}
