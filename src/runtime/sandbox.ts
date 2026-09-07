import type { OrchestratorResult } from "../orchestrator.js";
import type { StageJobPayload } from "./jobs.js";
import { runStageJob, stageTimeoutMs } from "./run-stage-job.js";
import type { RuntimeStore } from "./store.js";

export interface E2BSandboxResult {
  mode: "e2b" | "local_fallback";
  sandboxId?: string;
  result: OrchestratorResult;
  logs?: string;
}

export interface RunStageInSandboxOpts {
  job: StageJobPayload;
  store?: RuntimeStore;
  env?: NodeJS.ProcessEnv;
  e2bApiKey?: string | null;
  /**
   * When E2B is configured, still allow forcing local execute (tests / dev).
   * Default: use E2B when key present.
   */
  forceLocal?: boolean;
  /** Inject E2B client factory (tests). */
  createSandbox?: (apiKey: string) => Promise<E2BSandboxHandle>;
  executeLocal?: typeof runStageJob;
}

/** Subset of the E2B Sandbox surface we use. */
export interface E2BSandboxHandle {
  sandboxId: string;
  commands: {
    run: (
      cmd: string,
      opts?: { timeoutMs?: number; envs?: Record<string, string> },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  files: {
    write: (path: string, content: string | Uint8Array) => Promise<void>;
  };
  kill: () => Promise<void>;
}

/**
 * Run a stage job in an E2B sandbox when E2B_API_KEY is set.
 *
 * Strategy:
 * 1. Create a Node-capable sandbox
 * 2. Write job payload + a small runner that POSTs back is not required —
 *    the control plane awaits the sandbox command
 * 3. Install/run uses local fallback when the full Shopfloor bundle is not
 *    provisioned inside the sandbox template
 *
 * For production implement (60m), prefer a custom E2B template that already
 * contains the Shopfloor worker bundle (`dist/worker.cjs`). When the template
 * env `SHOPFLOOR_E2B_TEMPLATE` is unset, we fall back to **local**
 * `runStageJob` so routing still works in dev; operators should set the
 * template + worker image for isolated production execute.
 *
 * If `SHOPFLOOR_E2B_LOCAL_BRIDGE=true`, run local execute even with an API key
 * (useful when dogfooding Inngest on a long-running worker host).
 */
export async function runStageInSandbox(
  opts: RunStageInSandboxOpts,
): Promise<E2BSandboxResult> {
  const env = opts.env ?? process.env;
  const key = opts.e2bApiKey ?? env.E2B_API_KEY ?? null;
  const localBridge =
    opts.forceLocal === true ||
    (env.SHOPFLOOR_E2B_LOCAL_BRIDGE ?? "").toLowerCase() === "true";
  const executeLocal = opts.executeLocal ?? runStageJob;

  if (!key || localBridge) {
    const result = await executeLocal(opts.job, {
      ...(opts.store ? { store: opts.store } : {}),
      env,
    });
    return { mode: "local_fallback", result };
  }

  const template = env.SHOPFLOOR_E2B_TEMPLATE ?? "base";
  const timeoutMs = stageTimeoutMs(opts.job.stage);
  const sandbox = opts.createSandbox
    ? await opts.createSandbox(key)
    : await createDefaultE2BSandbox(key, template);

  try {
    // Prefer an in-sandbox worker entry when the template ships Shopfloor.
    const workerPath = env.SHOPFLOOR_E2B_WORKER_PATH ?? "/home/user/shopfloor-worker.cjs";
    const jobPath = "/tmp/shopfloor-job.json";
    await sandbox.files.write(jobPath, JSON.stringify(opts.job));

    // Pass through credentials as env for the worker process inside the sandbox.
    const envs = pickWorkerEnv(env);
    envs.SHOPFLOOR_JOB_PATH = jobPath;

    const probe = await sandbox.commands.run(
      `test -f ${shellQuote(workerPath)} && echo HAS_WORKER || echo NO_WORKER`,
      { timeoutMs: 30_000 },
    );

    if (probe.stdout.includes("HAS_WORKER")) {
      const run = await sandbox.commands.run(
        `node ${shellQuote(workerPath)}`,
        { timeoutMs, envs },
      );
      if (run.exitCode !== 0) {
        throw new Error(
          `E2B worker failed (exit ${run.exitCode}): ${trimLog(run.stderr || run.stdout)}`,
        );
      }
      const parsed = parseWorkerResult(run.stdout);
      return {
        mode: "e2b",
        sandboxId: sandbox.sandboxId,
        result: parsed,
        logs: trimLog(run.stdout),
      };
    }

    // No worker bundle in template — fall back to local execute so the job
    // still completes. Log clearly for operators.
    console.warn(
      JSON.stringify({
        type: "e2b_worker_missing",
        sandboxId: sandbox.sandboxId,
        workerPath,
        hint: "Set SHOPFLOOR_E2B_TEMPLATE to a template that includes dist/worker.cjs, or SHOPFLOOR_E2B_LOCAL_BRIDGE=true",
      }),
    );
    const result = await executeLocal(opts.job, {
      ...(opts.store ? { store: opts.store } : {}),
      env,
    });
    return {
      mode: "local_fallback",
      sandboxId: sandbox.sandboxId,
      result,
    };
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

function pickWorkerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_AUTH_JSON",
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_REVIEW_CLIENT_ID",
    "GITHUB_APP_REVIEW_PRIVATE_KEY",
    "SHOPFLOOR_GITHUB_APP_TOKEN",
    "SHOPFLOOR_GITHUB_APP_REVIEW_TOKEN",
    "SHOPFLOOR_AGENT_PROVIDER",
    "SHOPFLOOR_TRIGGER_LABEL",
    "SHOPFLOOR_MAX_REVIEW_ITERATIONS",
    "SSH_SIGNING_KEY",
    "DATABASE_URL",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function trimLog(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function parseWorkerResult(stdout: string): OrchestratorResult {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as Partial<OrchestratorResult> & {
        type?: string;
      };
if (obj.type === "shopfloor_worker_result" || obj.stage !== undefined) {
        return {
          stage: (obj.stage ?? "none") as OrchestratorResult["stage"],
          executed: Boolean(obj.executed),
        };
      }
    } catch {
      // continue
    }
  }
// Worker finished without a parseable result line — treat as executed unknown success.
  return { stage: "none", executed: true };
}

async function createDefaultE2BSandbox(
  apiKey: string,
  template: string,
): Promise<E2BSandboxHandle> {
  const e2b = await import("e2b");
  const Sandbox = e2b.Sandbox as {
    create: (opts: {
      apiKey: string;
      template?: string;
      timeoutMs?: number;
    }) => Promise<E2BSandboxHandle>;
  };
  return Sandbox.create({
    apiKey,
    template,
    // Sandbox lifetime ceiling; per-command timeout is separate.
    timeoutMs: 70 * 60 * 1000,
  });
}
