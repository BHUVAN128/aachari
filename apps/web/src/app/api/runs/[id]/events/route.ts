import { getRunEvents } from "@upcraft/pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      let cursor = Number.isFinite(after) ? after : 0;
      const write = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      while (!cancelled) {
        const events = await getRunEvents(id, cursor);
        for (const event of events) {
          cursor = event.sequence;
          write({ ...event, stage: event.stage, type: event.type, data: { ...event.data, sequence: event.sequence }, createdAt: event.createdAt.toISOString() });
        }
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
