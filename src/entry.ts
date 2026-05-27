import { readFileSync } from "node:fs";
import * as core from "@actions/core";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { ClaudeAgentAdapter } from "./agents/claude.js";
import {
  type AuditEmitter,
  combineEmitters,
  createAuditEmitter,
} from "./audit/events.js";
import { createStepSummaryMirror } from "./audit/step-summary.js";
import { buildAgentEnvFromConfig } from "./config/agent-env.js";
import { parseConfig } from "./config/inputs.js";
import { applyGitIdentity, resolveBotIdentity } from "./git/identity.js";
import {
  prepareImplCheckout,
  pushImplCommits,
  tokenResolverFor,
} from "./git/impl-checkout.js";
import { GitHubAdapter, type OctokitLike } from "./github/adapter.js";
import { type AuthSpec, resolveAuth } from "./github/app-token.js";
import { runOrchestrator } from "./orchestrator.js";
import type { GitOps } from "./stages/_shared/context.js";
import type { EventPayload } from "./state/types.js";

export interface RunEntryDeps {
  // Inject an Octokit factory in tests so we don't hit the network.
  octokitFactory?: (auth: AuthSpec) => OctokitLike;
  // Inject the agent adapter in tests; defaults to ClaudeAgentAdapter.
  agentFactory?: () => InstanceType<typeof ClaudeAgentAdapter>;
  // Override audit sink for tests.
  auditSink?: AuditEmitter;
}

const INPUT_KEYS = [
  "anthropic_api_key",
  "claude_code_oauth_token",
  "github_app_client_id",
  "github_app_private_key",
  "github_app_review_client_id",
  "github_app_review_private_key",
  "github_app_token",
  "github_app_review_token",
  "github_token",
  "ssh_signing_key",
  "trigger_label",
  "max_review_iterations",
  "triage_model",
  "spec_model",
  "plan_model",
  "impl_model",
  "review_compliance_model",
  "review_bugs_model",
  "review_security_model",
  "review_smells_model",
  "triage_effort",
  "spec_effort",
  "plan_effort",
  "impl_effort",
  "review_compliance_effort",
  "review_bugs_effort",
  "review_security_effort",
  "review_smells_effort",
  "triage_max_budget_usd",
  "spec_max_budget_usd",
  "plan_max_budget_usd",
  "impl_max_budget_usd",
  "review_max_budget_usd_per_lens",
  "triage_max_turns",
  "spec_max_turns",
  "plan_max_turns",
  "impl_max_turns",
  "review_max_turns_per_lens",
  "triage_timeout_ms",
  "spec_timeout_ms",
  "plan_timeout_ms",
  "impl_timeout_ms",
  "review_timeout_ms_per_lens",
  "review_only",
  "mode",
  "stages",
] as const;

