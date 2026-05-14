# Shopfloor v2 Design

**Status:** Draft, pending review
**Date:** 2026-05-14
**Author:** Brainstormed collaboratively with Claude (Opus 4.7)
**Supersedes:** v1 (everything under `router/`, `mcp-servers/`, `prompts/`, and `.github/workflows/shopfloor.yml`)

## 1. Overview

Shopfloor v2 is an internal reimplementation of Shopfloor that preserves the v1 user-facing contract exactly (same `shopfloor:*` labels, same stage PRs, same human merge gates, same PR metadata convention) while replacing the orchestration substrate.

v1 is structured as a reusable GitHub workflow that fans events out into many jobs and threads state between them via job outputs and labels. The workflow leans on `anthropics/claude-code-action` to talk to Claude, and on a separate MCP subprocess to expose one agent-facing tool. The TypeScript that owns the state machine and helper logic is split across sixteen helper entrypoints behind a `helper` input switch.

v2 collapses that surface into a single GitHub Action backed by one Node 24 process per event. The process owns the state machine, holds the GitHub App tokens, talks to Claude through the official [Claude Agent SDK for TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript.md), and exposes agent tools in-process. The reusable workflow goes away. Consumers add a `uses:` step to a workflow file they own.

The user-visible behaviour does not change. Same labels, same PRs, same comments, same artifacts. Only the inside is rewritten.

### One-sentence pitch

Shopfloor v2 keeps the v1 UX and rewrites the orchestrator as a single Agent-SDK-driven Node process behind a normal GitHub Action, so the workflow YAML shrinks, the state machine moves into testable TypeScript, and a future agent-adapter PR can add non-Claude backends without touching stage code.

## 2. Goals and non-goals

### Goals

- **Exact UX parity with v1.** Every label, PR template, comment, artifact path, and PR-metadata header is identical. Consumers migrate by changing one `uses:` line.
- **Single Node process per event.** The orchestrator runs in one Actions job. No inter-job state passing via outputs. No `helper` input dispatch. No matrix jobs.
- **Claude Agent SDK as the model interface.** Replaces `claude-code-action`. Tools the agent calls (progress updates, decision submission) are defined on the SDK's in-process MCP server (`createSdkMcpServer`), eliminating the separate `mcp-servers/shopfloor-mcp` subprocess. Custom tools in the Agent SDK are always MCP-shaped; only the transport changes.
- **Stage-vertical code layout.** Each stage owns a directory containing its prompt, allowed tools, decision schema, runner, and side-effect applier.
- **AgentAdapter interface on day one, Claude-only implementation.** Stage code talks to `AgentAdapter`, never to the SDK directly. A future Codex or OpenCode adapter is a new file under `agents/`, not a refactor.
- **Concurrent reviewer lenses inside one process.** The four review lenses (compliance, bugs, security, smells) run as `Promise.allSettled` over four SDK sessions in the same process. Each session spawns its own bundled `claude` CLI subprocess; size the runner accordingly (≈4× memory and file-descriptor headroom). The SDK's first-class subagent feature (`Options.agents` + the `Agent` tool with `run_in_background`) was considered and rejected: independent sessions give per-lens budgets, isolated failure modes, and one `SDKResultMessage` stream per lens for audit.
- **Structured audit trail.** A JSONL event stream on stdout plus a Markdown mirror in `$GITHUB_STEP_SUMMARY` replaces the implicit audit trail of "one job log per mutation" that v1 got from fragmented CI jobs.
- **Hard cutover.** v2 ships on a `v2` branch and replaces `router/`, `mcp-servers/`, `prompts/`, and the reusable workflow wholesale. v1 stays installable at the `@v1` tag.
- **Ship as a regular GitHub Action.** `action.yml` at the repo root, Node 24 entry, committed `dist/`. A sample caller workflow lives in `examples/`.

### Non-goals (v2.0)

