import { config } from "dotenv";
import { Worker } from "bullmq";
import { closeDb } from "@upcraft/db";
import { appendRunEvent, closeQueue, getQueueConnection, PIPELINE_QUEUE, recoverReservedRuns, setRunStatus, type PipelineJob } from "@upcraft/pipeline";
import { processIntakeSession } from "@upcraft/pipeline/intake";
import { processPipelineStage } from "@upcraft/pipeline/stages";

config({ path: "../../.env.local" });
config({ path: "../../.env" });

const worker = new Worker<PipelineJob>(PIPELINE_QUEUE, async (job) => {
  if ("sessionId" in job.data) await processIntakeSession(job.data.sessionId);
  else await processPipelineStage(job.data.runId, job.data.stage);
}, { connection: getQueueConnection(), concurrency: 1, lockDuration: 300_000 });

worker.on("completed", (job) => console.log(`[worker] ${job.id} completed`));
worker.on("failed", (job, error) => {
  console.error(`[worker] ${job?.id ?? "unknown"} failed: ${error.message}`);
  const data = job?.data;
  if (job && data && job.attemptsMade >= (job.opts.attempts ?? 1) && "runId" in data) {
    void setRunStatus(data.runId, "failed", { stage: data.stage, failureCode: "RETRY_EXHAUSTED", failureMessage: error.message.slice(0, 500) })
      .then(() => appendRunEvent(data.runId, data.stage, "stage_failed", `${data.stage} exhausted transient retries: ${error.message.slice(0, 500)}`, { attempts: job.attemptsMade }));
  }
});

const shutdown = async () => {
  await worker.close();
  await closeQueue();
  await closeDb();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
console.log("[worker] Waiting for durable pipeline jobs.");
await recoverReservedRuns();
