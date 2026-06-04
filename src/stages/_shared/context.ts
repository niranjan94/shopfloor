import type { AgentAdapter } from "../../agents/adapter.js";
import type { AuditEmitter } from "../../audit/events.js";
import type { Config } from "../../config/inputs.js";
import type { GitHubAdapter } from "../../github/adapter.js";
import type { EventPayload, RouterDecision } from "../../state/types.js";

// Side-effecting git operations the implement stage performs against the
// working tree. Closed over the resolved AuthSpec by entry.ts so individual
// stage runners never see the raw token. Optional on StageContext because
// stage-level tests construct their own context without a real checkout;
// production wires these through.
export interface GitOps {
  prepareImplCheckout(opts: {
    branchName: string;
    baseBranch: string;
    revisionMode: boolean;
  }): Promise<void>;
  pushImplCommits(opts: { branchName: string }): Promise<void>;
  // Provisions the base branch as a local `origin/<baseRef>` ref so the review
  // lenses can diff the PR against it via `git diff origin/<baseRef> HEAD`.
  prepareReviewBase(opts: { baseRef: string }): Promise<void>;
}

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
  // Side-effecting git helpers used by the implement stage. Optional so unit
  // tests that construct StageContext directly need not stub them. When unset
  // in production code, the implement stage emits a loud warning and skips
  // the working-tree mutations and the post-agent push, which will leave the
  // PR creation to fail at GitHub's "no commits between base and head" check.
  gitOps?: GitOps;
}
