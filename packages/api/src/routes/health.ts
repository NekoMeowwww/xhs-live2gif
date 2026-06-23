import { FastifyInstance } from "fastify";
import { HealthStatus } from "@xhs/shared";
import { connection } from "../queue";

const HEALTH_INSTANCES_SET_KEY = "xhs:health:instances";

export async function registerHealthRoute(app: FastifyInstance): Promise<void> {
  // Proxies the worker(s)' own 15-minute scheduled session-health checks
  // (each account+chrome+worker instance writes its own
  // xhs:health:last:<id> key — see AGENTS.md "横向扩容") — the API never
  // talks to opencli/Chrome directly. Aggregates across every instance that
  // has ever reported in, since one account being down still means a slice
  // of incoming jobs will fail even if the others are fine.
  app.get("/api/health", async (_request, reply) => {
    const instanceIds = await connection.smembers(HEALTH_INSTANCES_SET_KEY);
    if (instanceIds.length === 0) {
      return reply.send({ sessionOk: null, instances: {}, detail: "no health check has run yet" });
    }

    const instances: Record<string, HealthStatus> = {};
    for (const id of instanceIds) {
      const raw = await connection.get(`xhs:health:last:${id}`);
      if (raw) instances[id] = JSON.parse(raw) as HealthStatus;
    }

    const sessionOk = Object.values(instances).every((s) => s.sessionOk);
    return reply.send({ sessionOk, instances });
  });
}