- **Non-Claude agents at launch.** The AgentAdapter interface exists but only one implementation ships. Adding Codex/OpenCode is a follow-up.
- **Coexistence of v1 and v2 at runtime.** No feature flag, no `engine: v1|v2` toggle. v1 remains usable only via the pinned `@v1` tag.
- **External dashboards, telemetry exporters, or hosted services.** Same as v1.
- **Changes to the GitHub Apps model.** Same primary App for mutations, same optional review App to post reviews under a distinct identity.
- **State machine semantics changes.** Any UX bug that exists in v1 also exists in v2 unless we file a separate spec to fix it.
- **Long-running sessions across events.** Each event spawns a fresh process. No cross-event SDK session resume.
- **A standalone CLI or scaffolding command.** Same as v1.
- **An HTTP webhook receiver, server, or daemon.** v2 runs only inside GitHub Actions.

## 3. High-level architecture

v2 is, physically:

1. **A GitHub Action at the repo root** (`action.yml`, Node 24, entry `dist/index.cjs`). Consumers reference it as `uses: niranjan94/shopfloor@v2`.
2. **A single TypeScript source tree** (`src/`) that builds to `dist/index.cjs` via esbuild. The dist file is committed (standard JS-Action pattern, reproducible from source).
3. **A sample workflow** (`examples/shopfloor.yml`) that consumers copy into their `.github/workflows/`. They own their `on:` triggers and any pre/post setup steps.

The Action runs as a single step inside one job of the consumer's workflow. That job is the entire runtime. There is no other process, no other job, no other workflow file shipped by Shopfloor.

### What happens inside the process

1. **Bootstrap.** `entry.ts` reads action inputs (validated via Zod), parses the GitHub event payload from `GITHUB_EVENT_PATH`, and mints the primary GitHub App installation token. If the review-App credentials are present, it also mints the review-App token. Both go into a `StageContext` that the orchestrator threads through every call.
2. **Route.** `orchestrator.ts` calls `state/machine.ts`'s `resolveStage(event, labels, payload)` (a direct port of v1's `state.ts`). The result is a `RouterDecision` describing which stage to run, or `stage: "none"` for events that warrant no action.
3. **Precheck.** Verifies that the issue's labels have not changed since the event fired (mutex labels, no `shopfloor:failed:*` block) and that we are not racing a duplicate trigger. On precondition failure the process exits 0 with an audit event.
4. **Acquire mutex.** Flips the stage's `shopfloor:<stage>-running` label.
5. **Run the stage.** Loads `stages/<name>/runner.ts`, which composes the stage's prompt, tools, and decision schema, then hands them to `AgentAdapter.runStage(...)`. The Claude implementation drives one SDK session with `outputFormat: { type: 'json_schema', schema: zodToJsonSchema(decisionSchema) }`. The runner consumes the SDK's `AsyncGenerator<SDKMessage>` until the terminal `SDKResultMessage` arrives, then parses `structured_output` through the Zod schema and returns the typed decision payload. Error subtypes on the terminal message (`error_max_budget_usd`, `error_max_turns`, `error_max_structured_output_retries`) become typed `agent_*` errors.
6. **Apply side effects.** `stages/<name>/apply.ts` performs all GitHub mutations the decision implies: label flips, PR opens/updates, comments, artifact commits. All mutations go through `GitHubAdapter` (and for the review stage, `reviewGithub` adapter).
7. **Release mutex** in `finally`. Emits a terminal audit event. Exits.

The review stage is a thin wrapper around `Promise.all` over four lens runners; each lens is itself a mini-stage with its own prompt, model, and budget. Findings are aggregated locally (no extra agent call) into a single APPROVE or REQUEST_CHANGES verdict that the review-App adapter posts on the implementation PR.

### What was eliminated relative to v1

- The reusable workflow `.github/workflows/shopfloor.yml`.
- The `helper` input dispatch in `router/src/index.ts` (16 cases).
- All per-helper Actions jobs (advance-state, open-stage-pr, report-failure, handle-merge, create-progress-comment, finalize-progress-comment, check-review-skip, aggregate-review, render-prompt, apply-triage-decision, apply-impl-postwork, apply-review-revision, precheck-stage, build-revision-context, bootstrap-labels).
- The `mcp-servers/shopfloor-mcp/` package and its subprocess lifetime.
- The `prompts/` package (prompts move next to the stage code that uses them).
- All job-output plumbing between jobs.
- The dependency on `anthropics/claude-code-action`.

### What was kept relative to v1

