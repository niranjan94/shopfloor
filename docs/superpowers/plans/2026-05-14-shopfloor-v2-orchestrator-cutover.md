# Shopfloor v2 — Plan 3: Orchestrator, Action Shell, E2E, Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Plans 1 and 2 into a runnable GitHub Action. Add the orchestrator that drives the state-machine → stage → apply loop, build the action entrypoint, ship `action.yml` and a sample workflow, run black-box e2e tests against fixture events, perform a manual smoke test, then cut over `main` by deleting the v1 surface and tagging `v2.0.0`.

**Architecture:** `entry.ts` is the action's Node 24 entrypoint. It parses inputs (via `parseConfig`), mints App tokens, builds the `StageContext`, hands control to `orchestrator.ts`. The orchestrator routes via the state machine, runs the matched stage, applies side effects, and exits. E2E tests drive `orchestrator.ts` end to end with a fake `AgentAdapter` and a recording `GitHubAdapter`. Cutover is a single commit on `main` that deletes the v1 packages and the reusable workflow.

**Tech Stack:** Same as Plans 1 and 2. Adds esbuild bundling to `dist/index.cjs`.

**Source of truth:** `docs/superpowers/specs/2026-05-14-shopfloor-v2-design.md` §3, §7, §9, §12.

**Branch:** `v2`. Plans 1 and 2 must be merged or rebased.

**Prerequisite:** All of Plans 1 and 2 in place with green tests.

---

## Repository layout (after Plan 3)

```
shopfloor/
├── action.yml
├── examples/
│   └── shopfloor.yml
├── src/
│   ├── entry.ts
│   ├── orchestrator.ts
│   └── runners.ts           # tiny registry mapping Stage → run+apply pair
├── test/
│   ├── e2e/
│   │   ├── orchestrator.test.ts
│   │   └── fixtures/        # event payloads from router/test/fixtures/events
│   └── _harness/
│       ├── fake-agent.ts
│       └── recording-github.ts
└── dist/
    └── index.cjs            # committed bundle
```

Plan 3's cutover commit (Task 7) also deletes:
- `router/` (entire directory)
- `mcp-servers/` (entire directory)
- `prompts/` (entire directory)
- `.github/workflows/shopfloor.yml`
- `pnpm-workspace.yaml`

---

## Task 1: Orchestrator wiring

**Files:**
- Create: `src/orchestrator.ts`
- Create: `src/runners.ts`
- Create: `test/orchestrator.test.ts`
- Read for reference: spec §3 "What happens inside the process", §7 "Data flow"

- [ ] **Step 1: Create `src/runners.ts` — the stage → (run, apply) registry**

```ts
import type { Stage } from "./state/labels.js";
import type { StageContext } from "./stages/_shared/context.js";

import { runTriage } from "./stages/triage/runner.js";
import { applyTriage } from "./stages/triage/apply.js";
import { runSpec } from "./stages/spec/runner.js";
import { applySpec } from "./stages/spec/apply.js";
import { runPlan } from "./stages/plan/runner.js";
import { applyPlan } from "./stages/plan/apply.js";
import { runImplement } from "./stages/implement/runner.js";
import { applyImplement } from "./stages/implement/apply.js";
import { runReview } from "./stages/review/runner.js";
import { applyReview } from "./stages/review/apply.js";
import { aggregateFindings } from "./stages/review/aggregate.js";

export interface StageRunner {
  run(ctx: StageContext, extras?: unknown): Promise<unknown>;
  apply(ctx: StageContext, decision: unknown, extras?: unknown): Promise<unknown>;
}

export const RUNNERS: Record<Stage, StageRunner> = {
  triage: { run: (c) => runTriage(c), apply: (c, d) => applyTriage(c, d as any) },
  spec:   { run: (c) => runSpec(c),   apply: (c, d) => applySpec(c, d as any) },
  plan:   { run: (c) => runPlan(c),   apply: (c, d) => applyPlan(c, d as any) },
  implement: {
    run: async (c, x) => runImplement(c, x as any),
    apply: async (c, d, x) => applyImplement(c, { decision: d as any, ...(x as any) }),
  },
  review: {
    run: (c) => runReview(c),
    apply: (c, d, x) => {
      const verdict = aggregateFindings(d as any);
      return applyReview(c, verdict, (x as any).iteration);
    },
  },
};
```

- [ ] **Step 2: Write `test/orchestrator.test.ts`**

The orchestrator test uses a fake agent (returns canned decisions) and a recording GitHub adapter (logs every call). For each fixture event, drive the orchestrator and assert the call ledger plus the audit stream.

