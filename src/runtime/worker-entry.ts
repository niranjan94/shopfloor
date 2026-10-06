import { readFile } from "node:fs/promises";
import type { AuditEvent } from "../audit/events.js";
import type { StageJobPayload } from "./jobs.js";
import { runStageJob } from "./run-stage-job.js";
import type { E2BSandboxResult } from "./sandbox.js";

async function main(): Promise<void> {
  const jobPath = process.env.SHOPFLOOR_JOB_PATH;
  if (!jobPath) throw new Error("SHOPFLOOR_JOB_PATH is required");
  const job = JSON.parse(await readFile(jobPath, "utf8")) as StageJobPayload;
  const audits: AuditEvent[] = [];
  let review: E2BSandboxResult["review"];
  try {
    const result = await runStageJob(job, {
      cloneWorkspace: true,
      auditSink: (event) => { if (audits.length < 1000) audits.push(event); },
      onReviewFindings: (commit, outcomes, modelVersion) => { review = { commit, outcomes, modelVersion }; },
    });
    process.stdout.write(`${JSON.stringify({ type: "shopfloor_worker_result", ...result, runId: job.runId, audits, review })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ type: "shopfloor_worker_result", stage: "none", executed: false, runId: job.runId, audits })}\n`);
    process.exitCode = 1;
  }
}
main().catch(() => { console.error("Sandbox worker failed"); process.exitCode = 1; });