- The state machine semantics (`resolveStage`, `parsePrMetadata`, `parseIssueMetadata`, `parseStageBranchRef`, complexity flows, label vocabulary, mutex labels, retry-on-unlabel contract).
- The two-App pattern (primary App authors PRs and flips labels; optional review App posts the aggregated review under a distinct identity).
- The PR metadata convention (`Shopfloor-Issue`, `Shopfloor-Stage`, `Shopfloor-Review-Iteration`).
- The issue-body metadata block (`<!-- shopfloor:metadata ... -->`).
- The artifact paths under `docs/shopfloor/specs/` and `docs/shopfloor/plans/`.
- The four review lenses and their parallel execution.
- All prompts (content unchanged; instructions to "emit JSON in this format" are replaced by "call the `submit_decision` tool", but the underlying decision schema is identical).
- vitest, the fixtures under `router/test/fixtures/`, and the mock-adapter testing pattern.

## 4. Repository layout

```
shopfloor/
├── action.yml                    # Node 24 action, entry: dist/index.cjs
├── examples/
│   └── shopfloor.yml             # Sample workflow consumers copy in
├── src/
│   ├── entry.ts                  # Action entrypoint; parses inputs, builds StageContext, hands to orchestrator
│   ├── orchestrator.ts           # The top-level "one process per event" coordinator
│   ├── state/
│   │   ├── machine.ts            # Ported state.ts (resolveStage and friends)
│   │   ├── labels.ts             # All shopfloor:* label constants
│   │   └── metadata.ts           # PR-metadata and issue-metadata block parsing
│   ├── stages/
│   │   ├── triage/
│   │   │   ├── prompt.md
│   │   │   ├── tools.ts          # SDK tools this stage may call
│   │   │   ├── decision.ts       # Zod schema for the triage decision
│   │   │   ├── runner.ts         # Composes prompt+tools+adapter, returns Decision
│   │   │   └── apply.ts          # Side effects on decision (label flips, seed metadata)
│   │   ├── spec/
│   │   ├── plan/
│   │   ├── implement/
│   │   └── review/
│   │       ├── lenses/
│   │       │   ├── compliance/
│   │       │   ├── bugs/
│   │       │   ├── security/
│   │       │   └── smells/
│   │       ├── aggregate.ts      # Promise.all over lenses, merge findings into a verdict
│   │       └── apply.ts          # Post APPROVE/REQUEST_CHANGES via reviewGithub adapter
│   ├── agents/
│   │   ├── adapter.ts            # AgentAdapter interface and shared types
│   │   └── claude.ts             # Agent SDK implementation
│   ├── github/
│   │   ├── adapter.ts            # GitHubAdapter (ported, slimmed)
│   │   ├── app-token.ts          # JWT mint + installation token cache
│   │   └── pr-metadata.ts        # Read/write the Shopfloor-Issue/Shopfloor-Stage block
│   ├── tools/
│   │   ├── update-progress.ts    # The one tool the deleted MCP server exposed
│   │   ├── submit-decision.ts    # Typed "stage emits decision" SDK tool factory
│   │   └── ...                   # Other shared agent-facing tools
│   ├── audit/
│   │   ├── events.ts             # JSONL event types + emitter
│   │   └── step-summary.ts       # Mirrors selected events into $GITHUB_STEP_SUMMARY
│   └── config/
│       └── inputs.ts             # Parse + validate action inputs (Zod)
├── test/
│   ├── state/                    # Ported router/test/state.test.ts and friends
│   ├── stages/                   # Per-stage runner tests with MockAgentAdapter
│   ├── e2e/                      # Black-box orchestrator runs against fixture events
│   └── fixtures/                 # Recorded GitHub event payloads (ported from v1)
└── dist/
    └── index.cjs                 # esbuild output, committed
```

The workspace becomes a single package (no `pnpm-workspace.yaml`).

## 5. Stage anatomy

Every stage is the same five files: `prompt.md`, `tools.ts`, `decision.ts`, `runner.ts`, `apply.ts`. Predictability beats cleverness.

### Decision schema

```ts
// stages/triage/decision.ts
import { z } from "zod";

export const TriageDecision = z.object({
  complexity: z.enum(["quick", "medium", "large"]),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  rationale: z.string(),
});
export type TriageDecision = z.infer<typeof TriageDecision>;
```