```ts
import { describe, expect, it, vi } from "vitest";
import { runOrchestrator } from "../src/orchestrator.js";
import { FakeAgent } from "./_harness/fake-agent.js";
import { RecordingGithub } from "./_harness/recording-github.js";
import issueOpenedLarge from "./e2e/fixtures/issues.opened.large.json" with { type: "json" };

describe("orchestrator", () => {
  it("on issues.opened with the trigger label, routes to triage and applies decision", async () => {
    const audit: any[] = [];
    const agent = new FakeAgent([
      { match: "do the thing", decision: { complexity: "large", slug: "do-thing", rationale: "x x x x x x x x x x" } },
    ]);
    const github = new RecordingGithub();

    await runOrchestrator({
      event: issueOpenedLarge,
      repo: { owner: "octo", name: "demo" },
      github,
      reviewGithub: null,
      agent,
      audit: (e) => audit.push(e),
      config: { triggerLabel: "shopfloor", triageModel: "claude-haiku", budgets: { triageUsd: 0.25 }, timeouts: { triageMs: 60_000 }, maxReviewIterations: 3 } as any,
      runId: "test-run-1",
    });

    expect(audit.map(e => e.type)).toContain("stage_resolved");
    expect(audit.map(e => e.type)).toContain("stage_decided");
    expect(github.calls.replaceLabels).toContainEqual(expect.objectContaining({
      add: expect.arrayContaining(["shopfloor:complexity:large", "shopfloor:needs-spec"]),
    }));
  });

  it("exits cleanly with stage_resolved=none for unrelated events", async () => {
    const audit: any[] = [];
    await runOrchestrator({
      event: { name: "push", payload: {} } as any,
      repo: { owner: "octo", name: "demo" },
      github: new RecordingGithub(),
      reviewGithub: null,
      agent: new FakeAgent([]),
      audit: (e) => audit.push(e),
      config: {} as any,
      runId: "r",
    });
    const resolved = audit.find(e => e.type === "stage_resolved");
    expect(resolved?.stage).toBe("none");
  });
});
```

Create `test/_harness/fake-agent.ts`:

```ts
import { z } from "zod";
import type { AgentAdapter, RunStageArgs } from "../../src/agents/adapter.js";

export interface FakeResponse {
  match: string;
  decision?: unknown;
  error?: { kind: string; message: string };
}

export class FakeAgent implements AgentAdapter {
  constructor(private readonly responses: FakeResponse[]) {}

  async runStage<T>(args: RunStageArgs<T>): Promise<T> {
    for (const r of this.responses) {
      if (!args.userPrompt.includes(r.match)) continue;
      if (r.error) throw Object.assign(new Error(r.error.message), { kind: r.error.kind });
      return args.decisionSchema.parse(r.decision);
    }
    throw new Error(`FakeAgent: no response matched: ${args.userPrompt.slice(0, 80)}`);
  }
}
```

Create `test/_harness/recording-github.ts`:

```ts
export class RecordingGithub {
  public calls: Record<string, any[]> = {
    replaceLabels: [], ensureLabelsExist: [], upsertIssueMetadata: [], addIssueComment: [],
    updateIssueComment: [], createPullRequest: [], updatePullRequestBody: [],
    setPullRequestDraft: [], createCommit: [], postReview: [],
  };

  async getIssueLabels() { return []; }
  async replaceLabels(issueNumber: number, change: any) { this.calls.replaceLabels.push({ issueNumber, ...change }); }
  async ensureLabelsExist(labels: any[]) { this.calls.ensureLabelsExist.push(labels); }
  async getIssue() { return null as any; }
  async upsertIssueMetadata(issueNumber: number, md: any) { this.calls.upsertIssueMetadata.push({ issueNumber, md }); }
  async addIssueComment(issueNumber: number, body: string) { this.calls.addIssueComment.push({ issueNumber, body }); return { id: 1 }; }
  async updateIssueComment(commentId: number, body: string) { this.calls.updateIssueComment.push({ commentId, body }); }
  async getPullRequest() { return null as any; }
  async createPullRequest(args: any) { this.calls.createPullRequest.push(args); return { number: 200 }; }
  async updatePullRequestBody(n: number, body: string) { this.calls.updatePullRequestBody.push({ n, body }); }
  async setPullRequestDraft(n: number, draft: boolean) { this.calls.setPullRequestDraft.push({ n, draft }); }
  async listPullRequestFiles() { return []; }
  async listPullRequestReviewComments() { return []; }
  async createOrUpdateRef() {}
  async getRef() { return null; }
  async createCommit(args: any) { this.calls.createCommit.push(args); return { sha: "abc1234" }; }
  async postReview(prNumber: number, args: any) { this.calls.postReview.push({ prNumber, ...args }); }
}
```

Copy `test/e2e/fixtures/issues.opened.large.json` from `router/test/fixtures/events/`.

