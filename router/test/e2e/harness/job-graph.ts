import type { FakeGitHub } from "../fake-github";
import type { StageName, AgentRole } from "./agent-stub";

/**
 * Hand-maintained job graph mirroring `.github/workflows/shopfloor.yml`.
 *
 * Every stage block in this file encodes the router helper invocations,
 * the inline `id: ctx` / `id: ctx_revision` context builders, and the
 * single agent dispatch (one per stage, four-way fan-out for review)
 * that the production workflow runs. Keep this file in sync with the
 * YAML: when a step is added, removed, or has its inputs renamed in
 * the workflow, the corresponding entry here must be updated too.
 *
 * Shape choices:
 * - `helper` steps invoke the router's `main()` with a resolved set of
 *   INPUT_* env vars. Their outputs (parsed from GITHUB_OUTPUT) are
 *   stashed under both `previous[step.id]` (if an id was assigned) and
 *   `previous[step.helper]`.
 * - `context` steps emulate the workflow's shell `jq` blocks by writing
 *   a JSON file under the harness workspace and exposing its path as
 *   `previous[ctx.id].path`.
 * - `agent` steps consume one queued AgentStub response; the resulting
 *   record is exposed under `previous.agent` (or `previous.agent_review`
 *   for the four-way review fan-out).
 * - `if` steps are a conservative hedge; the graph is straight-line for
 *   every stage we encode today, but the type is here for future
 *   branching needs (e.g. review skip).
 */

export type HelperName =
  | "route"
  | "bootstrap-labels"
  | "open-stage-pr"
  | "advance-state"
  | "report-failure"
  | "handle-merge"
  | "create-progress-comment"
  | "finalize-progress-comment"
  | "check-review-skip"
  | "aggregate-review"
  | "render-prompt"
  | "apply-triage-decision"
  | "apply-impl-postwork"
  | "precheck-stage"
  | "build-revision-context";

export type InputSource =
  | { source: "literal"; value: string }
  | { source: "route"; key: string }
  | { source: "agent"; key: string }
  | { source: "agent-role"; role: AgentRole; key: string }
  | { source: "previous"; helper: HelperName | string; key: string }
  | { source: "fake"; resolve: (ctx: StageContext) => string };

export type InputMap = Record<string, InputSource>;

export interface StageContext {
  fake: FakeGitHub;
  routeOutputs: Record<string, string>;
  previous: Record<string, Record<string, string>>;
  workspaceDir: string;
  /**
   * The most recent event delivered via harness.deliverEvent. Used by
   * input resolvers that need event-payload data (e.g. handle-merge's
   * pr_number, which the workflow pulls from
   * github.event.pull_request.number, not from a route output).
   */
  currentEvent: { eventName: string; payload: unknown } | null;
  /** When false, the harness uses shopfloor:wip labels instead of draft PRs. Defaults to true. */
  useDraftPrs: boolean;
}

export interface ContextArtifact {
  /** Written to `${workspaceDir}/<id>.json`; the path is exposed as `previous[id].path`. */
  json: unknown;
}

export type GraphStep =
  | { kind: "helper"; id?: string; helper: HelperName; from: InputMap }
  | { kind: "agent"; stage: StageName }
  | {
      kind: "context";
      id: string;
      build: (ctx: StageContext) => ContextArtifact;
    }
  /**
   * Mutate fake-side state between helper invocations. Used to model
   * real-world side effects the harness otherwise cannot observe, e.g.
   * the git push that populates PR.files after the implement agent
   * runs. Cheaper and more honest than extending FakeGitHub with
   * production-shaped stub APIs nobody actually calls.
   */
  | { kind: "fake"; id?: string; mutate: (ctx: StageContext) => void }
  | { kind: "if"; when: (ctx: StageContext) => boolean; then: GraphStep[] };

export type StageKey =
  | "triage"
  | "spec"
  | "spec-revision"
  | "plan"
  | "plan-revision"
  | "implement-first-run"
  | "implement-revision"
  | "review"
  | "handle-merge";

export const jobGraph: Record<StageKey, GraphStep[]> = {
  triage: [],
  spec: [],
  "spec-revision": [],
  plan: [],
  "plan-revision": [],
  "implement-first-run": [],
  "implement-revision": [],
  review: [],
  "handle-merge": [],
};

