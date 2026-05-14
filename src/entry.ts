import * as core from "@actions/core";
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { parseConfig } from "./config/inputs.js";
import { resolveAppToken } from "./github/app-token.js";
import { GitHubAdapter, type OctokitLike } from "./github/adapter.js";
import { ClaudeAgentAdapter } from "./agents/claude.js";
import {
  createAuditEmitter,
  combineEmitters,
  type AuditEmitter,
} from "./audit/events.js";
import { createStepSummaryMirror } from "./audit/step-summary.js";
import { runOrchestrator } from "./orchestrator.js";
import type { EventPayload } from "./state/types.js";

export interface RunEntryDeps {
  // Inject an Octokit factory in tests so we don't hit the network.
  octokitFactory?: (token: string) => OctokitLike;
  // Inject the agent adapter in tests; defaults to ClaudeAgentAdapter.
  agentFactory?: () => InstanceType<typeof ClaudeAgentAdapter>;
  // Override audit sink for tests.
  auditSink?: AuditEmitter;
}

const INPUT_KEYS = [
  "anthropic_api_key",
  "claude_code_oauth_token",
  "shopfloor_github_app_client_id",
  "shopfloor_github_app_private_key",
  "shopfloor_github_app_review_client_id",
  "shopfloor_github_app_review_private_key",
  "github_app_token",
  "github_app_review_token",
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
  "triage_max_budget_usd",
  "spec_max_budget_usd",
  "plan_max_budget_usd",
  "impl_max_budget_usd",
  "review_max_budget_usd_per_lens",
  "triage_timeout_ms",
  "spec_timeout_ms",
  "plan_timeout_ms",
  "impl_timeout_ms",
  "review_timeout_ms_per_lens",
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

    const primaryToken = await resolveAppToken(
      rawInputs.github_app_token
        ? { mode: "preminted", token: rawInputs.github_app_token }
        : {
            mode: "mint",
            clientId: config.githubApp.clientId,
            privateKey: config.githubApp.privateKey,
            owner,
            repo,
          },
    );

    const hasReviewApp =
      Boolean(rawInputs.github_app_review_token) ||
      config.reviewGithubApp !== null;
    const reviewToken = hasReviewApp
      ? await resolveAppToken(
          rawInputs.github_app_review_token
            ? {
                mode: "preminted",
                token: rawInputs.github_app_review_token,
              }
            : {
                mode: "mint",
                clientId: config.reviewGithubApp!.clientId,
                privateKey: config.reviewGithubApp!.privateKey,
                owner,
                repo,
              },
        )
      : null;

    const octokitFactory =
      deps.octokitFactory ??
      ((token: string) =>
        new Octokit({ auth: token }) as unknown as OctokitLike);
    const github = new GitHubAdapter(octokitFactory(primaryToken), {
      owner,
      repo,
    });
    const reviewGithub = reviewToken
      ? new GitHubAdapter(octokitFactory(reviewToken), { owner, repo })
      : null;

    const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
    const audit =
      deps.auditSink ??
      combineEmitters(createAuditEmitter({ runId }), createStepSummaryMirror());

    const agent = deps.agentFactory
      ? deps.agentFactory()
      : new ClaudeAgentAdapter();

    await runOrchestrator({
      event,
      repo: { owner, name: repo },
      github,
      reviewGithub,
      agent,
      audit,
      config,
      runId,
    });
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) core.error(err.stack);
  }
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