- [ ] **Step 3: Run, expect failure**

```bash
pnpm test test/orchestrator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/orchestrator.ts`**

```ts
import type { GitHubAdapter } from "./github/adapter.js";
import type { AgentAdapter } from "./agents/adapter.js";
import type { AuditEmitter } from "./audit/events.js";
import type { Config } from "./config/inputs.js";
import { resolveStage } from "./state/machine.js";
import { LABELS, runningLabelFor, failedLabelFor, type Stage } from "./state/labels.js";
import { RUNNERS } from "./runners.js";
import { AgentError } from "./agents/adapter.js";
import type { StageContext } from "./stages/_shared/context.js";

export interface OrchestratorArgs {
  event: { name: string; payload: unknown };
  repo: { owner: string; name: string };
  github: GitHubAdapter;
  reviewGithub: GitHubAdapter | null;
  agent: AgentAdapter;
  audit: AuditEmitter;
  config: Config;
  runId: string;
}

export async function runOrchestrator(args: OrchestratorArgs): Promise<void> {
  const labels = await readLabelsFromEvent(args);
  const decision = resolveStage({ event: args.event, labels });

  args.audit({ type: "stage_resolved", stage: decision.stage, reason: decision.reason, issueNumber: decision.issueNumber });

  if (decision.stage === "none") return;

  const stage = decision.stage as Stage;
  const issue = await loadIssueIfRelevant(args, decision);
  const pr = await loadPrIfRelevant(args, decision);

  const ctx: StageContext = {
    event: args.event,
    repo: args.repo,
    decision,
    issue, pr,
    github: args.github,
    reviewGithub: args.reviewGithub,
    agent: args.agent,
    audit: args.audit,
    config: args.config,
    runId: args.runId,
  };

  const precheck = await precheckStage(ctx, stage);
  if (precheck != "ok") {
    args.audit({ type: "precheck_failed", stage, reason: precheck });
    return;
  }

  const running = runningLabelFor(stage);
  await args.github.replaceLabels(decision.issueNumber!, { add: [running] });

  args.audit({ type: "stage_started", stage, model: modelForStage(stage, args.config), runId: args.runId });

  try {
    const runner = RUNNERS[stage];
    const decisionPayload = await runner.run(ctx, await extrasForStage(ctx, stage));
    await runner.apply(ctx, decisionPayload, await applyExtrasForStage(ctx, stage));
  } catch (err) {
    await reportFailure(ctx, stage, err);
    throw err;
  } finally {
    await args.github.replaceLabels(decision.issueNumber!, { remove: [running] });
  }
}

async function readLabelsFromEvent(args: OrchestratorArgs): Promise<string[]> {
  // Implementation: pull labels from the event payload (issues.opened/labeled/unlabeled
  // include the full issue.labels array; pull_request events include pull_request.labels).
  // For events that do not carry labels, fetch via args.github.getIssueLabels(...).
  return [];
}

async function loadIssueIfRelevant(_args: OrchestratorArgs, _d: ReturnType<typeof resolveStage>): Promise<StageContext["issue"]> { return undefined; }
async function loadPrIfRelevant(_args: OrchestratorArgs, _d: ReturnType<typeof resolveStage>): Promise<StageContext["pr"]> { return undefined; }

async function precheckStage(_ctx: StageContext, _stage: Stage): Promise<"ok" | string> { return "ok"; }

async function extrasForStage(_ctx: StageContext, _stage: Stage): Promise<unknown> { return undefined; }
async function applyExtrasForStage(_ctx: StageContext, _stage: Stage): Promise<unknown> { return undefined; }

function modelForStage(stage: Stage, cfg: Config): string {
  switch (stage) {
    case "triage": return cfg.triageModel;
    case "spec":   return cfg.specModel;
    case "plan":   return cfg.planModel;
    case "implement": return cfg.implModel;
    case "review": return cfg.reviewModels.compliance; // representative
  }
}

async function reportFailure(ctx: StageContext, stage: Stage, err: unknown): Promise<void> {
  const kind = err instanceof AgentError ? err.kind : "internal";
  const message = err instanceof Error ? err.message : String(err);
  if (ctx.issue) {
    await ctx.github.replaceLabels(ctx.issue.number, { add: [failedLabelFor(stage)] });
    await ctx.github.addIssueComment(ctx.issue.number, formatFailureComment(stage, kind, message, ctx.runId));
  }
  ctx.audit({ type: "stage_failed", stage, error: { kind, message } });
}

function formatFailureComment(stage: Stage, kind: string, message: string, runId: string): string {
  return [
    `## Shopfloor ${stage} failure`,
    "",
    `**Kind:** \`${kind}\``,
    `**Run:** \`${runId}\``,
    "",
    "```",
    message.slice(0, 4000),
    "```",
    "",
    `Remove the \`shopfloor:failed:${stage}\` label to retry.`,
  ].join("\n");
}
```

The helpers stubbed as `return undefined` (`extrasForStage`, `applyExtrasForStage`, `precheckStage`, `readLabelsFromEvent`, `loadIssueIfRelevant`, `loadPrIfRelevant`) need real implementations. Port them from v1's `router/src/helpers/precheck-stage.ts`, `router/src/helpers/build-revision-context.ts`, and the equivalent issue/PR fetchers in `router/src/github.ts`.

For each stub, write a focused unit test against `RecordingGithub` and a hand-built event payload, then implement. Do not leave the stubs in place — they are placeholders so the file compiles during incremental development.

- [ ] **Step 5: Run all tests**

```bash
pnpm test
```

Expected: orchestrator tests pass alongside Plan 1 and Plan 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts src/runners.ts test/orchestrator.test.ts test/_harness/ test/e2e/fixtures/
git commit -m "feat(orchestrator): route events through state machine, run stages, apply effects"
```