// -----------------------------------------------------------------------
// triage stage (shopfloor.yml: jobs.triage, line ~172)
// -----------------------------------------------------------------------

jobGraph.triage = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "triage" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:triaging" },
    },
  },
  {
    kind: "context",
    id: "ctx",
    build: (ctx) => {
      const issueNumber = Number(ctx.routeOutputs.issue_number);
      const issue = ctx.fake.issue(issueNumber);
      return {
        json: {
          issue_number: String(issueNumber),
          issue_title: issue.title,
          issue_body: issue.body ?? "",
          issue_comments: ctx.fake
            .commentsOn(issueNumber)
            .map((c) => `**@${c.author}**:\n${c.body}`)
            .join("\n\n---\n\n"),
          repo_owner: ctx.fake.owner,
          repo_name: ctx.fake.repo,
        },
      };
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/triage.md" },
      context_file: { source: "previous", helper: "ctx", key: "path" },
      base_allowed_tools: { source: "literal", value: "Read,Glob,Grep" },
    },
  },
  { kind: "agent", stage: "triage" },
  {
    kind: "helper",
    helper: "apply-triage-decision",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      decision_json: { source: "agent", key: "decision_json" },
    },
  },
];

// -----------------------------------------------------------------------
// spec stage (shopfloor.yml: jobs.spec, line ~304)
//
// Mirrors the production order: precheck, advance to spec-running,
// (git checkout -- elided, harness is not a real checkout), build
// context, render prompt, agent, open-stage-pr, advance to
// spec-in-review. The workflow's commit/push steps are omitted because
// the fake-github layer has no working tree; tests that need to assert
// spec file contents should seed the file with `harness.seedFile()`.
// -----------------------------------------------------------------------

jobGraph.spec = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "spec" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:spec-running" },
    },
  },
  {
    kind: "context",
    id: "ctx",
    build: (ctx) => {
      const issueNumber = Number(ctx.routeOutputs.issue_number);
      const issue = ctx.fake.issue(issueNumber);
      return {
        json: {
          issue_number: String(issueNumber),
          issue_title: issue.title,
          issue_body: issue.body ?? "",
          issue_comments: ctx.fake
            .commentsOn(issueNumber)
            .map((c) => `**@${c.author}**:\n${c.body}`)
            .join("\n\n---\n\n"),
          triage_rationale: "",
          branch_name: ctx.routeOutputs.branch_name ?? "",
          spec_file_path: ctx.routeOutputs.spec_file_path ?? "",
          repo_owner: ctx.fake.owner,
          repo_name: ctx.fake.repo,
          revision_block: "",
        },
      };
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/spec.md" },
      context_file: { source: "previous", helper: "ctx", key: "path" },
      base_allowed_tools: {
        source: "literal",
        value: "Read,Glob,Grep,Edit,Write,WebFetch",
      },
    },
  },
  { kind: "agent", stage: "spec" },
  {
    kind: "helper",
    id: "open_pr",
    helper: "open-stage-pr",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      stage: { source: "literal", value: "spec" },
      branch_name: { source: "route", key: "branch_name" },
      base_branch: { source: "literal", value: "main" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: {
        source: "literal",
        value: "shopfloor:needs-spec,shopfloor:triaging,shopfloor:spec-running",
      },
      to_labels: { source: "literal", value: "shopfloor:spec-in-review" },
    },
  },
];

// -----------------------------------------------------------------------
// spec stage (revision)
// shopfloor.yml: jobs.spec with revision_mode == 'true'
// -----------------------------------------------------------------------