The decision schema is the contract between the agent and the orchestrator. The `submit_decision` SDK tool takes an argument matching this schema. The SDK rejects malformed payloads before the runner returns; v1's brittle JSON-in-prose parsing goes away.

### Tools

```ts
// stages/triage/tools.ts
export function triageTools(ctx: StageContext): SdkTool[] {
  return [
    updateProgressTool(ctx),
    // No GitHub-mutation tools. Triage is read-only.
  ];
}
```

Tool factories return values from `tool(name, description, zodShape, handler)`, and the Claude adapter bundles a stage's tools into a single `createSdkMcpServer({ name: 'shopfloor', tools: [...] })` passed to `query()` via `options.mcpServers`. The agent addresses them as `mcp__shopfloor__<tool_name>` and they are surfaced through `options.allowedTools`.

Tool lists are stage-scoped. Triage cannot push branches. Spec and plan cannot push code. Only the implementation stage gets the full mutation surface, and even that surface is mediated by the SDK tool definitions (no raw shell escape).

The decision payload is not a tool. It is the agent's final structured output, enforced by `outputFormat: { type: 'json_schema' }` and read off the terminal `SDKResultMessage`. This avoids the host having to intercept a specific tool call to end the session.

### Runner

```ts
// stages/triage/runner.ts
export async function runTriage(ctx: StageContext): Promise<TriageDecision> {
  return ctx.agent.runStage({
    systemPrompt: triageSystemPrompt,                     // stage-wide instructions
    userPrompt: renderUserPrompt(triagePromptUser, ctx),  // event-specific context
    tools: triageTools(ctx),
    decisionSchema: TriageDecision,
    model: ctx.config.triageModel,
    budgetUsd: ctx.config.triageMaxBudgetUsd,
    timeoutMs: ctx.config.triageTimeoutMs,
  });
}
```

The runner is a pure composition: render the prompts, list the tools, name the schema, name the budget, hand to the adapter. Stage-wide instructions ("you are the triage agent…") go in `systemPrompt`; per-event context (issue body, labels, prior comments) goes in `userPrompt`. The adapter threads them into `options.systemPrompt` and `query({ prompt })` respectively.

### Apply

```ts
// stages/triage/apply.ts
export async function applyTriage(ctx: StageContext, decision: TriageDecision) {
  await ctx.github.upsertIssueMetadata(ctx.issue.number, { slug: decision.slug });
  await ctx.github.replaceLabels(ctx.issue.number, {
    add: [complexityLabel(decision.complexity)],
    remove: ["shopfloor:triaging"],
  });
  ctx.audit.emit({ type: "stage_decided", stage: "triage", decision });
}
```

`apply<Stage>` is the only place a stage performs GitHub mutations. The runner is pure (decision in, decision out). This separation is what makes the stage testable without network or model.

## 6. AgentAdapter contract

```ts
// agents/adapter.ts
export interface AgentAdapter {
  runStage<T>(args: {
    systemPrompt: string;
    userPrompt: string;
    tools: SdkTool[];
    decisionSchema: z.ZodType<T>;
    model: string;
    budgetUsd?: number;        // → options.maxBudgetUsd; overrun surfaces as error_max_budget_usd
    timeoutMs?: number;        // adapter wraps AbortController + setTimeout
    abortController?: AbortController;
  }): Promise<T>;
}
```

The interface is deliberately small. Everything the orchestrator needs from a model backend fits in one method.

The Claude implementation in `agents/claude.ts`:

- Builds the stage's tools into a single in-process MCP server via `createSdkMcpServer` and passes it through `options.mcpServers`.
- Maps `model` to `options.model`, `budgetUsd` to `options.maxBudgetUsd`, `systemPrompt` to `options.systemPrompt` (custom string), and `userPrompt` to the `prompt` argument of `query()`.
- Translates `decisionSchema` (a Zod type) into JSON Schema and passes it via `options.outputFormat = { type: 'json_schema', schema: ... }`.
- Wraps `timeoutMs` into an `AbortController` (`setTimeout(() => controller.abort(), timeoutMs)`) and passes it as `options.abortController` (the SDK takes a controller, not a free signal).
- Consumes `query()`'s `AsyncGenerator<SDKMessage>` until a terminal `SDKResultMessage`. On `subtype: 'success'`, parses `structured_output` against the Zod schema and resolves. On `error_max_budget_usd`, `error_max_turns`, `error_max_structured_output_retries`, or `error_during_execution`, rejects with the corresponding typed `ErrorKind` (see §9).

