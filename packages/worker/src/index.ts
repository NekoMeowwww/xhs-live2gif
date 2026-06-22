import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import { JobPayload, JobResult } from "@xhs/shared";
import { processJob } from "./pipeline";
import { checkSessionHealth } from "./health";

const REDIS_URL = process.env.XHS_REDIS_URL ?? "redis://127.0.0.1:6379";
const QUEUE_NAME = "xhs-extract";
const HEALTH_QUEUE_NAME = "xhs-health";
const HEALTH_STATUS_KEY = "xhs:health:last";
const ALERT_WEBHOOK_URL = process.env.XHS_ALERT_WEBHOOK_URL;

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

async function sendAlert(message: string): Promise<void> {
  console.error(`[ALERT] ${message}`);
  if (!ALERT_WEBHOOK_URL) return;
  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error(`[ALERT] webhook delivery failed: ${String(err)}`);
  }
}

// Exactly one Chrome/CDP session behind one logged-in account: concurrency
// must stay at 1. This is a hard architectural constraint (plan section 2),
// not a tuning knob — scale by adding more account+chrome+worker triplets
// consuming this same queue, never by raising this number.
const extractWorker = new Worker<JobPayload, JobResult>(
  QUEUE_NAME,
  async (job) => processJob(job.data.jobId, job.data.url),
  {
    connection,
    concurrency: 1,
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
);

extractWorker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed: ${String(err)}`);
});

let lastSessionOk = true;

const healthWorker = new Worker(
  HEALTH_QUEUE_NAME,
  async () => {
    const status = await checkSessionHealth();
    await connection.set(HEALTH_STATUS_KEY, JSON.stringify(status));
    if (!status.sessionOk && lastSessionOk) {
      await sendAlert(`XHS session unhealthy: ${status.detail ?? "unknown"} — see docs/runbook-relogin.md`);
    }
    lastSessionOk = status.sessionOk;
    return status;
  },
  { connection, concurrency: 1 },
);

healthWorker.on("failed", (job, err) => {
  console.error(`[health] check threw: ${String(err)}`);
});

async function scheduleHealthCheck(): Promise<void> {
  const healthQueue = new Queue(HEALTH_QUEUE_NAME, { connection });
  await healthQueue.add(
    "check",
    {},
    {
      repeat: { every: 15 * 60 * 1000 },
      jobId: "xhs-health-check",
    },
  );
}

scheduleHealthCheck().catch((err) => {
  console.error(`[health] failed to schedule repeatable check: ${String(err)}`);
});

console.log(`[worker] listening on queue "${QUEUE_NAME}" (concurrency=1); health checks every 15min`);