jobGraph["spec-revision"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "spec" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:spec-running" },
    },
  },
  {
    kind: "helper",
    id: "ctx_revision",
    helper: "build-revision-context",
    from: {
      stage: { source: "literal", value: "spec" },
      issue_number: { source: "route", key: "issue_number" },
      pr_number: {
        source: "fake",
        resolve: (ctx) => {
          // On a revision run the PR number comes from the event payload
          // (pull_request_review event), same as the YAML's
          // github.event.pull_request.number. The harness stashes the
          // event, so we can resolve it from the route outputs where the
          // spec-rework scenario stores it, or fall back to finding the
          // open PR by branch.
          const ev = ctx.currentEvent?.payload as
            | { pull_request?: { number?: number } }
            | undefined;
          if (ev?.pull_request?.number) return String(ev.pull_request.number);
          // Fallback: find the open spec PR by branch
          const branch = ctx.routeOutputs.branch_name;
          const pr = ctx.fake.openPrs().find((p) => p.head.ref === branch);
          return pr ? String(pr.number) : "0";
        },
      },
      branch_name: { source: "route", key: "branch_name" },
      spec_file_path: { source: "route", key: "spec_file_path" },
      plan_file_path: { source: "literal", value: "" },
      progress_comment_id: { source: "literal", value: "" },
      bash_allowlist: { source: "literal", value: "" },
      repo_owner: { source: "fake", resolve: (ctx) => ctx.fake.owner },
      repo_name: { source: "fake", resolve: (ctx) => ctx.fake.repo },
      output_path: {
        source: "fake",
        resolve: (ctx) => `${ctx.workspaceDir}/context.json`,
      },
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/spec.md" },
      context_file: {
        source: "previous",
        helper: "ctx_revision",
        key: "path",
      },
      base_allowed_tools: {
        source: "literal",
        value: "Read,Glob,Grep,Edit,Write,WebFetch",
      },
    },
  },
  { kind: "agent", stage: "spec" },
  {
    kind: "helper",
    id: "open_pr",
    helper: "open-stage-pr",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      stage: { source: "literal", value: "spec" },
      branch_name: { source: "route", key: "branch_name" },
      base_branch: { source: "literal", value: "main" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: {
        source: "literal",
        value: "shopfloor:needs-spec,shopfloor:triaging,shopfloor:spec-running",
      },
      to_labels: { source: "literal", value: "shopfloor:spec-in-review" },
    },
  },
];

// -----------------------------------------------------------------------
// plan stage (shopfloor.yml: jobs.plan, line ~469)
// -----------------------------------------------------------------------

jobGraph.plan = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "plan" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:plan-running" },
    },
  },
  {
    kind: "context",
    id: "ctx",
    build: (ctx) => {
      const issueNumber = Number(ctx.routeOutputs.issue_number);
      const issue = ctx.fake.issue(issueNumber);
      return {
        json: {
          issue_number: String(issueNumber),
          issue_title: issue.title,
          issue_body: issue.body ?? "",
          issue_comments: ctx.fake
            .commentsOn(issueNumber)
            .map((c) => `**@${c.author}**:\n${c.body}`)
            .join("\n\n---\n\n"),
          branch_name: ctx.routeOutputs.branch_name ?? "",
          plan_file_path: ctx.routeOutputs.plan_file_path ?? "",
          spec_file_path: ctx.routeOutputs.spec_file_path ?? "",
          repo_owner: ctx.fake.owner,
          repo_name: ctx.fake.repo,
          revision_block: "",
        },
      };
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/plan.md" },
      context_file: { source: "previous", helper: "ctx", key: "path" },
      base_allowed_tools: {
        source: "literal",
        value: "Read,Glob,Grep,Edit,Write,WebFetch",
      },
    },
  },
  { kind: "agent", stage: "plan" },
  {
    kind: "helper",
    id: "open_pr",
    helper: "open-stage-pr",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      stage: { source: "literal", value: "plan" },
      branch_name: { source: "route", key: "branch_name" },
      base_branch: { source: "literal", value: "main" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: {
        source: "literal",
        value: "shopfloor:needs-plan,shopfloor:plan-running",
      },
      to_labels: { source: "literal", value: "shopfloor:plan-in-review" },
    },
  },
];

// -----------------------------------------------------------------------
// plan stage (revision)
// shopfloor.yml: jobs.plan with revision_mode == 'true'
// -----------------------------------------------------------------------

