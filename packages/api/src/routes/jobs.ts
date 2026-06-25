import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import { isAllowedInputUrl, isValidOutputFormat, OutputFormat } from "@xhs/shared";
import { enqueueJob, getJobStatus } from "../queue";

interface CreateJobBody {
  url?: string;
  format?: OutputFormat;
}

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  // This allowlist check is the system's main SSRF/abuse boundary — reject
  // anything that isn't a Xiaohongshu note URL/short-link before it ever
  // reaches the queue or the logged-in browser (plan section 3).
  // Rate limit only applies here, not to the GET status-polling route below
  // — see the `global: false` note in src/index.ts for why that matters.
  app.post<{ Body: CreateJobBody }>("/api/jobs", { config: { rateLimit: {} } }, async (request, reply) => {
    const url = request.body?.url;
    if (!url || typeof url !== "string" || !isAllowedInputUrl(url)) {
      return reply.code(400).send({
        error: "Only xiaohongshu.com or xhslink.com note links are accepted.",
      });
    }

    // Default to "gif" so callers that predate the format option keep working
    // unchanged.
    const format = request.body?.format ?? "gif";
    if (!isValidOutputFormat(format)) {
      return reply.code(400).send({ error: 'format must be "gif" or "mp4".' });
    }

    const jobId = randomUUID();
    await enqueueJob({
      jobId,
      url,
      format,
      clientIp: request.ip,
      submittedAt: new Date().toISOString(),
    });

    return reply.code(202).send({ jobId });
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const status = await getJobStatus(request.params.jobId);
    if (!status) return reply.code(404).send({ error: "job not found" });
    return reply.send(status);
  });
}