---

## Task 2: Action entry point

**Files:**
- Create: `src/entry.ts`
- Modify: `src/github/app-token.ts` (implement `resolveInstallationId`)
- Create: `test/entry.test.ts`
- Read for reference: spec §3 "Bootstrap"

- [ ] **Step 1: Implement `resolveInstallationId` in `src/github/app-token.ts`**

In GitHub Actions, the cleanest path is to let the workflow mint the installation token via `actions/create-github-app-token` and pass it in as an input. v2 should do the same. Revisit `app-token.ts` to support two modes:

```ts
export type AppTokenInput =
  | { mode: "preminted"; token: string }
  | { mode: "mint"; clientId: string; privateKey: string; owner: string; repo: string };

export async function resolveAppToken(input: AppTokenInput): Promise<string> {
  if (input.mode === "preminted") return input.token;
  return mintInstallationToken({
    clientId: input.clientId,
    privateKey: input.privateKey,
    owner: input.owner,
    repo: input.repo,
  });
}
```

Add a unit test for the preminted branch. The mint branch is exercised by Plan 1's existing tests.

Commit:

```bash
git add src/github/app-token.ts test/github/app-token.test.ts
git commit -m "feat(github): accept preminted App tokens from the workflow"
```

- [ ] **Step 2: Write `test/entry.test.ts`**

The entry test wires `entry.ts` against the harness from Task 1 plus mocked `@actions/core` inputs.

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("@actions/core", async (orig) => {
  const real = (await orig()) as typeof core;
  return { ...real, getInput: vi.fn(), setFailed: vi.fn(), info: vi.fn(), warning: vi.fn() };
});

import { runEntry } from "../src/entry.js";