jobGraph["plan-revision"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "plan" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:plan-running" },
    },
  },
  {
    kind: "helper",
    id: "ctx_revision",
    helper: "build-revision-context",
    from: {
      stage: { source: "literal", value: "plan" },
      issue_number: { source: "route", key: "issue_number" },
      pr_number: {
        source: "fake",
        resolve: (ctx) => {
          const ev = ctx.currentEvent?.payload as
            | { pull_request?: { number?: number } }
            | undefined;
          if (ev?.pull_request?.number) return String(ev.pull_request.number);
          const branch = ctx.routeOutputs.branch_name;
          const pr = ctx.fake.openPrs().find((p) => p.head.ref === branch);
          return pr ? String(pr.number) : "0";
        },
      },
      branch_name: { source: "route", key: "branch_name" },
      spec_file_path: { source: "route", key: "spec_file_path" },
      plan_file_path: { source: "route", key: "plan_file_path" },
      progress_comment_id: { source: "literal", value: "" },
      bash_allowlist: { source: "literal", value: "" },
      repo_owner: { source: "fake", resolve: (ctx) => ctx.fake.owner },
      repo_name: { source: "fake", resolve: (ctx) => ctx.fake.repo },
      output_path: {
        source: "fake",
        resolve: (ctx) => `${ctx.workspaceDir}/context.json`,
      },
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/plan.md" },
      context_file: {
        source: "previous",
        helper: "ctx_revision",
        key: "path",
      },
      base_allowed_tools: {
        source: "literal",
        value: "Read,Glob,Grep,Edit,Write,WebFetch",
      },
    },
  },
  { kind: "agent", stage: "plan" },
  {
    kind: "helper",
    id: "open_pr",
    helper: "open-stage-pr",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      stage: { source: "literal", value: "plan" },
      branch_name: { source: "route", key: "branch_name" },
      base_branch: { source: "literal", value: "main" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: {
        source: "literal",
        value: "shopfloor:needs-plan,shopfloor:plan-running",
      },
      to_labels: { source: "literal", value: "shopfloor:plan-in-review" },
    },
  },
];

// -----------------------------------------------------------------------
// implement stage (first run)
// shopfloor.yml: jobs.implement with id: ctx at line ~831
// -----------------------------------------------------------------------

jobGraph["implement-first-run"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "implement" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:implementing" },
    },
  },
  {
    kind: "helper",
    id: "open_pr",
    helper: "open-stage-pr",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      stage: { source: "literal", value: "implement" },
      branch_name: { source: "route", key: "branch_name" },
      base_branch: { source: "literal", value: "main" },
      pr_title: { source: "literal", value: "wip: impl" },
      pr_body: { source: "literal", value: "Shopfloor is implementing." },
      draft: {
        source: "fake",
        resolve: (ctx) => (ctx.useDraftPrs ? "true" : "false"),
      },
    },
  },
  {
    kind: "fake",
    id: "add_wip_label",
    mutate: (ctx) => {
      if (ctx.useDraftPrs) return;
      const prNumberStr = ctx.previous.open_pr?.pr_number;
      if (!prNumberStr) return;
      const prNumber = Number(prNumberStr);
      const pr = ctx.fake.pr(prNumber);
      pr.labels.push({ name: "shopfloor:wip" });
    },
  },
  {
    kind: "helper",
    id: "progress",
    helper: "create-progress-comment",
    from: {
      pr_number: { source: "previous", helper: "open_pr", key: "pr_number" },
    },
  },
  {
    kind: "context",
    id: "ctx",
    build: (ctx) => {
      const issueNumber = Number(ctx.routeOutputs.issue_number);
      const issue = ctx.fake.issue(issueNumber);
      return {
        json: {
          issue_number: String(issueNumber),
          issue_title: issue.title,
          issue_body: issue.body ?? "",
          issue_comments: "",
          spec_file_path: ctx.routeOutputs.spec_file_path ?? "",
          plan_file_path: ctx.routeOutputs.plan_file_path ?? "",
          branch_name: ctx.routeOutputs.branch_name ?? "",
          progress_comment_id: ctx.previous.progress?.comment_id ?? "",
          revision_block: "",
          bash_allowlist: "pnpm test:*",
          repo_owner: ctx.fake.owner,
          repo_name: ctx.fake.repo,
        },
      };
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/implement.md" },
      context_file: { source: "previous", helper: "ctx", key: "path" },
      base_allowed_tools: { source: "literal", value: "Read,Edit,Write" },
    },
  },
  { kind: "agent", stage: "implement" },
  {
    kind: "fake",
    id: "push_files",
    mutate: (ctx) => {
      // Models the git push between the agent finishing and the
      // workflow re-querying the PR for changed files. The implement
      // agent stub exposes `changed_files` as a JSON string array;
      // older scenarios that don't set it get an empty list and
      // check-review-skip will correctly short-circuit.
      const raw = ctx.previous.agent?.changed_files ?? "";
      const prNumberStr = ctx.previous.open_pr?.pr_number;
      if (!prNumberStr) return;
      const prNumber = Number(prNumberStr);
      let files: string[] = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) files = parsed.map((f) => String(f));
        } catch {
          files = [];
        }
      }
      ctx.fake.setPrFiles(prNumber, files);
    },
  },
  {
    kind: "fake",
    id: "mark_ready",
    mutate: (ctx) => {
      const prNumberStr = ctx.previous.open_pr?.pr_number;
      if (!prNumberStr) return;
      const prNumber = Number(prNumberStr);
      const pr = ctx.fake.pr(prNumber);
      if (ctx.useDraftPrs) {
        // Draft mode: mirror `gh pr ready`
        pr.draft = false;
      } else {
        // WIP mode: mirror `gh pr edit --remove-label shopfloor:wip`
        pr.labels = pr.labels.filter((l) => l.name !== "shopfloor:wip");
      }
    },
  },
  {
    kind: "helper",
    helper: "finalize-progress-comment",
    from: {
      comment_id: { source: "previous", helper: "progress", key: "comment_id" },
      terminal_state: { source: "literal", value: "success" },
      final_body: { source: "agent", key: "summary_for_issue_comment" },
    },
  },
  {
    kind: "helper",
    helper: "apply-impl-postwork",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "previous", helper: "open_pr", key: "pr_number" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
      has_review_app: { source: "literal", value: "true" },
    },
  },
];

