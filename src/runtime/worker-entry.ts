/**
 * Standalone worker entry for E2B / long-running hosts.
 * Reads SHOPFLOOR_JOB_PATH (JSON StageJobPayload) and runs runStageJob.
 * Prints a final JSON line: { type: "shopfloor_worker_result", ... }.
 *
 * Bundled as dist/worker.cjs via esbuild.
 */
import { readFile } from "node:fs/promises";
import type { StageJobPayload } from "./jobs.js";
import { runStageJob } from "./run-stage-job.js";

async function main(): Promise<void> {
  const jobPath = process.env.SHOPFLOOR_JOB_PATH;
  if (!jobPath) {
    throw new Error("SHOPFLOOR_JOB_PATH is required");
  }
  const raw = await readFile(jobPath, "utf8");
  const job = JSON.parse(raw) as StageJobPayload;
  const result = await runStageJob(job, { cloneWorkspace: true });
process.stdout.write(
    `${JSON.stringify({
      type: "shopfloor_worker_result",
      stage: result.stage,
      executed: result.executed,
      runId: job.runId,
    })}\n`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.stdout.write(
    `${JSON.stringify({
      type: "shopfloor_worker_result",
      stage: "none",
      executed: false,
      reason: message,
    })}\n`,
  );
  process.exitCode = 1;
});
