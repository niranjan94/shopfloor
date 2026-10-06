import {
  mintInstallationToken,
  resolveAuth,
} from "../github/app-token.js";
import type { OrchestratorResult } from "../orchestrator.js";
import { parseConfigFromEnv } from "./env-config.js";
import { executeStage } from "./execute.js";
import type { StageJobPayload } from "./jobs.js";
import type { RuntimeStore } from "./store.js";
import { withGitWorkspace } from "./workspace.js";

export interface RunStageJobOptions {
  store?: RuntimeStore;
  auditSink?: import("../audit/events.js").AuditEmitter;
  onReviewFindings?: import("../stages/_shared/context.js").StageContext["onReviewFindings"];
  /** Override process.env for config + credentials. */
  env?: NodeJS.ProcessEnv;
  /**
   * When true (default), clone a fresh workspace before execute.
   * Set false when the caller already prepared workspaceCwd on the job.
   */
  cloneWorkspace?: boolean;
  /** Optional fixed workspace parent (tests). */
  workspaceParentDir?: string;
  /** Inject clone token (tests). */
  cloneToken?: string;
  /** Skip real execute (tests). */
  executeFn?: typeof executeStage;
}

/**
 * Worker entry for one enqueued stage job:
 * resolve config → (optional) clone repo → executeStage → cleanup.
 */
export async function runStageJob(
  job: StageJobPayload,
  opts: RunStageJobOptions = {},
): Promise<OrchestratorResult> {
  const env = opts.env ?? process.env;
  const config = parseConfigFromEnv(env, { mode: "auto" });
  const execute = opts.executeFn ?? executeStage;

  if (job.workspaceCwd || opts.cloneWorkspace === false) {
    return execute({
      envelope: job.event,
      owner: job.owner,
      repo: job.repo,
      config,
      runId: job.runId,
      reviewOnly: job.reviewOnly === true,
      ...(job.historicalFindings ? { historicalFindings: job.historicalFindings } : {}),
      ...(opts.auditSink ? { auditSink: opts.auditSink } : {}),
      ...(opts.onReviewFindings ? { onReviewFindings: opts.onReviewFindings } : {}),
      ...(opts.store ? { store: opts.store } : {}),
      ...(job.workspaceCwd ? { workspaceCwd: job.workspaceCwd } : {}),
    });
  }

  const token =
    opts.cloneToken ?? (await resolveCloneToken(job.owner, job.repo, env));

  return withGitWorkspace(
    {
      owner: job.owner,
      repo: job.repo,
      token,
      ...(opts.workspaceParentDir
        ? { parentDir: opts.workspaceParentDir }
        : {}),
      // Review the PR head rather than the repository default branch.
      ...(job.stage === "review" ? { ref: `pull/${(job.event.payload as unknown as { pull_request: { number: number } }).pull_request.number}/head` } : {}),
      depth: job.stage === "implement" ? 50 : 1,
    },
    async (cwd) =>
      execute({
        envelope: job.event,
        owner: job.owner,
        repo: job.repo,
        config,
        runId: job.runId,
        reviewOnly: job.reviewOnly === true,
        ...(job.historicalFindings ? { historicalFindings: job.historicalFindings } : {}),
        ...(opts.auditSink ? { auditSink: opts.auditSink } : {}),
        ...(opts.onReviewFindings ? { onReviewFindings: opts.onReviewFindings } : {}),
        workspaceCwd: cwd,
        ...(opts.store ? { store: opts.store } : {}),
      }),
  );
}

async function resolveCloneToken(
  owner: string,
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const preminted = env.SHOPFLOOR_GITHUB_APP_TOKEN ?? null;
  const clientId = env.GITHUB_APP_CLIENT_ID ?? "";
  const privateKey = (env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const auth = await resolveAuth({
    preminted,
    app: clientId && privateKey ? { clientId, privateKey } : null,
    fallbackToken: env.GITHUB_TOKEN ?? null,
    owner,
    repo,
  });
  if (!auth) {
    throw new Error(
      "Cannot clone workspace: set GITHUB_APP_CLIENT_ID + GITHUB_APP_PRIVATE_KEY or SHOPFLOOR_GITHUB_APP_TOKEN",
    );
  }
  if (auth.kind === "token") return auth.token;
  return mintInstallationToken({
    clientId: auth.clientId,
    privateKey: auth.privateKey,
    owner,
    repo,
    installationId: auth.installationId,
  });
}

/** Per-stage wall-clock budget hints (ms) for job systems / sandboxes. */
export function stageTimeoutMs(stage: StageJobPayload["stage"]): number {
  switch (stage) {
    case "triage":
      return 5 * 60 * 1000;
    case "spec":
    case "plan":
      return 20 * 60 * 1000;
    case "review":
      return 25 * 60 * 1000;
    case "implement":
      return 60 * 60 * 1000;
    default:
      return 20 * 60 * 1000;
  }
}
