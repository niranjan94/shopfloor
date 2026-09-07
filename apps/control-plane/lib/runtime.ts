import {
  createPostgresRuntimeStoreFromUrl,
  getDefaultMemoryStore,
  HttpJobQueue,
  InngestJobQueue,
  type JobQueue,
  LoggingJobQueue,
  MemoryJobQueue,
  type RuntimeStore,
  runStageInSandbox,
  type StageJobPayload,
} from "../../../src/runtime/index";
import { inngest } from "./inngest";

let storePromise: Promise<RuntimeStore> | null = null;
let queue: JobQueue | null = null;
let queueBackend: QueueBackend = "unset";

export type QueueBackend =
  | "unset"
  | "inngest"
  | "http"
  | "inline"
  | "logging";

/**
 * Durable store when DATABASE_URL is set (Neon); otherwise process-local memory.
 * Prefer getStoreAsync() in route handlers so Postgres is ready on cold start.
 */
export function getStore(): RuntimeStore {
  void getStoreAsync();
  return getStoreSyncFallback();
}

function getStoreSyncFallback(): RuntimeStore {
  const resolved = (globalThis as { __shopfloorStore?: RuntimeStore })
    .__shopfloorStore;
  if (resolved) return resolved;
  return getDefaultMemoryStore();
}

export async function getStoreAsync(): Promise<RuntimeStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) {
        const mem = getDefaultMemoryStore();
        (globalThis as { __shopfloorStore?: RuntimeStore }).__shopfloorStore =
          mem;
        return mem;
      }
      try {
        const pg = await createPostgresRuntimeStoreFromUrl(url);
        (globalThis as { __shopfloorStore?: RuntimeStore }).__shopfloorStore =
          pg;
        return pg;
      } catch (err) {
        console.error(
          JSON.stringify({
            type: "postgres_store_init_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        const mem = getDefaultMemoryStore();
        (globalThis as { __shopfloorStore?: RuntimeStore }).__shopfloorStore =
          mem;
        return mem;
      }
    })();
  }
  return storePromise;
}

/**
 * Shared stage handler used by Inngest functions and /api/worker/execute.
 * Prefers E2B when configured; otherwise clones + executeStage locally.
 */
export async function handleStageJob(job: StageJobPayload): Promise<void> {
  const store = await getStoreAsync();
  const result = await runStageInSandbox({
    job,
    store,
    env: process.env,
  });
  console.info(
    JSON.stringify({
      type: "stage_job_finished",
      runId: job.runId,
      stage: job.stage,
      mode: result.mode,
      sandboxId: result.sandboxId,
      executed: result.result.executed,
      resultStage: result.result.stage,
    }),
  );
}

/**
 * Job queue selection (highest priority first):
 * 1. INNGEST_EVENT_KEY → Inngest durable events
 * 2. SHOPFLOOR_WORKER_URL → HTTP enqueue to external worker
 * 3. SHOPFLOOR_INLINE_EXECUTE=true → in-process (dev)
 * 4. default → logging only
 */
export function getQueue(): JobQueue {
  if (queue) return queue;

  if (process.env.INNGEST_EVENT_KEY) {
    queue = new InngestJobQueue(inngest);
    queueBackend = "inngest";
    return queue;
  }

  const workerUrl = process.env.SHOPFLOOR_WORKER_URL;
  if (workerUrl) {
    queue = new HttpJobQueue(workerUrl, {
      ...(process.env.SHOPFLOOR_WORKER_TOKEN
        ? { authorization: `Bearer ${process.env.SHOPFLOOR_WORKER_TOKEN}` }
        : {}),
    });
    queueBackend = "http";
    return queue;
  }

  if ((process.env.SHOPFLOOR_INLINE_EXECUTE ?? "").toLowerCase() === "true") {
    const mem = new MemoryJobQueue({
      immediate: false,
      handler: async (job: StageJobPayload) => {
        await handleStageJob(job);
      },
    });
    queue = mem;
    queueBackend = "inline";
    return queue;
  }

  queue = new LoggingJobQueue();
  queueBackend = "logging";
  return queue;
}

export function getQueueBackend(): QueueBackend {
  if (queueBackend === "unset") getQueue();
  return queueBackend;
}

/** Test helper to reset singletons between cases. */
export function __resetRuntime(): void {
  queue = null;
  queueBackend = "unset";
  storePromise = null;
  delete (globalThis as { __shopfloorStore?: RuntimeStore }).__shopfloorStore;
}

/** @deprecated use __resetRuntime */
export function __resetQueue(): void {
  __resetRuntime();
}