A hypothetical `agents/codex.ts` would implement the same `runStage` against whatever shape Codex CLI/SDK exposes; stage code would not change.

Stage code imports only from `agents/adapter.ts`. Importing `@anthropic-ai/claude-agent-sdk` outside `agents/claude.ts` is a lint violation enforced in CI.

`StageContext` carries: `event` (the parsed GitHub event), `repo` (`{ owner, name }`), `issue` (resolved issue if relevant), `pr` (resolved PR if relevant), `github` (primary GitHubAdapter), `reviewGithub` (review-App GitHubAdapter, only handed to the review stage), `agent` (AgentAdapter), `config` (validated inputs), `audit` (event emitter), and a `runId` for correlation in the JSONL trail.

## 7. Data flow and the state machine

```
GitHub event (issues, issue_comment, pull_request, pull_request_review, etc.)
  │
  ▼
GitHub Action step runs `node dist/index.cjs`
  │
entry.ts ── parses inputs, mints App tokens, parses event payload, builds StageContext
  │
orchestrator.ts ── state.machine.resolveStage(event, labels, payload)
  │                  → RouterDecision { stage, reason, issueNumber, branchName, ... }
  │
  ├─ stage === "none"           → emit audit event, exit 0
  │
  └─ stage === "<name>"
       │
       ├─ precheck(ctx)         → bails with audit event on precondition failure
       ├─ acquireRunningLabel() → flips shopfloor:<stage>-running
       │
       ├─ runners[stage](ctx)   → one AgentAdapter.runStage call; returns typed decision OR throws
       │      │
       │      ├─ success → apply[stage](ctx, decision)
       │      └─ failure → reportFailure(ctx, err) (typed ErrorKind)
       │
       └─ releaseRunningLabel() in finally
```

`resolveStage` is a direct port of `router/src/state.ts`. Same inputs, same outputs, same snapshot-tested behaviour. v1 already has 95%+ line coverage on it; porting the tests verbatim is the first verification step.

The 16-helper `helper` input switch collapses. There is no dispatch. The orchestrator selects the stage runner from the stage name returned by `resolveStage`.