export async function runEntry(deps: RunEntryDeps = {}): Promise<void> {
  try {
    const rawInputs = readActionInputs();
    const config = parseConfig(rawInputs);

    const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
    if (!owner || !repo) {
      throw new Error("GITHUB_REPOSITORY is not set");
    }

    const eventName = process.env.GITHUB_EVENT_NAME ?? "";
    const eventPath = process.env.GITHUB_EVENT_PATH ?? "";
    if (!eventPath) throw new Error("GITHUB_EVENT_PATH is not set");
    const eventPayload = JSON.parse(readFileSync(eventPath, "utf8")) as
      | EventPayload
      | Record<string, never>;
    const event = { name: eventName, payload: eventPayload as EventPayload };

    // GitHub Actions does not inject GITHUB_TOKEN into Node action steps
    // automatically; the caller passes it explicitly via the github_token
    // input (typically `${{ github.token }}`). Fall back to the env var for
    // callers who set it on the step explicitly.
    const githubToken =
      rawInputs.github_token || process.env.GITHUB_TOKEN || null;

    const primaryAuth = await resolveAuth({
      preminted: rawInputs.github_app_token ?? null,
      app: config.githubApp,
      fallbackToken: githubToken,
      owner,
      repo,
    });
    if (!primaryAuth) {
      throw new Error(
        "No GitHub credentials available. Provide one of: github_app_token (preminted installation token), github_app_client_id+github_app_private_key (App credentials for in-process minting), or ensure GITHUB_TOKEN is set on the job.",
      );
    }

    const reviewAuth = await resolveAuth({
      preminted: rawInputs.github_app_review_token ?? null,
      app: config.reviewGithubApp,
      fallbackToken: githubToken,
      owner,
      repo,
    });

    if (primaryAuth.kind === "token" && primaryAuth.source === "github_token") {
      core.warning(
        "Shopfloor is running with the workflow's default GITHUB_TOKEN. Mutations made with this token will not trigger downstream workflows (label flips, PR pushes, and review submissions will fail to advance the pipeline). Install a Shopfloor GitHub App and provide github_app_client_id + github_app_private_key for full functionality.",
      );
    }

    // Configure the repo-local git identity so the Claude implement agent
    // can `git commit` without flailing. Without this, every implement run
    // dies on `Committer identity unknown`. Done before the orchestrator
    // dispatches so all stage agents inherit a fully configured identity.
    const identity = await resolveBotIdentity(primaryAuth);
    await applyGitIdentity({
      cwd: process.cwd(),
      identity,
      sshSigningKey: config.sshSigningKey,
    });
    if (
      reviewAuth &&
      reviewAuth.kind === "token" &&
      reviewAuth.source === "github_token"
    ) {
      core.warning(
        "Shopfloor's review path is running with the workflow's default GITHUB_TOKEN. Reviews submitted with this token cannot APPROVE or REQUEST_CHANGES on a PR authored by github-actions[bot], and any resulting events will not trigger downstream workflows. Provide a distinct review App via github_app_review_client_id + github_app_review_private_key.",
      );
    }

    const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
    const audit =
      deps.auditSink ??
      combineEmitters(createAuditEmitter({ runId }), createStepSummaryMirror());

    const octokitFactory = deps.octokitFactory ?? defaultOctokitFactory;
    const github = new GitHubAdapter(
      octokitFactory(primaryAuth),
      { owner, repo },
      audit,
    );
    const reviewGithub = reviewAuth
      ? new GitHubAdapter(octokitFactory(reviewAuth), { owner, repo }, audit)
      : null;

    const agent = deps.agentFactory
      ? deps.agentFactory()
      : new ClaudeAgentAdapter(buildAgentEnvFromConfig(config));

    const reviewOnly = rawInputs.review_only === "true";

    // Bind the resolved AuthSpec into a token resolver and the impl-stage git
    // helpers. The implement runner calls these to set the local branch up
    // before the agent runs and to push the agent's commits afterwards. We
    // build the closure once at startup so each helper invocation can ask
    // for a fresh installation token (relevant when the agent run outlives
    // the installation-token TTL).
    const resolveGitToken = tokenResolverFor(primaryAuth, owner, repo);
    const gitOps: GitOps = {
      async prepareImplCheckout(opts) {
        const token = await resolveGitToken();
        await prepareImplCheckout({
          cwd: process.cwd(),
          owner,
          repo,
          token,
          ...opts,
        });
      },
      async pushImplCommits(opts) {
        const token = await resolveGitToken();
        await pushImplCommits({
          cwd: process.cwd(),
          owner,
          repo,
          token,
          ...opts,
        });
      },
    };

    const result = await runOrchestrator({
      event,
      repo: { owner, name: repo },
      github,
      reviewGithub,
      agent,
      audit,
      config,
      runId,
      gitOps,
      ...(reviewOnly ? { reviewOnly: true } : {}),
    });
    core.setOutput("stage", result.stage);
    core.setOutput("executed", result.executed ? "true" : "false");
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) core.error(err.stack);
  }
}

function defaultOctokitFactory(auth: AuthSpec): OctokitLike {
  if (auth.kind === "token") {
    return new Octokit({ auth: auth.token }) as unknown as OctokitLike;
  }
  // Octokit's auth-app strategy caches the installation token in-process and
  // refreshes it transparently before expiry on every request. That keeps the
  // pipeline alive past the 60-minute installation-token TTL even when an
  // implement run spans hours.
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.clientId,
      privateKey: auth.privateKey,
      installationId: auth.installationId,
    },
  }) as unknown as OctokitLike;
}

function readActionInputs(): Record<string, string> {
  // Skip keys whose Action input is empty so Zod's `.default()` can fire.
  // parseConfig's `cleaned` map preserves whatever keys are present, so
  // emitting `""` would suppress defaults for every optional input.
  const out: Record<string, string> = {};
  for (const k of INPUT_KEYS) {
    const v = core.getInput(k);
    if (v) out[k] = v;
  }
  return out;
}

// CLI entry — auto-invoked when this module is the bundle's entry point.
// Tests set SHOPFLOOR_INVOKE_ENTRY=0 to import without firing.
if (process.env.SHOPFLOOR_INVOKE_ENTRY !== "0") {
  runEntry().catch((err) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