describe("entry", () => {
  let tmpEventPath: string;
  let summaryPath: string;

  beforeEach(() => {
    tmpEventPath = path.join(os.tmpdir(), `event-${Date.now()}.json`);
    summaryPath = path.join(os.tmpdir(), `summary-${Date.now()}.md`);
    fs.writeFileSync(tmpEventPath, JSON.stringify({ action: "opened", issue: { number: 7, title: "feat", body: "", labels: [] } }));
    fs.writeFileSync(summaryPath, "");
    process.env.GITHUB_EVENT_PATH = tmpEventPath;
    process.env.GITHUB_EVENT_NAME = "issues";
    process.env.GITHUB_REPOSITORY = "octo/demo";
    process.env.GITHUB_RUN_ID = "9001";
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
  });

  afterEach(() => {
    fs.rmSync(tmpEventPath, { force: true });
    fs.rmSync(summaryPath, { force: true });
  });

  it("parses inputs, builds context, and invokes the orchestrator with stage 'none' for an empty-labels issue", async () => {
    (core.getInput as any).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        anthropic_api_key: "sk-test",
        shopfloor_github_app_client_id: "Iv23x",
        shopfloor_github_app_private_key: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
        github_app_token: "ghs_premintedtoken",
        trigger_label: "shopfloor",
      };
      return inputs[name] ?? "";
    });

    await runEntry({ now: () => new Date("2026-05-14T00:00:00Z") });
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run, expect failure**

```bash
pnpm test test/entry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/entry.ts`**

```ts
import * as core from "@actions/core";
import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { parseConfig } from "./config/inputs.js";
import { resolveAppToken } from "./github/app-token.js";
import { GitHubAdapter } from "./github/adapter.js";
import { ClaudeAgentAdapter } from "./agents/claude.js";
import { createAuditEmitter } from "./audit/events.js";
import { createStepSummaryMirror } from "./audit/step-summary.js";
import { runOrchestrator } from "./orchestrator.js";

export interface RunEntryDeps {
  now?: () => Date;
}

export async function runEntry(deps: RunEntryDeps = {}): Promise<void> {
  try {
    const rawInputs = readActionInputs();
    const config = parseConfig(rawInputs);

    const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
    if (!owner || !repo) throw new Error("GITHUB_REPOSITORY not set");

    const eventName = process.env.GITHUB_EVENT_NAME ?? "";
    const eventPayload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "/dev/null", "utf8"));
    const event = { name: eventName, payload: eventPayload };

    const primaryToken = await resolveAppToken(
      rawInputs.github_app_token
        ? { mode: "preminted", token: rawInputs.github_app_token }
        : { mode: "mint", clientId: config.githubApp.clientId, privateKey: config.githubApp.privateKey, owner, repo },
    );
    const reviewToken = rawInputs.github_app_review_token || config.reviewGithubApp
      ? await resolveAppToken(
          rawInputs.github_app_review_token
            ? { mode: "preminted", token: rawInputs.github_app_review_token }
            : { mode: "mint", clientId: config.reviewGithubApp!.clientId, privateKey: config.reviewGithubApp!.privateKey, owner, repo },
        )
      : null;

    const github = new GitHubAdapter({ octokit: new Octokit({ auth: primaryToken }), owner, repo });
    const reviewGithub = reviewToken ? new GitHubAdapter({ octokit: new Octokit({ auth: reviewToken }), owner, repo }) : null;

    const runId = process.env.GITHUB_RUN_ID ?? `local-${(deps.now ?? (() => new Date()))().toISOString()}`;
    const jsonl = createAuditEmitter({ runId });
    const summary = createStepSummaryMirror();
    const audit = (e: any) => { jsonl(e); summary(e); };

    await runOrchestrator({
      event,
      repo: { owner, name: repo },
      github,
      reviewGithub,
      agent: new ClaudeAgentAdapter(),
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
  const keys = [
    "anthropic_api_key", "claude_code_oauth_token",
    "shopfloor_github_app_client_id", "shopfloor_github_app_private_key",
    "shopfloor_github_app_review_client_id", "shopfloor_github_app_review_private_key",
    "github_app_token", "github_app_review_token",
    "ssh_signing_key", "trigger_label", "max_review_iterations",
    "triage_model", "spec_model", "plan_model", "impl_model",
    "review_compliance_model", "review_bugs_model", "review_security_model", "review_smells_model",
    "triage_max_budget_usd", "spec_max_budget_usd", "plan_max_budget_usd", "impl_max_budget_usd", "review_max_budget_usd_per_lens",
    "triage_timeout_ms", "spec_timeout_ms", "plan_timeout_ms", "impl_timeout_ms", "review_timeout_ms_per_lens",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = core.getInput(k) ?? "";
  return out;
}

// CLI entry — invoked when bundled to dist/index.cjs
if (process.env.SHOPFLOOR_INVOKE_ENTRY !== "0") {
  runEntry().catch((err) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

Set `SHOPFLOOR_INVOKE_ENTRY=0` in tests so the import does not auto-run.

- [ ] **Step 5: Run tests, expect pass**

```bash
SHOPFLOOR_INVOKE_ENTRY=0 pnpm test test/entry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/entry.ts test/entry.test.ts
git commit -m "feat(entry): wire action inputs, App tokens, and orchestrator"
```

---

## Task 3: action.yml and sample workflow

**Files:**
- Create: `action.yml`
- Create: `examples/shopfloor.yml`
- Modify: `esbuild.config.mjs` (already in place from Plan 1)
- Modify: `package.json` (add `prepare` or build script if missing)

- [ ] **Step 1: Create `action.yml`**

```yaml
name: Shopfloor
description: Staged, human-gated AI delivery pipeline for GitHub issues and PRs
author: niranjan94
branding:
  icon: git-pull-request
  color: blue

inputs:
  anthropic_api_key:
    description: Anthropic API key. Required unless claude_code_oauth_token is set.
    required: false
    default: ""
  claude_code_oauth_token:
    description: Deprecated. Anthropic terms prohibit OAuth tokens through the Agent SDK in production. Use anthropic_api_key.
    required: false
    default: ""
  shopfloor_github_app_client_id:
    description: GitHub App client id for Shopfloor's primary App (mutations).
    required: true
  shopfloor_github_app_private_key:
    description: GitHub App private key (PEM) for Shopfloor's primary App.
    required: true
  shopfloor_github_app_review_client_id:
    description: GitHub App client id for Shopfloor's review App (optional).
    required: false
    default: ""
  shopfloor_github_app_review_private_key:
    description: GitHub App private key (PEM) for Shopfloor's review App (optional).
    required: false
    default: ""
  github_app_token:
    description: Preminted primary App installation token. If set, skips JWT minting.
    required: false
    default: ""
  github_app_review_token:
    description: Preminted review App installation token. If set, skips JWT minting.
    required: false
    default: ""
  trigger_label:
    description: If set, only issues with this label enter the pipeline.
    required: false
    default: ""
  max_review_iterations:
    description: Maximum review revision loops before bailing out.
    required: false
    default: "3"
  triage_model:
    description: Model id for the triage stage.
    required: false
    default: "claude-haiku"
  spec_model: { required: false, default: "claude-opus", description: "Model id for the spec stage." }
  plan_model: { required: false, default: "claude-opus", description: "Model id for the plan stage." }
  impl_model: { required: false, default: "claude-opus", description: "Model id for the implement stage." }
  review_compliance_model: { required: false, default: "claude-opus", description: "Model id for the compliance review lens." }
  review_bugs_model: { required: false, default: "claude-opus", description: "Model id for the bugs review lens." }
  review_security_model: { required: false, default: "claude-opus", description: "Model id for the security review lens." }
  review_smells_model: { required: false, default: "claude-opus", description: "Model id for the smells review lens." }
  triage_max_budget_usd: { required: false, default: "0.25", description: "USD budget cap for the triage stage." }
  spec_max_budget_usd: { required: false, default: "1.50", description: "USD budget cap for the spec stage." }
  plan_max_budget_usd: { required: false, default: "1.50", description: "USD budget cap for the plan stage." }
  impl_max_budget_usd: { required: false, default: "2.50", description: "USD budget cap for the implement stage." }
  review_max_budget_usd_per_lens: { required: false, default: "0.75", description: "USD budget cap per review lens." }
  triage_timeout_ms: { required: false, default: "300000", description: "Wall-clock timeout for the triage stage." }
  spec_timeout_ms: { required: false, default: "1200000", description: "Wall-clock timeout for the spec stage." }
  plan_timeout_ms: { required: false, default: "1200000", description: "Wall-clock timeout for the plan stage." }
  impl_timeout_ms: { required: false, default: "3600000", description: "Wall-clock timeout for the implement stage." }
  review_timeout_ms_per_lens: { required: false, default: "900000", description: "Wall-clock timeout per review lens." }
  ssh_signing_key:
    description: Optional SSH signing key for commits.
    required: false
    default: ""

runs:
  using: node24
  main: dist/index.cjs
```

- [ ] **Step 2: Create `examples/shopfloor.yml`**

```yaml
name: Shopfloor

on:
  issues:
    types: [opened, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, ready_for_review, closed, labeled, unlabeled]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  issues: read
  pull-requests: read
  # id-token: write   # add only if you wire OIDC downstream; Shopfloor itself doesn't need it

jobs:
  shopfloor:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Mint Shopfloor App token
        id: app_token
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.SHOPFLOOR_APP_ID }}
          private-key: ${{ secrets.SHOPFLOOR_APP_KEY }}

      - name: Mint Shopfloor review App token (optional)
        id: review_app_token
        if: ${{ secrets.SHOPFLOOR_REVIEW_APP_ID != '' }}
        uses: actions/create-github-app-token@v3
        with:
          app-id: ${{ secrets.SHOPFLOOR_REVIEW_APP_ID }}
          private-key: ${{ secrets.SHOPFLOOR_REVIEW_APP_KEY }}

      - name: Run Shopfloor
        uses: niranjan94/shopfloor@v2
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          shopfloor_github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          shopfloor_github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}
          github_app_token: ${{ steps.app_token.outputs.token }}
          shopfloor_github_app_review_client_id: ${{ secrets.SHOPFLOOR_REVIEW_APP_ID }}
          shopfloor_github_app_review_private_key: ${{ secrets.SHOPFLOOR_REVIEW_APP_KEY }}
          github_app_review_token: ${{ steps.review_app_token.outputs.token }}
          trigger_label: shopfloor
