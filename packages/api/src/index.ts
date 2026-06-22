import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { registerJobRoutes } from "./routes/jobs";
import { registerHealthRoute } from "./routes/health";
import { connection } from "./queue";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(cors, { origin: process.env.XHS_CORS_ORIGIN ?? true });

  // Public-facing endpoint behind a promotion push: kept tight from day one
  // and backed by Redis so the limit holds across multiple API instances
  // (plan section 3). Tune up only once worker/account health data (see
  // GET /api/health) shows headroom — not before.
  await app.register(rateLimit, {
    max: 1,
    timeWindow: "1 minute",
    redis: connection,
  });

  await registerJobRoutes(app);
  await registerHealthRoute(app);

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
