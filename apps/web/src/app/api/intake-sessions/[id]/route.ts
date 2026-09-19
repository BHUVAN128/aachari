import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb, intakeSessions } from "@upcraft/db";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getDb().query.intakeSessions.findFirst({ where: eq(intakeSessions.id, id), columns: { id: true, status: true, videoRunId: true, failureCode: true, failureMessage: true, createdAt: true, updatedAt: true } });
  if (!session) return NextResponse.json({ error: "Intake session not found." }, { status: 404 });
  return NextResponse.json({ sessionId: session.id, status: session.status, runId: session.videoRunId, error: session.status === "failed" ? session.failureMessage : null, createdAt: session.createdAt, updatedAt: session.updatedAt });
}