```

- [ ] **Step 3: Build the bundle**

```bash
pnpm build
```

Expected: `dist/index.cjs` created. Inspect with `head -c 400 dist/index.cjs` to confirm a sane shebang-free CJS bundle.

If the build fails because of dynamic imports or missing dependencies, debug `esbuild.config.mjs` and `package.json` "dependencies" vs "devDependencies" placement. Anything imported by `src/entry.ts` (transitively) must be in `dependencies`.

- [ ] **Step 4: Verify the bundle runs and immediately fails for missing inputs**

```bash
GITHUB_EVENT_NAME=workflow_dispatch \
GITHUB_REPOSITORY=octo/demo \
GITHUB_RUN_ID=test \
GITHUB_EVENT_PATH=/dev/null \
node dist/index.cjs 2>&1 | head -20
```

Expected: an error about missing required inputs (the App client id / private key). The bundle should not crash at module-load time.

- [ ] **Step 5: Commit the bundle and the action shell**

```bash
git add action.yml examples/shopfloor.yml dist/index.cjs
git commit -m "feat(action): add action.yml, sample workflow, committed dist"
```

The committed `dist/index.cjs` is part of the action contract. Plan 3's cutover task tags `v2.0.0` from this state.

---

## Task 4: E2E test suite

**Files:**
- Create: `test/e2e/triage.test.ts`, `test/e2e/review.test.ts`, `test/e2e/implement.test.ts`, `test/e2e/plan.test.ts`, `test/e2e/spec.test.ts`
- Copy: every event fixture from `router/test/fixtures/events/` into `test/e2e/fixtures/`

The e2e tests drive `runOrchestrator` end-to-end with `FakeAgent` and `RecordingGithub`. They are the contract tests: any change to state-machine semantics, label flows, or PR-metadata that breaks one of these breaks a v1 user.

- [ ] **Step 1: Inventory v1 event fixtures**

```bash
ls router/test/fixtures/events/
```

Group them by what state-machine path they exercise. Each group becomes one e2e test file.

- [ ] **Step 2: Port one e2e test per major state-machine branch**

For each branch of `resolveStage`, write a test that:
1. Loads the fixture event.
2. Constructs `FakeAgent` with the canned decision the stage would emit.
3. Runs `runOrchestrator`.
4. Asserts the final `RecordingGithub.calls` ledger and the audit-event sequence.

Reuse the harness and assertion patterns from `test/orchestrator.test.ts`.

- [ ] **Step 3: Run the full e2e suite**

```bash
pnpm test test/e2e/
```

Expected: PASS. Failures here are either (a) state-machine port regressions (fix the port, not the test) or (b) stage runner/apply regressions (fix the stage, not the test).

- [ ] **Step 4: Commit**

```bash
git add test/e2e/ src/
git commit -m "test(e2e): black-box orchestrator runs against v1 fixture events"
```

---

## Task 5: Manual smoke test

This task is not automated. It validates the action in a real repo before cutover.

- [ ] **Step 1: Create a throwaway test repo** under your GitHub account (e.g. `shopfloor-smoke`).

- [ ] **Step 2: Install both Shopfloor GitHub Apps** on the smoke repo, with the documented permissions (Issues: RW, Pull requests: RW, Contents: RW).

- [ ] **Step 3: Add `.github/workflows/shopfloor.yml` to the smoke repo**, copying `examples/shopfloor.yml` and pinning `uses:` to the current commit on the `v2` branch:

```yaml
uses: niranjan94/shopfloor@<sha-of-v2-tip>
```

- [ ] **Step 4: Open an issue with the trigger label and a body that warrants `large` complexity** (e.g. "add a search bar with filters and pagination").

- [ ] **Step 5: Walk through every stage manually:**
- triage classifies → `shopfloor:complexity:large` + `shopfloor:needs-spec` applied → spec PR opened
- merge spec PR → `shopfloor:needs-plan` applied → plan PR opened
- merge plan PR → `shopfloor:needs-impl` applied → impl draft PR opened with progress comment
- progress comment updates as the agent works
- impl PR un-drafts → review fires → verdict posted by the review App
- approve → merge → issue closes with `shopfloor:done`

- [ ] **Step 6: Verify the JSONL audit stream** is present in each run log and that `$GITHUB_STEP_SUMMARY` shows the human-readable timeline.

- [ ] **Step 7: Repeat with a `medium` and a `quick` issue** to exercise the other complexity paths.

- [ ] **Step 8: Record any deviations from v1 behaviour in a short note (`docs/superpowers/notes/2026-05-14-v2-smoke.md`) and fix before proceeding to cutover.**

```bash
git add docs/superpowers/notes/2026-05-14-v2-smoke.md
git commit -m "docs(v2): record smoke test results"
```

---

## Task 6: README and migration docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the README's install/usage section**

Replace any "reusable workflow" instructions with the v2 action-based install:

```markdown
## Install

