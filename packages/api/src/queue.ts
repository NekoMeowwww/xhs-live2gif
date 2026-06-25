import { Queue, Job } from "bullmq";
import IORedis from "ioredis";
import { JobPayload, JobResult, JobProgress } from "@xhs/shared";

const REDIS_URL = process.env.XHS_REDIS_URL ?? "redis://127.0.0.1:6379";

// Shared by the rate-limit plugin too, so limits are enforced across all API
// instances rather than per-process (plan section 3).
export const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

export const extractQueue = new Queue<JobPayload, JobResult>("xhs-extract", { connection });

export async function enqueueJob(payload: JobPayload): Promise<void> {
  await extractQueue.add("extract", payload, {
    jobId: payload.jobId,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  });
}

export type JobStatusResponse =
  | { status: "queued"; progress?: JobProgress; queuePosition?: number; queueTotal?: number }
  | { status: "processing"; progress?: JobProgress }
  | { status: "done" | "failed"; result: JobResult };

export async function getJobStatus(jobId: string): Promise<JobStatusResponse | null> {
  const job = await Job.fromId<JobPayload, JobResult>(extractQueue, jobId);
  if (!job) return null;

  const state = await job.getState();

  if (state === "completed") {
    return { status: "done", result: job.returnvalue };
  }
  if (state === "failed") {
    return {
      status: "failed",
      result: { status: "failed", error: job.failedReason ?? "unknown error" },
    };
  }
  // job.progress is whatever was last passed to job.updateProgress() in the
  // worker (see packages/worker/src/index.ts) — absent until the pipeline's
  // first onProgress call lands, hence the JobProgress-shape check.
  const progress = isJobProgress(job.progress) ? job.progress : undefined;
  if (state === "active") {
    return { status: "processing", progress };
  }

  // FIFO position among still-waiting jobs — cheap at this scale, since the
  // 1/minute submission rate limit (src/index.ts) keeps this list short.
  // jobId can be momentarily absent from the snapshot if the job transitions
  // to active between the getState() call above and this one; just omit the
  // position fields in that case rather than guessing.
  const waiting = await extractQueue.getWaiting();
  const position = waiting.findIndex((j) => j.id === jobId);
  if (position === -1) {
    return { status: "queued", progress };
  }
  return { status: "queued", progress, queuePosition: position + 1, queueTotal: waiting.length };
}

function isJobProgress(value: unknown): value is JobProgress {
  return typeof value === "object" && value !== null && "percent" in value && "stage" in value;
}
