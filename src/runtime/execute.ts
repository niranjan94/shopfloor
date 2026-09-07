import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { AgentAdapter } from "../agents/adapter.js";
import { ClaudeAgentAdapter } from "../agents/claude.js";
import { CodexAgentAdapter } from "../agents/codex.js";
import {
  type AuditEmitter,
  combineEmitters,
  createAuditEmitter,
} from "../audit/events.js";
import { buildAgentEnvFromConfig } from "../config/agent-env.js";
import { buildCodexOptions } from "../config/codex-options.js";
import type { Config } from "../config/inputs.js";
import { applyGitIdentity, resolveBotIdentity } from "../git/identity.js";
import {
  prepareImplCheckout,
  prepareReviewBase,
  pushImplCommits,
  tokenResolverFor,
} from "../git/impl-checkout.js";
import { GitHubAdapter, type OctokitLike } from "../github/adapter.js";
import { type AuthSpec, resolveAuth } from "../github/app-token.js";
import { type OrchestratorResult, runOrchestrator } from "../orchestrator.js";
import type { GitOps } from "../stages/_shared/context.js";
import type { EventPayload } from "../state/types.js";
import type { EventEnvelope } from "./event-envelope.js";
import type { RuntimeStore } from "./store.js";

export interface ExecuteStageArgs {
  envelope: EventEnvelope;
  owner: string;
  repo: string;
  config: Config;
  runId: string;
  /** Absolute path to the git workspace (clone). Defaults to process.cwd(). */
  workspaceCwd?: string;
  store?: RuntimeStore;
  reviewOnly?: boolean;
  /** Inject in tests. */
  octokitFactory?: (auth: AuthSpec) => OctokitLike;
  agentFactory?: () => AgentAdapter;
  auditSink?: AuditEmitter;
  /** Optional static tokens (preminted). */
  premintedToken?: string | null;
  premintedReviewToken?: string | null;
  githubTokenFallback?: string | null;
}

/**
 * Run the Shopfloor orchestrator outside GitHub Actions.
 * Intended for durable workers / sandboxes / local inline execute.
 */
export async function executeStage(
  args: ExecuteStageArgs,
): Promise<OrchestratorResult> {
  const cwd = args.workspaceCwd ?? process.cwd();
  const config: Config = {
    ...args.config,
    // Workers always execute; routing already happened on the control plane.
    mode: args.config.mode === "resolve" ? "auto" : args.config.mode,
  };

  if (args.store) {
    await args.store.updateRun(args.runId, { status: "running" });
  }

  const primaryAuth = await resolveAuth({
    preminted: args.premintedToken ?? null,
    app: config.githubApp,
    fallbackToken: args.githubTokenFallback ?? null,
    owner: args.owner,
    repo: args.repo,
  });
  if (!primaryAuth) {
    const message =
      "No GitHub credentials available for execute. Provide App credentials or a preminted token.";
    if (args.store) {
      await args.store.updateRun(args.runId, {
        status: "failed",
        errorMessage: message,
        executed: false,
      });
    }
    throw new Error(message);
  }

  const reviewAuth = await resolveAuth({
    preminted: args.premintedReviewToken ?? null,
    app: config.reviewGithubApp,
    fallbackToken: args.githubTokenFallback ?? null,
    owner: args.owner,
    repo: args.repo,
  });

  const identity = await resolveBotIdentity(primaryAuth);
  await applyGitIdentity({
    cwd,
    identity,
    sshSigningKey: config.sshSigningKey,
  });

  const baseAudit =
    args.auditSink ??
    createAuditEmitter({
      runId: args.runId,
      sink: (line) => process.stdout.write(`${line}\n`),
    });
  const audit: AuditEmitter = args.store
    ? combineEmitters(baseAudit, (event) => {
        void args.store?.appendAudit(args.runId, event);
      })
    : baseAudit;

  const octokitFactory = args.octokitFactory ?? defaultOctokitFactory;
  const github = new GitHubAdapter(
    octokitFactory(primaryAuth),
    { owner: args.owner, repo: args.repo },
    audit,
  );
  const reviewGithub = reviewAuth
    ? new GitHubAdapter(
        octokitFactory(reviewAuth),
        { owner: args.owner, repo: args.repo },
        audit,
      )
    : null;

  const agent = args.agentFactory
    ? args.agentFactory()
    : config.agentProvider === "codex"
      ? new CodexAgentAdapter(buildCodexOptions(config))
      : new ClaudeAgentAdapter(buildAgentEnvFromConfig(config));

  const resolveGitToken = tokenResolverFor(primaryAuth, args.owner, args.repo);
  const gitOps: GitOps = {
    async prepareImplCheckout(opts) {
      const token = await resolveGitToken();
      await prepareImplCheckout({
        cwd,
        owner: args.owner,
        repo: args.repo,
        token,
        ...opts,
      });
    },
    async pushImplCommits(opts) {
      const token = await resolveGitToken();
      await pushImplCommits({
        cwd,
        owner: args.owner,
        repo: args.repo,
        token,
        ...opts,
      });
    },
    async prepareReviewBase(opts) {
      const token = await resolveGitToken();
      await prepareReviewBase({
        cwd,
        owner: args.owner,
        repo: args.repo,
        token,
        ...opts,
      });
    },
  };

  try {
    const result = await runOrchestrator({
      event: {
        name: args.envelope.name,
        payload: args.envelope.payload as EventPayload,
      },
      repo: { owner: args.owner, name: args.repo },
      github,
      reviewGithub,
      agent,
      audit,
      config,
      runId: args.runId,
      gitOps,
      ...(args.reviewOnly ? { reviewOnly: true } : {}),
    });

    if (args.store) {
      await args.store.updateRun(args.runId, {
        status: result.executed ? "succeeded" : "skipped",
        executed: result.executed,
        stage: result.stage,
      });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (args.store) {
      await args.store.updateRun(args.runId, {
        status: "failed",
        errorMessage: message,
        executed: false,
      });
    }
    throw err;
  }
}

function defaultOctokitFactory(auth: AuthSpec): OctokitLike {
  if (auth.kind === "token") {
    return new Octokit({ auth: auth.token }) as unknown as OctokitLike;
  }
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.clientId,
      privateKey: auth.privateKey,
      installationId: auth.installationId,
    },
  }) as unknown as OctokitLike;
}
