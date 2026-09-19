import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { ViewerOutcomeInputSchema } from "@upcraft/contracts";
import { listViewerOutcomes, recordViewerOutcome } from "@upcraft/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveRecorder = async () => {
  if (!process.env.CLERK_SECRET_KEY) return "local-operator";
  const { userId } = await auth();
  return userId;
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const outcomes = await listViewerOutcomes(id);
  return NextResponse.json({ outcomes });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const recordedBy = await resolveRecorder();
    if (!recordedBy) return NextResponse.json({ error: "Authentication is required to record feedback." }, { status: 401 });
    const payload = await request.json();
    const input = ViewerOutcomeInputSchema.parse(payload);
    const outcome = await recordViewerOutcome(id, input, recordedBy);
    return NextResponse.json({ outcome }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to record viewer outcome." }, { status: 400 });
  }
}
