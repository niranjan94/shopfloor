import type { JobQueue, StageJobPayload } from "./jobs.js";

export const SHOPFLOOR_EXECUTE_STAGE_EVENT = "shopfloor/execute-stage" as const;

export interface InngestEventSender {
  send: (
    payload:
      | { name: string; data: StageJobPayload; id?: string }
      | Array<{ name: string; data: StageJobPayload; id?: string }>,
  ) => Promise<unknown>;
}

/**
 * Enqueue stage jobs as Inngest events.
 * The serve handler (`createExecuteStageFunction`) performs the work.
 */
export class InngestJobQueue implements JobQueue {
  constructor(private readonly client: InngestEventSender) {}

  async enqueueStage(job: StageJobPayload): Promise<{ jobId: string }> {
    const id = `shopfloor-stage-${job.runId}`;
    await this.client.send({
      id,
      name: SHOPFLOOR_EXECUTE_STAGE_EVENT,
      data: job,
    });
    return { jobId: id };
  }
}

export type InngestFunctionLike = unknown;

export interface CreateExecuteStageFunctionDeps {
  /** inngest.Inngest instance */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inngest: any;
  /** Called to perform the stage (local workspace, E2B, or HTTP worker). */
  handler: (job: StageJobPayload) => Promise<void>;
}

/**
 * Build the durable `shopfloor/execute-stage` Inngest function.
 * Kept untyped against `inngest` package internals so the core library
 * does not hard-require inngest at compile time for Action builds.
 */
export function createExecuteStageFunction(
  deps: CreateExecuteStageFunctionDeps,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const { inngest, handler } = deps;
  return inngest.createFunction(
    {
      id: "shopfloor-execute-stage",
      name: "Shopfloor execute stage",
      retries: 2,
      concurrency: [
        {
          // One active stage per issue (or repo when issue missing).
          key: "event.data.owner + '/' + event.data.repo + '/' + string(event.data.decision.issueNumber ?? event.data.runId)",
          limit: 1,
        },
      ],
    },
    { event: SHOPFLOOR_EXECUTE_STAGE_EVENT },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ event, step }: any) => {
      const job = event.data as StageJobPayload;
      await step.run(`execute-${job.stage}`, async () => {
        await handler(job);
        return {
          runId: job.runId,
          stage: job.stage,
          owner: job.owner,
          repo: job.repo,
        };
      });
    },
  );
}
