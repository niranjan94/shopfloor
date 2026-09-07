import type { RouterDecision } from "../state/types.js";
import type { EventEnvelope } from "./event-envelope.js";

export interface StageJobPayload {
  runId: string;
  deliveryId: string;
  owner: string;
  repo: string;
  stage: Exclude<RouterDecision["stage"], "none">;
  event: EventEnvelope;
  decision: RouterDecision;
  /** Workspace working directory for local/inline execute. */
  workspaceCwd?: string;
}

export interface JobQueue {
  enqueueStage(job: StageJobPayload): Promise<{ jobId: string }>;
}

export type StageJobHandler = (job: StageJobPayload) => Promise<void>;

/**
 * In-process queue used for tests and SHOPFLOOR_INLINE_EXECUTE=true.
 * Optionally runs the handler immediately (awaited) or on next microtask.
 */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: StageJobPayload[] = [];
  private handler: StageJobHandler | null;

  constructor(opts?: { handler?: StageJobHandler; immediate?: boolean }) {
    this.handler = opts?.handler ?? null;
    this.immediate = opts?.immediate ?? true;
  }

  private immediate: boolean;

  setHandler(handler: StageJobHandler): void {
    this.handler = handler;
  }

  async enqueueStage(job: StageJobPayload): Promise<{ jobId: string }> {
    this.jobs.push(job);
    const jobId = `mem_${job.runId}`;
    if (this.handler) {
      if (this.immediate) {
        await this.handler(job);
      } else {
        queueMicrotask(() => {
          void this.handler?.(job);
        });
      }
    }
    return { jobId };
  }
}

/**
 * Fire-and-forget HTTP enqueue toward a worker URL.
 * Placeholder until Inngest/Trigger.dev is wired; useful for custom workers.
 */
export class HttpJobQueue implements JobQueue {
  constructor(
    private readonly endpoint: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async enqueueStage(job: StageJobPayload): Promise<{ jobId: string }> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(job),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HttpJobQueue enqueue failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const body = (await res.json().catch(() => ({}))) as { jobId?: string };
    return { jobId: body.jobId ?? `http_${job.runId}` };
  }
}

/**
 * Records jobs without executing them. Control plane default when no worker
 * backend is configured — operators can inspect /api/runs and attach a queue later.
 */
export class LoggingJobQueue implements JobQueue {
  readonly jobs: StageJobPayload[] = [];

  async enqueueStage(job: StageJobPayload): Promise<{ jobId: string }> {
    this.jobs.push(job);
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        type: "stage_job_enqueued",
        runId: job.runId,
        stage: job.stage,
        owner: job.owner,
        repo: job.repo,
        deliveryId: job.deliveryId,
      }),
    );
    return { jobId: `log_${job.runId}` };
  }
}
