import { Queue, Job } from "bullmq";
import IORedis from "ioredis";
import { JobPayload, JobResult } from "@xhs/shared";

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
  | { status: "queued" | "processing" }
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
  if (state === "active") {
    return { status: "processing" };
  }
  return { status: "queued" };
}