Add to your repo's `.github/workflows/shopfloor.yml`:

\`\`\`yaml
- uses: niranjan94/shopfloor@v2
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    shopfloor_github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
    shopfloor_github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}
\`\`\`

The full sample workflow lives in [`examples/shopfloor.yml`](examples/shopfloor.yml).

## Migrating from v1

v1 (the reusable workflow at `niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1`) is replaced by v2, a regular GitHub Action.

1. Delete the `uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1` line from your workflow.
2. Copy [`examples/shopfloor.yml`](examples/shopfloor.yml) into `.github/workflows/shopfloor.yml`.
3. The label vocabulary, PR conventions, and artifact paths are unchanged.

For supply-chain hardening, pin to a specific SHA instead of `@v2`:

\`\`\`yaml
uses: niranjan94/shopfloor@<sha>  # v2.0.0
\`\`\`

v1 remains available at the `@v1` tag for repos that have not migrated.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document v2 install and v1 migration"
```

---

## Task 7: Cutover commit on main

This task happens after all prior tasks across all three plans are merged into `v2` and `v2` is verified by the smoke test.

- [ ] **Step 1: Open a cutover PR from `v2` to `main`**

```bash
git checkout v2
git pull origin v2
gh pr create --base main --head v2 --title "v2.0.0: Single-process orchestrator built on the Agent SDK" \
  --body "$(cat <<'EOF'
## Summary

Reimplements Shopfloor as a single GitHub Action running one Node 24 process per event, backed by the Claude Agent SDK. Preserves all v1 user-facing behavior (labels, PRs, artifacts, metadata). Deletes the reusable workflow, the router action, and the standalone MCP server.

See `docs/superpowers/specs/2026-05-14-shopfloor-v2-design.md` for the design.

## Test plan

- [ ] All unit tests green (Plans 1, 2, 3 tasks).
- [ ] Orchestrator e2e tests green against v1 event fixtures.
- [ ] Manual smoke test recorded in `docs/superpowers/notes/2026-05-14-v2-smoke.md`.

EOF
)"
```

