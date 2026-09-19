import type { RunStatus } from "@upcraft/contracts";

export const StatusBadge = ({ status }: { status: RunStatus }) => <span className={`status status-${status}`}><span className="dot" />{status.replace("_", " ")}</span>;
