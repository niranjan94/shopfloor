import type { OrchestratorResult } from "../orchestrator.js";
import type { StageJobPayload } from "./jobs.js";
import { runStageJob, stageTimeoutMs } from "./run-stage-job.js";
import type { RuntimeStore } from "./store.js";

export interface E2BSandboxResult {
  mode: "e2b" | "local";
  sandboxId?: string;
  result: OrchestratorResult;
  logs?: string;
  audits?: import("../audit/events.js").AuditEvent[];
  review?: { commit: string; outcomes: import("../stages/review/runner.js").LensOutcome[]; modelVersion: string };
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
  auditSink?: import("../audit/events.js").AuditEmitter;
  onReviewFindings?: import("../stages/_shared/context.js").StageContext["onReviewFindings"];
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

/** E2B execution is required by default; local execution is explicit and development-only. */
export async function runStageInSandbox(
  opts: RunStageInSandboxOpts,
): Promise<E2BSandboxResult> {
  const env = opts.env ?? process.env;
  const key = opts.e2bApiKey ?? env.E2B_API_KEY ?? null;
  const localBridge = opts.forceLocal === true || env.SHOPFLOOR_EXECUTION_MODE === "local";
  if (localBridge && env.NODE_ENV === "production") throw new Error("Local execution is development-only");
  if (!localBridge && !key) throw new Error("E2B_API_KEY is required; enable local execution explicitly for development");
  const executeLocal = opts.executeLocal ?? runStageJob;

  if (localBridge) {
    const result = await executeLocal(opts.job, {
      ...(opts.store ? { store: opts.store } : {}),
      env,
      ...(opts.auditSink ? { auditSink: opts.auditSink } : {}),
      ...(opts.onReviewFindings ? { onReviewFindings: opts.onReviewFindings } : {}),
    });
    return { mode: "local", result };
  }

  const template = env.SHOPFLOOR_E2B_TEMPLATE;
  if (!template && !opts.createSandbox) throw new Error("SHOPFLOOR_E2B_TEMPLATE is required");
  const timeoutMs = stageTimeoutMs(opts.job.stage);
  const sandbox = opts.createSandbox
    ? await opts.createSandbox(key!)
    : await createDefaultE2BSandbox(key!, template!);

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
      const transport = parseWorkerTransport(run.stdout);
      return {
        ...transport,
        mode: "e2b",
        sandboxId: sandbox.sandboxId,
        result: parsed,
        logs: trimLog(run.stdout),
      };
    }

    throw new Error("E2B template is missing the Shopfloor worker bundle");
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
      if (obj.type === "shopfloor_worker_result" && typeof obj.executed === "boolean" && ["none", "triage", "spec", "plan", "implement", "review"].includes(String(obj.stage))) {
        return {
          stage: (obj.stage ?? "none") as OrchestratorResult["stage"],
          executed: Boolean(obj.executed),
        };
      }
    } catch {
      // continue
    }
  }
  throw new Error("E2B worker returned no valid result");
}

function parseWorkerTransport(stdout: string): Pick<E2BSandboxResult, "audits" | "review"> {
  const line = stdout.split("\n").reverse().find((line) => line.startsWith('{"type":"shopfloor_worker_result"'));
  if (!line || line.length > 2_000_000) return {};
  const result = JSON.parse(line) as Pick<E2BSandboxResult, "audits" | "review">;
  return result;
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
