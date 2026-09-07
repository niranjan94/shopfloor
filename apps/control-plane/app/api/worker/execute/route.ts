import type { StageJobPayload } from "../../../../lib/shopfloor.js";
import { handleStageJob } from "../../../../lib/runtime.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.SHOPFLOOR_WORKER_TOKEN;
  if (expected) {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (token !== expected) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  let job: StageJobPayload;
  try {
    job = (await request.json()) as StageJobPayload;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!job?.runId || !job?.owner || !job?.repo || !job?.stage || !job?.event) {
    return Response.json(
      {
        error:
          "body must be a StageJobPayload (runId, owner, repo, stage, event)",
      },
      { status: 400 },
    );
  }

  try {
    await handleStageJob(job);
    return Response.json({
      ok: true,
      jobId: `worker_${job.runId}`,
      runId: job.runId,
      stage: job.stage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, error: message, runId: job.runId },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    endpoint: "worker-execute",
    hint: "POST StageJobPayload to run a stage (clone + executeStage / E2B)",
  });
}