`handle-merge` (v1's post-merge label-advancement helper) becomes a branch inside the orchestrator: when `resolveStage` returns `{ stage: "none", postMergeAction: "advance" }`, the orchestrator flips the next-stage label inline. No separate job.

`aggregate-review` (v1's matrix rendezvous job) becomes `stages/review/aggregate.ts`, called after `Promise.all` over the four lens runners. Findings merge locally; the verdict is posted via the review-App adapter.

### Reviewer fan-out

```ts
const findings = await Promise.all(
  REVIEW_LENSES.map(lens =>
    runReviewLens({ ...ctx, lens })
  )
);
const verdict = aggregateFindings(findings);   // APPROVE or REQUEST_CHANGES + summary
await applyReview(ctx, verdict);
```

Each lens runs against its own fresh SDK session, with its own model and budget (configurable per lens via action inputs). All four sessions share the GitHubAdapter and the audit stream. Aggregation is plain TypeScript: no fifth agent call to merge findings.

### Decision payloads replace JSON-in-prose

v1's triage prompt instructs the agent to print a JSON block at the end of its response; a regex-y helper parses it. v2 uses the SDK's `outputFormat: { type: 'json_schema', schema: <decisionSchema> }` and reads `SDKResultMessage.structured_output`. The SDK enforces the schema and retries on validation failure up to a documented cap; the orchestrator never sees malformed output. If the cap is exhausted, the terminal result carries `subtype: 'error_max_structured_output_retries'` which the adapter maps to `agent_invalid_output`.

## 8. Audit and observability

A single `audit.emit(event)` call writes one line of JSONL to stdout. Every event carries a `ts` and a `runId` (the GitHub Actions run id plus a per-stage UUID).

```ts
type AuditEvent =
  | { type: "stage_resolved"; stage: Stage | "none"; reason: string; issueNumber?: number }
  | { type: "precheck_failed"; stage: Stage; reason: string }
  | { type: "stage_started"; stage: Stage; model: string; runId: string }
  | { type: "agent_tool_call"; stage: Stage; tool: string; argsPreview: string }
  | { type: "stage_decided"; stage: Stage; decision: unknown; tokensUsed: number; costUsd: number }
  | { type: "label_applied"; issueNumber: number; add: string[]; remove: string[] }
  | { type: "pr_opened"; stage: Stage; prNumber: number }
  | { type: "review_posted"; prNumber: number; verdict: "approve" | "request_changes"; iteration: number }
  | { type: "stage_failed"; stage: Stage; error: { message: string; kind: ErrorKind } }
  | { type: "budget_exceeded"; stage: Stage; spentUsd: number; capUsd: number };
```

The JSONL stream lives in the Actions run log. A curated subset (stage transitions, label flips, decisions, failures) is rendered as a Markdown table into `$GITHUB_STEP_SUMMARY` so the run page tells a human-readable story without anyone having to grep logs.

This replaces v1's implicit audit trail of "one job log per mutation" with an explicit, structured, queryable stream. The trade is honest: v1 gave each mutation a discrete CI step you could click on; v2 gives a unified log you can pipe into anything that consumes JSONL.

## 9. Error handling

Errors are typed.

| `ErrorKind`             | SDK terminal subtype (where applicable)            | Source                                                                | Action taken                                                          |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `agent_timeout`         | (host-side `AbortController` fires)                | Adapter's wall-clock timer aborted the session                        | `shopfloor:failed:<stage>`, retry on unlabel (v1 contract)            |
| `agent_budget`          | `error_max_budget_usd`                             | SDK terminated session on `maxBudgetUsd` overrun                      | `shopfloor:failed:<stage>`, comment with spend report                 |
| `agent_max_turns`       | `error_max_turns`                                  | SDK hit the configured turn cap before producing structured output    | `shopfloor:failed:<stage>`, comment with last assistant snippet       |
| `agent_invalid_output`  | `error_max_structured_output_retries`              | SDK exhausted its schema-retry budget                                 | `shopfloor:failed:<stage>`, comment with last raw output snippet      |
| `agent_execution`       | `error_during_execution`                           | SDK raised an unexpected internal error mid-session                   | `shopfloor:failed:<stage>` with subtype, retry on unlabel             |
| `github_403`            | n/a                                                | GitHubAdapter call rejected                                           | Retry once after token refresh; on second fail, fail the run          |
| `github_409`            | n/a                                                | Label race or PR conflict                                             | Re-fetch state, recompute decision, retry the apply step              |
| `precondition`          | n/a                                                | Precheck found wrong labels or mutex                                  | Exit 0, no failure label (this is a normal duplicate-event case)      |
| `internal`              | n/a                                                | Unexpected throw in orchestrator code                                 | `shopfloor:failed:<stage>` with stack, exit 1                         |

`reportFailure(ctx, err)` is the single funnel: tag the issue, clear the running-mutex label, post a comment with the kind plus message plus run URL, emit `stage_failed`. Stages do not call `reportFailure` themselves; they throw a typed error and the orchestrator's `finally` block calls it.

The state machine already encodes the retry contract: removing `shopfloor:failed:<stage>` re-fires the stage. v2 honours this unchanged. The only automatic retries inside one run are the `github_409` re-fetch and the one-shot `github_403` token refresh.

Per-stage budgets come from action inputs (`triage_max_budget_usd`, `impl_max_budget_usd`, `review_<lens>_max_budget_usd`, etc., names preserved from v1). The Claude adapter passes `budgetUsd` to the SDK and aborts on overrun. Lens budgets are independent; the orchestrator does not pool them.

**Review-lens failure isolation.** `Promise.all` is replaced in practice by `Promise.allSettled` over the four lenses. A single lens failure does not abort the others. Aggregation treats a failed lens as a `REQUEST_CHANGES` finding with kind `lens_failed` plus the error, so the verdict still posts and the human reviewer sees which lens broke. If all four lenses fail, the stage itself fails with `internal` and the standard retry contract applies.

## 10. Testing strategy

**Tier 1 — State machine (unit).** `test/state/` ports `router/test/state.test.ts` and its fixtures verbatim. Same snapshots, same coverage targets. If these pass, the externally visible decision logic is unchanged.

**Tier 2 — Stages (unit, with a mock AgentAdapter).** Each `stages/<name>/runner.ts` is tested by injecting a `MockAgentAdapter` that returns canned decisions or throws canned errors. `MockGitHubAdapter` records calls for assertions. Audit-event ordering is part of the assertions. Fast, hermetic, no network, no real SDK.

**Tier 3 — Orchestrator e2e (black-box).** `test/e2e/` drives `orchestrator.ts` with recorded GitHub event payloads (the same fixtures v1 already uses) and a fake `AgentAdapter` that pattern-matches the prompt to return a fixture decision. Assertions cover the final GitHubAdapter call ledger and the JSONL audit stream. One test per branch of `resolveStage`. No real network, no real SDK.

**Live Claude adapter tests.** A handful of cases gated behind `ANTHROPIC_API_KEY` and an opt-in script (`pnpm test:live`). Exercises the SDK integration. Not run on every PR.

**Coverage targets.** State machine ≥ 95% line. Stage runners ≥ 90% line. Orchestrator e2e covers every branch of `resolveStage`. Matches v1's actuals; no regression.

**Fixtures.** `router/test/fixtures/` moves wholesale to `test/fixtures/`.

## 11. Configuration and inputs

v2 preserves every action input v1 exposes that still applies. Inputs are validated with Zod in `src/config/inputs.ts` and a typed `Config` is threaded through `StageContext`.

Inputs that change name or shape:

- `helper` (v1): removed. No dispatch surface.
- `github_token` (v1): preserved as the read-scope token for the orchestrator. Mutation calls always use App tokens minted in `entry.ts`.
- `claude_args` (v1, pass-through to claude-code-action): removed. Per-stage knobs (`<stage>_model`, `<stage>_max_budget_usd`, `<stage>_timeout_ms`, `<stage>_effort`) are first-class action inputs.
- `output_schema` (new): not in v2.0. Stage decision schemas are internal. If the standalone-action use case from pullfrog is interesting later, this can come back.

Inputs that stay identical: `anthropic_api_key`, `claude_code_oauth_token`, `shopfloor_github_app_client_id`, `shopfloor_github_app_private_key`, `shopfloor_github_app_review_client_id`, `shopfloor_github_app_review_private_key`, `ssh_signing_key`, `trigger_label`, `max_review_iterations`, complexity model overrides, per-stage timeouts and budgets, runner labels, custom setup hooks.

`claude_code_oauth_token` is retained for v1 parity but **deprecated** in v2. Anthropic's Consumer Terms prohibit using Free/Pro/Max OAuth tokens through the Agent SDK in production (see [code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)). The recommended auth path is `anthropic_api_key`; Bedrock, Vertex, and Foundry are supported via the SDK's `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1` / `CLAUDE_CODE_USE_FOUNDRY=1` env-var switches, which the action forwards through if set.

The `action.yml` carries the GitHub-required top-level fields:

```yaml
name: Shopfloor
description: Staged, human-gated AI delivery pipeline for GitHub issues and PRs
author: niranjan94
branding:
  icon: git-pull-request
  color: blue
inputs: { ... }
runs:
  using: node24
  main: dist/index.cjs
```

Sample workflow shape (`examples/shopfloor.yml`):

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
  # id-token: write     # add only if you wire OIDC for downstream auth; not required by Shopfloor itself

jobs:
  shopfloor:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: niranjan94/shopfloor@v2
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          shopfloor_github_app_client_id: ${{ secrets.SHOPFLOOR_APP_ID }}
          shopfloor_github_app_private_key: ${{ secrets.SHOPFLOOR_APP_KEY }}
          shopfloor_github_app_review_client_id: ${{ secrets.SHOPFLOOR_REVIEW_APP_ID }}
          shopfloor_github_app_review_private_key: ${{ secrets.SHOPFLOOR_REVIEW_APP_KEY }}
```

Consumers own the trigger list, the runner choice, any pre-step setup (monorepo workspace prep, custom env, secrets gymnastics). v1 could not offer this cleanly because the trigger list was baked into the reusable workflow.

## 12. Cutover plan

Hard cutover. v2 ships on a long-lived `v2` branch; main continues to ship v1 patches during development.

Bottom-up build order on the `v2` branch:

1. State machine port and Tier 1 tests green.
2. `GitHubAdapter` port and tests.
3. `AgentAdapter` interface and `MockAgentAdapter`.
4. `ClaudeAgent` adapter against the SDK, with the live-test gate.
5. One stage end to end (start with **triage** — read-only, simplest decision schema, easiest to validate against fixtures).
6. Then **review** (proves reviewer fan-out), then **implement**, then **plan**, then **spec**.
7. Orchestrator glue last, once all stages are individually green.
8. Action shell (`action.yml`, `entry.ts`, esbuild config, dist commit). Sample workflow in `examples/`.
9. Tier 3 e2e against the full set of fixture events.
10. Manual smoke test in a throwaway repo: open an issue, watch it walk through triage → spec → plan → implement → review. Verify every label flip, every PR, every comment matches v1.

Cutover commit on `main`:

- Delete `router/`, `mcp-servers/`, `prompts/`, `.github/workflows/shopfloor.yml`, `pnpm-workspace.yaml`.
- Add `action.yml`, `src/`, `examples/`, `test/`, `dist/index.cjs`.
- Tag `v2.0.0`.
- Document migration in `README.md`: replace `uses: niranjan94/shopfloor/.github/workflows/shopfloor.yml@v1` with the `examples/shopfloor.yml` template and `uses: niranjan94/shopfloor@v2` step. Mention SHA pinning (`uses: niranjan94/shopfloor@<sha> # v2.0.0`) as the security-hardened alternative to the floating `v2` tag, matching the project's existing `pin-github-actions` posture.

v1 stays available indefinitely via the `@v1` tag for anyone who has not migrated.

## 13. Conventional commit plan

Per the project convention (`type(scope): subject`). Commits land on the `v2` branch in this order. Each is a working state with tests green for the surface it touches.

1. `chore(v2): scaffold src/ tree and esbuild target`
2. `feat(state): port state machine and metadata parsers to src/state/`
3. `test(state): port v1 state machine tests verbatim`
4. `feat(github): port GitHubAdapter and App-token mint to src/github/`
5. `feat(agents): introduce AgentAdapter interface and MockAgentAdapter`
6. `feat(agents): add Claude Agent SDK implementation`
7. `feat(tools): add update-progress and submit-decision in-process SDK tools`
8. `feat(audit): add JSONL event emitter and step-summary mirror`
9. `feat(stages): scaffold stage-vertical layout (empty runners)`
10. `feat(stages/triage): port triage prompt, decision schema, runner, apply`
11. `test(stages/triage): runner unit tests with MockAgentAdapter`
12. `feat(stages/review): port lenses, aggregate, apply`
13. `test(stages/review): lens fan-out and aggregation tests`
14. `feat(stages/implement): port implement prompt, runner, apply, progress comment`
15. `feat(stages/plan): port plan prompt, decision schema, runner, apply`
16. `feat(stages/spec): port spec prompt, decision schema, runner, apply`
17. `feat(orchestrator): wire entry, precheck, runner dispatch, finally cleanup`
18. `test(e2e): port fixture events and assert orchestrator end-to-end behaviour`
19. `feat(action): add action.yml, examples/shopfloor.yml, esbuild dist`
20. `chore(v2): commit built dist/index.cjs`
21. `docs(readme): document v2 migration`
22. `chore(v1): cutover on main — delete router/, mcp-servers/, prompts/, reusable workflow`
23. `chore(release): tag v2.0.0`

## 14. Open questions

None blocking. A few items that v2.0 deliberately defers:

- Whether to expose `output_schema` and a standalone-action mode (pullfrog-style) once the SDK integration is settled.
- Whether to ship a second AgentAdapter implementation (Codex, OpenCode) in a follow-up v2.x release.
- Whether `mcp-servers/` should be reintroduced as an optional MCP transport for external agents that cannot link in-process tools.

Each becomes a separate spec when there is a reason to revisit.
