import type { AgentAdapter } from "../../agents/adapter.js";
import type { GitHubAdapter } from "../../github/adapter.js";
import type { AuditEmitter } from "../../audit/events.js";
import type { Config } from "../../config/inputs.js";
import type { EventPayload, RouterDecision } from "../../state/types.js";

export interface StageContext {
  event: EventPayload;
  repo: { owner: string; name: string };
  // The repository's default branch, resolved once per invocation. Used as
  // the base for every stage PR (spec/plan/implement) so Shopfloor follows
  // whatever the repo treats as its trunk rather than assuming "main".
  defaultBranch: string;
  decision: RouterDecision;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    labels: string[];
  };
  pr?: {
    number: number;
    title: string;
    body: string | null;
    headRef: string;
    headSha: string;
    baseRef: string;
  };
  github: GitHubAdapter;
  // Distinct App for posting reviews; null when no review App is configured.
  // Falling back to ctx.github causes GitHub to reject APPROVE/REQUEST_CHANGES
  // because the bot would be reviewing its own PR.
  reviewGithub: GitHubAdapter | null;
  agent: AgentAdapter;
  audit: AuditEmitter;
  config: Config;
  runId: string;
  // True when the orchestrator was invoked in review-only mode against a
  // human-authored PR. Review stage treats the PR as stateless: no iteration
  // counter, no Shopfloor label flips, no PR body mutation. Every push gets a
  // fresh review.
  reviewOnly?: boolean;
}
