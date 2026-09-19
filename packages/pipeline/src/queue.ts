import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { StageName } from "@upcraft/contracts";

export const PIPELINE_QUEUE = "video-pipeline";
export type PipelineJob = { runId: string; stage: StageName; dispatchKey?: string } | { sessionId: string };

let connection: IORedis | undefined;
let queue: Queue<PipelineJob> | undefined;

export const getQueueConnection = () => {
  if (!connection) {
    const url = process.env.VALKEY_URL;
    if (!url) throw new Error("VALKEY_URL is required");
    connection = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  }
  return connection;
};

export const getPipelineQueue = () => {
  if (!queue) {
    queue = new Queue<PipelineJob>(PIPELINE_QUEUE, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000, jitter: 0.25 },
        removeOnComplete: 1_000,
        removeOnFail: false,
      },
    });
  }
  return queue;
};

export const enqueueStage = async (runId: string, stage: StageName, dispatchKey = "initial") =>
  getPipelineQueue().add(stage, { runId, stage, dispatchKey }, { jobId: `${runId}--${stage}--${dispatchKey}`, removeOnComplete: 1_000 });

export const enqueueIntakeSession = async (sessionId: string) =>
  getPipelineQueue().add("intake", { sessionId }, { jobId: `intake--${sessionId}`, removeOnComplete: 1_000 });

export const publishRunSignal = async (runId: string) => {
  await getQueueConnection().publish(`run:${runId}`, String(Date.now()));
};

export const closeQueue = async () => {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
};
