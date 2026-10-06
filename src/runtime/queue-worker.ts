import { createServer } from "node:http";
import { openPostgresRuntime, STAGE_QUEUE, DEAD_QUEUE } from "./postgres-queue.js";
import type { StageJobPayload } from "./jobs.js";
import { runStageInSandbox, type E2BSandboxResult } from "./sandbox.js";
import { createReviewMemory } from "./review-memory.js";
import type { AuditEvent } from "../audit/events.js";

async function main() {
  if (process.env.SHOPFLOOR_EXECUTION_MODE !== "local" && (!process.env.E2B_API_KEY || !process.env.SHOPFLOOR_E2B_TEMPLATE)) {
    throw new Error("Configure E2B_API_KEY and SHOPFLOOR_E2B_TEMPLATE before starting the worker");
  }
  if (process.env.NODE_ENV === "production" && process.env.SHOPFLOOR_EXECUTION_MODE === "local") throw new Error("Local execution is development-only");
  const runtime = await openPostgresRuntime(process.env.DATABASE_URL ?? "");
  const memory = createReviewMemory(runtime.pool);
  let stopping = false;
  const server = createServer(async (_req, res) => {
    try {
      await runtime.pool.query("SELECT 1");
      res.writeHead(stopping ? 503 : 200).end(stopping ? "stopping" : "ready");
    } catch { res.writeHead(503).end("database unavailable"); }
  });
  server.listen(Number(process.env.SHOPFLOOR_WORKER_HEALTH_PORT ?? 3011), "0.0.0.0");
  await runtime.boss.work<StageJobPayload>(STAGE_QUEUE, { batchSize: 1, localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const payload = job.data;
    const previous = await runtime.store.getRun(payload.runId);
    if (!previous) throw new Error("Queue job has no durable run");
    if (previous.status === "succeeded" || previous.status === "skipped") return;
    await runtime.store.updateRun(payload.runId, { status: "running", errorMessage: "" });
    try {
      if (memory && payload.stage === "review") {
        const pr = (payload.event.payload as unknown as { pull_request?: { title?: string; body?: string } }).pull_request;
        payload.historicalFindings = await memory.retrieve(payload.owner, payload.repo, `${pr?.title ?? ""}\n${(pr?.body ?? "").slice(0, 8000)}`);
      }
      const audits: AuditEvent[] = [];
      let review: E2BSandboxResult["review"];
      const outcome = await runStageInSandbox({ job: payload, env: process.env,
        auditSink: (event) => { if (audits.length < 1000) audits.push(event); },
        onReviewFindings: (commit, outcomes, modelVersion) => { review = { commit, outcomes, modelVersion }; },
      });
      for (const event of outcome.audits ?? audits) await runtime.store.appendAudit(payload.runId, event);
      review = outcome.review ?? review;
      if (memory && review) await memory.record(payload.owner, payload.repo, review.commit, review.outcomes, review.modelVersion);
      await runtime.store.updateRun(payload.runId, { status: outcome.result.executed ? "succeeded" : "skipped", executed: outcome.result.executed, stage: outcome.result.stage });
    } catch (err) {
      await runtime.store.updateRun(payload.runId, { status: "failed", errorMessage: "Stage execution failed; inspect private worker logs", executed: false });
      throw err;
    }
  });
  await runtime.boss.work<StageJobPayload>(DEAD_QUEUE, async ([job]) => {
    if (job) await runtime.store.updateRun(job.data.runId, { status: "failed", errorMessage: "Durable job exhausted retries or lost its worker" });
  });
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await runtime.boss.stop({ graceful: true, timeout: 65 * 60 * 1000 });
    await runtime.pool.end();
  };
  process.on("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.on("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
}
main().catch(() => { console.error("Worker startup failed; check database migrations and execution configuration"); process.exitCode = 1; });