// -----------------------------------------------------------------------
// implement stage (revision loop)
// shopfloor.yml: jobs.implement with id: ctx_revision at line ~889
// -----------------------------------------------------------------------

jobGraph["implement-revision"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "implement" },
      issue_number: { source: "route", key: "issue_number" },
    },
  },
  {
    kind: "helper",
    helper: "advance-state",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      from_labels: { source: "literal", value: "" },
      to_labels: { source: "literal", value: "shopfloor:implementing" },
    },
  },
  {
    kind: "fake",
    id: "add_wip_label_revision",
    mutate: (ctx) => {
      if (ctx.useDraftPrs) return;
      const prNumberStr = ctx.routeOutputs.impl_pr_number;
      if (!prNumberStr) return;
      const prNumber = Number(prNumberStr);
      const pr = ctx.fake.pr(prNumber);
      if (!pr.labels.some((l) => l.name === "shopfloor:wip")) {
        pr.labels.push({ name: "shopfloor:wip" });
      }
    },
  },
  {
    kind: "helper",
    id: "progress",
    helper: "create-progress-comment",
    from: { pr_number: { source: "route", key: "impl_pr_number" } },
  },
  {
    kind: "helper",
    id: "ctx_revision",
    helper: "build-revision-context",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      branch_name: { source: "route", key: "branch_name" },
      spec_file_path: { source: "route", key: "spec_file_path" },
      plan_file_path: { source: "route", key: "plan_file_path" },
      progress_comment_id: {
        source: "previous",
        helper: "progress",
        key: "comment_id",
      },
      bash_allowlist: { source: "literal", value: "pnpm test:*" },
      repo_owner: { source: "fake", resolve: (ctx) => ctx.fake.owner },
      repo_name: { source: "fake", resolve: (ctx) => ctx.fake.repo },
      output_path: {
        source: "fake",
        resolve: (ctx) => `${ctx.workspaceDir}/context.json`,
      },
    },
  },
  {
    kind: "helper",
    helper: "render-prompt",
    from: {
      prompt_file: { source: "literal", value: "prompts/implement.md" },
      context_file: {
        source: "previous",
        helper: "ctx_revision",
        key: "path",
      },
      base_allowed_tools: { source: "literal", value: "Read,Edit,Write" },
    },
  },
  { kind: "agent", stage: "implement" },
  {
    kind: "fake",
    id: "push_files_revision",
    mutate: (ctx) => {
      // Same git-push stand-in as the first-run branch above. For a
      // revision, the PR number comes from route output, not open_pr.
      // Unlike the first-run path, we also advance the branch head sha:
      // an actual `git push` here produces a new commit, and downstream
      // aggregate-review uses that new sha as the commit_id on its
      // REQUEST_CHANGES / APPROVE record. Without the advance, the new
      // review collides with the previous iteration's review on the
      // same commit, and build-revision-context can no longer tell
      // which review is "current".
      const raw = ctx.previous.agent?.changed_files ?? "";
      const prNumberStr = ctx.routeOutputs.impl_pr_number;
      if (!prNumberStr) return;
      const prNumber = Number(prNumberStr);
      let files: string[] = [];
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) files = parsed.map((f) => String(f));
        } catch {
          files = [];
        }
      }
      ctx.fake.setPrFiles(prNumber, files);
      const branch = ctx.routeOutputs.branch_name;
      if (branch) ctx.fake.advanceSha(branch);
    },
  },
  {
    kind: "fake",
    id: "mark_ready_revision",
    mutate: (ctx) => {
      if (ctx.useDraftPrs) return;
      const prNumberStr = ctx.routeOutputs.impl_pr_number;
      if (!prNumberStr) return;
      const prNumber = Number(prNumberStr);
      const pr = ctx.fake.pr(prNumber);
      pr.labels = pr.labels.filter((l) => l.name !== "shopfloor:wip");
    },
  },
  {
    kind: "helper",
    helper: "finalize-progress-comment",
    from: {
      comment_id: { source: "previous", helper: "progress", key: "comment_id" },
      terminal_state: { source: "literal", value: "success" },
      final_body: { source: "agent", key: "summary_for_issue_comment" },
    },
  },
  {
    kind: "helper",
    helper: "apply-impl-postwork",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      pr_title: { source: "agent", key: "pr_title" },
      pr_body: { source: "agent", key: "pr_body" },
      has_review_app: { source: "literal", value: "true" },
    },
  },
];