- [ ] **Step 2: After review, delete the v1 surface in a final commit on the `v2` branch before merging**

```bash
git rm -r router/ mcp-servers/ prompts/ .github/workflows/shopfloor.yml pnpm-workspace.yaml
git commit -m "chore(v1): cutover — delete router, mcp-servers, prompts, reusable workflow"
git push origin v2
```

Verify the PR builds, tests still pass on `v2`'s CI, and no caller in the org has unmigrated workflows. If any v1 consumers exist, coordinate the migration before merge.

- [ ] **Step 3: Merge the cutover PR**

Use a merge commit (not squash) so the v2 history is preserved.

```bash
gh pr merge --merge <pr-number>
```

- [ ] **Step 4: Tag `v2.0.0`**

```bash
git checkout main
git pull origin main
git tag -a v2.0.0 -m "Shopfloor v2.0.0"
git push origin v2.0.0
```

- [ ] **Step 5: Move the `v2` floating major tag**

```bash
git tag -f v2 v2.0.0
git push origin v2 --force
```

The `--force` here is acceptable: floating major tags are explicitly meant to be moved across releases. Document in the release notes that consumers tracking `@v2` will pull this.

- [ ] **Step 6: Create the GitHub release**

```bash
gh release create v2.0.0 --title "v2.0.0" --notes "$(cat <<'EOF'
Shopfloor v2 — single-process orchestrator built on the Claude Agent SDK.

UX-compatible with v1: same labels, same stage PRs, same artifact paths, same PR metadata.

Internals rewritten: one Node 24 process per event, in-process MCP tools, structured-output decisions, structured JSONL audit.

See `docs/superpowers/specs/2026-05-14-shopfloor-v2-design.md` for the full design.
EOF
)"
```

- [ ] **Step 7: Confirm consumers tracking `@v2` pick up the new release**

Wait for the smoke repo's next workflow run after the tag move. Verify the run uses the new bundle. If the smoke repo had pinned to a SHA, manually bump it once to confirm the action still works from the new tag.

---

## Self-review checklist (for the agent executing this plan)

- [ ] `action.yml` has `name`, `description`, `branding`, and `runs.using: node24`. No required fields missing.
- [ ] `dist/index.cjs` is committed and runs without crashing on a `node dist/index.cjs` invocation that lacks inputs (it should `setFailed`, not throw).
- [ ] `examples/shopfloor.yml` does not request `id-token: write` unless a downstream consumer needs it.
- [ ] `orchestrator.ts` never returns success when a stage threw; the `finally` block clears the running mutex regardless.
- [ ] `reportFailure` applies `shopfloor:failed:<stage>` and emits `stage_failed` before the orchestrator exits non-zero.
- [ ] No stage code, no orchestrator code, and no entry code references anything under `router/`, `mcp-servers/`, or `prompts/` after the cutover commit lands.
- [ ] The cutover commit is a single commit with a clear message; reviewers can revert it cleanly.
- [ ] The `v2` tag points at the cutover commit and the release notes mention SHA pinning.
- [ ] No remaining `console.log` outside the audit emitter. Use `core.info` / `core.warning` / `core.error` for non-audit output.

After Task 7, v1 is removed from `main`. v2 is the only supported codepath. v1 remains installable via the `@v1` tag for unmigrated callers.
