import { FastifyInstance } from "fastify";
import { connection } from "../queue";

const HEALTH_STATUS_KEY = "xhs:health:last";

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  // Proxies the worker's own 15-minute scheduled session-health check
  // (written to this Redis key by packages/worker/src/index.ts) — the API
  // never talks to opencli/Chrome directly.
  app.get("/api/health", async (_request, reply) => {
    const raw = await connection.get(HEALTH_STATUS_KEY);
    if (!raw) {
      return reply.send({ sessionOk: null, lastChecked: null, detail: "no health check has run yet" });
    }
    return reply.send(JSON.parse(raw));
  });
}