// -----------------------------------------------------------------------
// review stage (shopfloor.yml: review-skip-check + four reviewer jobs +
// review-aggregator, lines ~1058 through ~1577)
// -----------------------------------------------------------------------

jobGraph.review = [
  {
    kind: "helper",
    id: "skip",
    helper: "check-review-skip",
    from: { pr_number: { source: "route", key: "impl_pr_number" } },
  },
  { kind: "agent", stage: "review" },
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "review-aggregator" },
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      analysed_sha: {
        source: "fake",
        resolve: (ctx) =>
          ctx.fake.pr(Number(ctx.routeOutputs.impl_pr_number)).head.sha,
      },
    },
  },
  {
    kind: "helper",
    helper: "aggregate-review",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      pr_number: { source: "route", key: "impl_pr_number" },
      confidence_threshold: { source: "literal", value: "80" },
      max_iterations: { source: "literal", value: "3" },
      compliance_output: {
        source: "agent-role",
        role: "compliance",
        key: "output",
      },
      bugs_output: { source: "agent-role", role: "bugs", key: "output" },
      security_output: {
        source: "agent-role",
        role: "security",
        key: "output",
      },
      smells_output: { source: "agent-role", role: "smells", key: "output" },
      analysed_sha: {
        source: "fake",
        resolve: (ctx) =>
          ctx.fake.pr(Number(ctx.routeOutputs.impl_pr_number)).head.sha,
      },
    },
  },
];

// -----------------------------------------------------------------------
// handle-merge stage (shopfloor.yml: jobs.handle-merge, line ~1577)
// -----------------------------------------------------------------------

function parseMergedStage(routeReason: string): string {
  return routeReason
    .replace(/^pr_merged_/, "")
    .replace(/_triggered_label_flip$/, "");
}

function eventPrNumber(ctx: StageContext): string {
  const ev = ctx.currentEvent?.payload as
    | { pull_request?: { number?: number } }
    | undefined;
  const n = ev?.pull_request?.number;
  if (n === undefined) {
    throw new Error(
      "handle-merge graph step: currentEvent has no pull_request.number; deliver a PR-closed event before runStage('handle-merge').",
    );
  }
  return String(n);
}

jobGraph["handle-merge"] = [
  {
    kind: "helper",
    helper: "precheck-stage",
    from: {
      stage: { source: "literal", value: "handle-merge" },
      issue_number: { source: "route", key: "issue_number" },
      merged_stage: {
        source: "fake",
        resolve: (ctx) => parseMergedStage(ctx.routeOutputs.reason ?? ""),
      },
    },
  },
  {
    kind: "helper",
    helper: "handle-merge",
    from: {
      issue_number: { source: "route", key: "issue_number" },
      merged_stage: {
        source: "fake",
        resolve: (ctx) => parseMergedStage(ctx.routeOutputs.reason ?? ""),
      },
      pr_number: { source: "fake", resolve: eventPrNumber },
    },
  },
];
