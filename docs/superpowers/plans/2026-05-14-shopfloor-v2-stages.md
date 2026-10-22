# Shopfloor v2 — Plan 2: Stages

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the five stage modules — `triage`, `review`, `implement`, `plan`, `spec` — on top of the Plan 1 foundation. End state: each stage has its own directory with `prompt.system.md`, `prompt.user.md.ejs` (or equivalent template), `decision.ts`, `tools.ts`, `runner.ts`, `apply.ts`, and a matching test file. All stage tests are green using `MockAgentAdapter` and a mock `GitHubAdapter`. No orchestrator yet (Plan 3).

**Architecture:** Each stage is a self-contained module. The runner accepts `StageContext`, composes prompts and tools, calls `ctx.agent.runStage(...)`, returns a typed `Decision`. The apply function performs all GitHub mutations the decision implies. Stages do not call `reportFailure` themselves — they throw typed errors and the orchestrator (Plan 3) funnels them.

**Tech Stack:** Same as Plan 1. Prompts are stored as `.md` files alongside the code that uses them. `prompt.user.md.ejs` (or `.tmpl`) uses a small substitution helper, not a full template engine.

**Source of truth:** `docs/superpowers/specs/2026-05-14-shopfloor-v2-design.md` §5, §7. v1 stage prompts under `prompts/triage.md`, `prompts/spec.md`, `prompts/plan.md`, `prompts/implement.md`, `prompts/review-*.md`.

**Branch:** `v2`. Plan 1 must be merged or rebased before starting.

**Prerequisite:** Plan 1's `src/state/`, `src/github/`, `src/agents/`, `src/tools/`, `src/audit/`, `src/config/` exist and tests are green.

---

## Repository layout (after Plan 2)

```
shopfloor/
└── src/
    └── stages/
        ├── _shared/
        │   ├── context.ts          # StageContext type
        │   ├── prompts.ts          # readPrompt(file) helper, simple substitution
        │   └── _shared.test.ts
        ├── triage/
        │   ├── prompt.system.md
        │   ├── prompt.user.md.tmpl
        │   ├── decision.ts
        │   ├── tools.ts
        │   ├── runner.ts
        │   └── apply.ts
        ├── review/
        │   ├── lenses/
        │   │   ├── compliance/    (system.md, user.md.tmpl, decision.ts, tools.ts, runner.ts)
        │   │   ├── bugs/
        │   │   ├── security/
        │   │   └── smells/
        │   ├── aggregate.ts
        │   └── apply.ts
        ├── implement/
        │   ├── prompt.system.md
        │   ├── prompt.user.md.tmpl
        │   ├── decision.ts
        │   ├── tools.ts
        │   ├── runner.ts
        │   └── apply.ts
        ├── plan/
        └── spec/
└── test/
    └── stages/
        ├── triage.test.ts
        ├── review.test.ts
        ├── implement.test.ts
        ├── plan.test.ts
        └── spec.test.ts
```

Build order intentional: triage first (simplest, read-only), then review (proves lens fan-out), then implement (most complex, branch ops + progress comment), then plan and spec (similar to implement minus branch ops).

---

## Task 1: Shared stage infrastructure

**Files:**
- Create: `src/stages/_shared/context.ts`
- Create: `src/stages/_shared/prompts.ts`
- Create: `test/stages/_shared.test.ts`

- [ ] **Step 1: Write `test/stages/_shared.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/stages/_shared/prompts.js";

describe("renderTemplate", () => {
  it("substitutes {{ name }} placeholders from the context map", () => {
    const out = renderTemplate("Hello {{ who }}, you are #{{ num }}", { who: "world", num: 7 });
    expect(out).toBe("Hello world, you are #7");
  });

  it("leaves unreferenced placeholders intact and throws when a referenced key is missing", () => {
    expect(() => renderTemplate("Hi {{ missing }}", {})).toThrow(/missing/);
  });

  it("handles multiline templates and JSON serialization for object values", () => {
    const out = renderTemplate("Issue body:\n{{ body }}", { body: "line1\nline2" });
    expect(out).toContain("line1\nline2");
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/stages/_shared.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/stages/_shared/prompts.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function readPrompt(metaUrl: string, file: string): string {
  const here = dirname(fileURLToPath(metaUrl));
  return readFileSync(join(here, file), "utf8");
}

export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) {
      throw new Error(`renderTemplate: missing variable "${key}"`);
    }
    const v = vars[key];
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}
```

- [ ] **Step 4: Implement `src/stages/_shared/context.ts`**

```ts
import type { AgentAdapter } from "../../agents/adapter.js";
import type { GitHubAdapter } from "../../github/adapter.js";
import type { AuditEmitter } from "../../audit/events.js";
import type { Config } from "../../config/inputs.js";
import type { RouterDecision } from "../../state/machine.js";  // export RouterDecision from Plan 1's machine.ts if not already

export interface StageContext {
  event: unknown;                              // parsed GitHub event payload
  repo: { owner: string; name: string };
  decision: RouterDecision;                    // what state.machine resolved
  issue?: { number: number; title: string; body: string; labels: string[] };
  pr?: { number: number; title: string; body: string; headRef: string; headSha: string; baseRef: string };
  github: GitHubAdapter;
  reviewGithub: GitHubAdapter | null;          // distinct App; null when not configured
  agent: AgentAdapter;
  audit: AuditEmitter;
  config: Config;
  runId: string;
}
```

If `RouterDecision` is not yet exported from Plan 1's `state/machine.ts`, add the export. The decision type carries `stage`, `reason`, `issueNumber`, `branchName`, `specFilePath`, `planFilePath`, `reviewIteration`, `implPrNumber`, etc. — same shape as v1's `types.ts`.

- [ ] **Step 5: Run tests, expect pass**

```bash
pnpm test test/stages/_shared.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stages/_shared/ test/stages/_shared.test.ts
git commit -m "feat(stages): add shared stage context and prompt helpers"
```

---

## Task 2: Triage stage

**Files:**
- Create: `src/stages/triage/prompt.system.md`, `src/stages/triage/prompt.user.md.tmpl`
- Create: `src/stages/triage/decision.ts`, `src/stages/triage/tools.ts`, `src/stages/triage/runner.ts`, `src/stages/triage/apply.ts`
- Create: `test/stages/triage.test.ts`
- Read for reference: `prompts/triage.md` (v1), `router/src/helpers/apply-triage-decision.ts`

- [ ] **Step 1: Port v1 prompt content**

Open `prompts/triage.md` in v1. Split it into two files:
- `src/stages/triage/prompt.system.md` — the persona, role, and structural instructions ("you are the triage agent…"). Stage-wide, identical across every triage invocation.
- `src/stages/triage/prompt.user.md.tmpl` — the per-event context (issue title, body, repo info, comments). Uses `{{ issue_title }}`, `{{ issue_body }}`, `{{ repo }}`, `{{ recent_comments }}` placeholders that the runner substitutes.

Strip v1's "respond with this JSON block" instructions from both files. v2 uses `outputFormat: { type: 'json_schema' }`; the agent must not narrate the JSON. Replace those instructions with: "Return your decision via the structured-output channel."

- [ ] **Step 2: Implement `src/stages/triage/decision.ts`**

```ts
import { z } from "zod";

export const TriageDecision = z.object({
  complexity: z.enum(["quick", "medium", "large"]),
  slug: z.string().regex(/^[a-z0-9-]+$/, "lowercase kebab-case"),
  rationale: z.string().min(10),
  needsClarification: z.boolean().default(false),
  clarificationRequest: z.string().optional(),
});
export type TriageDecision = z.infer<typeof TriageDecision>;
```

The `needsClarification` field preserves v1's "triage may ask a question" affordance. The spec keeps triage's permission to request clarifications (only triage has this; spec/plan/impl do not).

- [ ] **Step 3: Implement `src/stages/triage/tools.ts`**

```ts
import type { SdkTool } from "../../tools/types.js";
import type { StageContext } from "../_shared/context.js";

export function triageTools(_ctx: StageContext): SdkTool[] {
  // Triage is read-only. The Claude SDK provides read-only file tools by default;
  // we add no GitHub-mutation tools. Progress updates do not apply to triage
  // because there is no pinned comment yet.
  return [];
}
```

- [ ] **Step 4: Implement `src/stages/triage/runner.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../_shared/prompts.js";
import { triageTools } from "./tools.js";
import { TriageDecision } from "./decision.js";
import type { StageContext } from "../_shared/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM = readFileSync(join(here, "prompt.system.md"), "utf8");
const USER_TMPL = readFileSync(join(here, "prompt.user.md.tmpl"), "utf8");

export async function runTriage(ctx: StageContext): Promise<TriageDecision> {
  if (!ctx.issue) throw new Error("runTriage requires ctx.issue");
  const userPrompt = renderTemplate(USER_TMPL, {
    issue_title: ctx.issue.title,
    issue_body: ctx.issue.body ?? "",
    repo: `${ctx.repo.owner}/${ctx.repo.name}`,
    recent_comments: "",            // populate from ctx if needed
  });
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt,
    tools: triageTools(ctx),
    decisionSchema: TriageDecision,
    model: ctx.config.triageModel,
    budgetUsd: ctx.config.budgets.triageUsd,
    timeoutMs: ctx.config.timeouts.triageMs,
  });
}
```

- [ ] **Step 5: Implement `src/stages/triage/apply.ts`**

```ts
import type { StageContext } from "../_shared/context.js";
import type { TriageDecision } from "./decision.js";
import { LABELS, complexityLabel, needsLabelFor } from "../../state/labels.js";

export async function applyTriage(ctx: StageContext, d: TriageDecision): Promise<void> {
  if (!ctx.issue) throw new Error("applyTriage requires ctx.issue");

  if (d.needsClarification && d.clarificationRequest) {
    await ctx.github.addIssueComment(ctx.issue.number, formatClarification(d.clarificationRequest));
    await ctx.github.replaceLabels(ctx.issue.number, {
      remove: [LABELS.triaging],
      // leave the trigger label in place; a human responds and triage re-fires
    });
    ctx.audit.emit({ type: "stage_decided", stage: "triage", decision: d, tokensUsed: 0, costUsd: 0 });
    return;
  }

  await ctx.github.upsertIssueMetadata(ctx.issue.number, { slug: d.slug });

  const next = nextLabelForComplexity(d.complexity);
  await ctx.github.replaceLabels(ctx.issue.number, {
    add: [complexityLabel(d.complexity), next],
    remove: [LABELS.triaging],
  });
  ctx.audit.emit({ type: "label_applied", issueNumber: ctx.issue.number, add: [complexityLabel(d.complexity), next], remove: [LABELS.triaging] });
  ctx.audit.emit({ type: "stage_decided", stage: "triage", decision: d, tokensUsed: 0, costUsd: 0 });
}

function nextLabelForComplexity(c: TriageDecision["complexity"]): string {
  if (c === "quick") return needsLabelFor("implement");
  if (c === "medium") return needsLabelFor("plan");
  return needsLabelFor("spec");
}

function formatClarification(req: string): string {
  return [
    "## Shopfloor triage needs clarification",
    "",
    req,
    "",
    "*Reply below; triage will re-run when this comment is replied to.*",
  ].join("\n");
}
```

- [ ] **Step 6: Write `test/stages/triage.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { runTriage } from "../../src/stages/triage/runner.js";
import { applyTriage } from "../../src/stages/triage/apply.js";
import { MockAgentAdapter } from "../../src/agents/mock.js";
import { makeMockGithub } from "../github/_mock-github.js";  // create alongside if not present
import type { StageContext } from "../../src/stages/_shared/context.js";

function ctxFor(decisionToReturn: Record<string, unknown>): StageContext {
  return {
    event: {},
    repo: { owner: "octo", name: "demo" },
    decision: { stage: "triage" } as any,
    issue: { number: 7, title: "feat: do the thing", body: "we need X", labels: [] },
    pr: undefined,
    github: makeMockGithub(),
    reviewGithub: null,
    agent: new MockAgentAdapter([{ matchUserPromptIncludes: "do the thing", decision: decisionToReturn }]),
    audit: vi.fn(),
    config: {
      triageModel: "claude-haiku",
      budgets: { triageUsd: 0.25 },
      timeouts: { triageMs: 60_000 },
    } as any,
    runId: "r1",
  };
}

describe("triage", () => {
  it("classifies large complexity and applies needs-spec label", async () => {
    const ctx = ctxFor({ complexity: "large", slug: "do-thing", rationale: "spans multiple modules" });
    const decision = await runTriage(ctx);
    expect(decision.complexity).toBe("large");
    await applyTriage(ctx, decision);
    expect(ctx.github.replaceLabels).toHaveBeenCalledWith(7, expect.objectContaining({
      add: expect.arrayContaining(["shopfloor:complexity:large", "shopfloor:needs-spec"]),
      remove: ["shopfloor:triaging"],
    }));
  });

  it("classifies quick complexity and applies needs-impl label", async () => {
    const ctx = ctxFor({ complexity: "quick", slug: "fix-typo", rationale: "single-line edit" });
    const d = await runTriage(ctx);
    await applyTriage(ctx, d);
    expect(ctx.github.replaceLabels).toHaveBeenCalledWith(7, expect.objectContaining({
      add: expect.arrayContaining(["shopfloor:needs-impl"]),
    }));
  });

  it("posts a clarification comment when needsClarification is true", async () => {
    const ctx = ctxFor({
      complexity: "quick", slug: "needs-clarification", rationale: "input shape is undefined; ask before triaging",
      needsClarification: true, clarificationRequest: "Please specify the input shape.",
    });
    const d = await runTriage(ctx);
    await applyTriage(ctx, d);
    expect(ctx.github.addIssueComment).toHaveBeenCalledWith(7, expect.stringContaining("specify the input shape"));
  });
});
```

Add `test/github/_mock-github.ts` if not present:

```ts
import { vi } from "vitest";

export function makeMockGithub() {
  return {
    getIssueLabels: vi.fn().mockResolvedValue([]),
    replaceLabels: vi.fn().mockResolvedValue(undefined),
    ensureLabelsExist: vi.fn().mockResolvedValue(undefined),
    getIssue: vi.fn(),
    upsertIssueMetadata: vi.fn().mockResolvedValue(undefined),
    addIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    getPullRequest: vi.fn(),
    createPullRequest: vi.fn().mockResolvedValue({ number: 100 }),
    updatePullRequestBody: vi.fn().mockResolvedValue(undefined),
    setPullRequestDraft: vi.fn().mockResolvedValue(undefined),
    listPullRequestFiles: vi.fn().mockResolvedValue([]),
    listPullRequestReviewComments: vi.fn().mockResolvedValue([]),
    createOrUpdateRef: vi.fn().mockResolvedValue(undefined),
    getRef: vi.fn().mockResolvedValue(null),
    createCommit: vi.fn().mockResolvedValue({ sha: "abc1234" }),
    postReview: vi.fn().mockResolvedValue(undefined),
  };
}
```

- [ ] **Step 7: Run tests, expect pass**

```bash
pnpm test test/stages/triage.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/stages/_shared/ src/stages/triage/ test/stages/triage.test.ts test/github/_mock-github.ts
git commit -m "feat(stages/triage): port triage stage with structured decision"
```

---

## Task 3: Review stage (four lenses + aggregator)

**Files:**
- Create per lens (compliance, bugs, security, smells): `src/stages/review/lenses/<lens>/prompt.system.md`, `prompt.user.md.tmpl`, `decision.ts`, `tools.ts`, `runner.ts`
- Create: `src/stages/review/aggregate.ts`, `src/stages/review/apply.ts`, `src/stages/review/runner.ts`
- Create: `test/stages/review.test.ts`
- Read for reference: `prompts/review-compliance.md`, `prompts/review-bugs.md`, `prompts/review-security.md`, `prompts/review-smells.md` (v1), `router/src/helpers/aggregate-review.ts`

- [ ] **Step 1: Define the shared lens finding schema in `src/stages/review/decision.ts`**

```ts
import { z } from "zod";

export const Severity = z.enum(["blocker", "major", "minor", "nit"]);
export type Severity = z.infer<typeof Severity>;

export const Finding = z.object({
  severity: Severity,
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  title: z.string(),
  detail: z.string(),
  suggestion: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const LensDecision = z.object({
  lens: z.enum(["compliance", "bugs", "security", "smells"]),
  findings: z.array(Finding),
  summary: z.string(),
});
export type LensDecision = z.infer<typeof LensDecision>;
```

- [ ] **Step 2: Port v1 lens prompts**

For each of `compliance`, `bugs`, `security`, `smells`:
- `prompt.system.md` — the lens persona and instructions.
- `prompt.user.md.tmpl` — the per-PR context with placeholders `{{ pr_title }}`, `{{ pr_body }}`, `{{ pr_diff }}`, `{{ claude_md_excerpt }}` (compliance lens only), `{{ recent_comments }}`.

Strip v1's "respond with this JSON" instructions; v2 uses structured output.

- [ ] **Step 3: Implement per-lens runners (same pattern as triage)**

Each `src/stages/review/lenses/<lens>/runner.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../../../_shared/prompts.js";
import { LensDecision } from "../../decision.js";
import type { StageContext } from "../../../_shared/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM = readFileSync(join(here, "prompt.system.md"), "utf8");
const USER_TMPL = readFileSync(join(here, "prompt.user.md.tmpl"), "utf8");

export async function runComplianceLens(ctx: StageContext): Promise<LensDecision> {
  if (!ctx.pr) throw new Error("review lens requires ctx.pr");
  const userPrompt = renderTemplate(USER_TMPL, {
    pr_title: ctx.pr.title,
    pr_body: ctx.pr.body ?? "",
    pr_diff: await ctx.github.listPullRequestFiles(ctx.pr.number).then(fmtDiff),
    claude_md_excerpt: "",   // optional: load CLAUDE.md from the PR head ref
    recent_comments: "",
  });
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt,
    tools: [],
    decisionSchema: LensDecision,
    model: ctx.config.reviewModels.compliance,
    budgetUsd: ctx.config.budgets.reviewPerLensUsd,
    timeoutMs: ctx.config.timeouts.reviewPerLensMs,
  });
}

function fmtDiff(_files: unknown[]): string {
  // Implementation: render a compact unified-diff summary the lens can read.
  // Port v1's diff renderer from router/src/helpers/build-revision-context.ts if available.
  return "<diff omitted in shared snippet — implement in port>";
}
```

Repeat with the lens name swapped for bugs, security, smells. Keep the runner files identical in shape; the only differences are the imported config key and the prompt files.

- [ ] **Step 4: Implement `src/stages/review/runner.ts` (the lens fan-out)**

```ts
import type { StageContext } from "../_shared/context.js";
import type { LensDecision } from "./decision.js";
import { runComplianceLens } from "./lenses/compliance/runner.js";
import { runBugsLens } from "./lenses/bugs/runner.js";
import { runSecurityLens } from "./lenses/security/runner.js";
import { runSmellsLens } from "./lenses/smells/runner.js";

export interface LensOutcome {
  lens: LensDecision["lens"];
  decision: LensDecision | null;
  error: { kind: string; message: string } | null;
}

export async function runReview(ctx: StageContext): Promise<LensOutcome[]> {
  const lenses = [
    ["compliance", runComplianceLens],
    ["bugs", runBugsLens],
    ["security", runSecurityLens],
    ["smells", runSmellsLens],
  ] as const;

  const results = await Promise.allSettled(lenses.map(([_, fn]) => fn(ctx)));
  return results.map((r, i) => {
    const [name] = lenses[i]!;
    if (r.status === "fulfilled") return { lens: name, decision: r.value, error: null };
    return {
      lens: name,
      decision: null,
      error: { kind: (r.reason as any)?.kind ?? "agent_execution", message: String((r.reason as any)?.message ?? r.reason) },
    };
  });
}
```

- [ ] **Step 5: Implement `src/stages/review/aggregate.ts`**

```ts
import type { LensOutcome } from "./runner.js";
import type { Finding } from "./decision.js";

export interface ReviewVerdict {
  event: "APPROVE" | "REQUEST_CHANGES";
  body: string;
  findings: Array<Finding & { lens: string }>;
  lensFailures: Array<{ lens: string; kind: string; message: string }>;
}

const BLOCKING: Array<Finding["severity"]> = ["blocker", "major"];

export function aggregateFindings(outcomes: LensOutcome[]): ReviewVerdict {
  const findings: ReviewVerdict["findings"] = [];
  const lensFailures: ReviewVerdict["lensFailures"] = [];

  for (const o of outcomes) {
    if (o.error) {
      lensFailures.push({ lens: o.lens, ...o.error });
      continue;
    }
    if (!o.decision) continue;
    for (const f of o.decision.findings) findings.push({ ...f, lens: o.decision.lens });
  }

  const hasBlocker = findings.some(f => BLOCKING.includes(f.severity));
  const allLensesFailed = outcomes.every(o => o.error != null);

  const event = hasBlocker || lensFailures.length > 0 || allLensesFailed ? "REQUEST_CHANGES" : "APPROVE";
  const body = renderReviewBody({ event, findings, lensFailures });
  return { event, body, findings, lensFailures };
}

function renderReviewBody(args: { event: "APPROVE" | "REQUEST_CHANGES"; findings: ReviewVerdict["findings"]; lensFailures: ReviewVerdict["lensFailures"] }): string {
  const lines: string[] = [];
  lines.push(`## Shopfloor review`);
  lines.push("");
  lines.push(args.event === "APPROVE" ? "✅ No blocking findings." : "🔴 Changes requested.");
  if (args.lensFailures.length) {
    lines.push("");
    lines.push("### Lens failures");
    for (const f of args.lensFailures) lines.push(`- **${f.lens}** failed (${f.kind}): ${f.message}`);
  }
  if (args.findings.length) {
    lines.push("");
    lines.push("### Findings");
    for (const f of args.findings) {
      const loc = f.path ? ` \`${f.path}${f.line ? `:${f.line}` : ""}\`` : "";
      lines.push(`- **[${f.severity}] ${f.lens}**${loc}: ${f.title}`);
      lines.push(`  ${f.detail}`);
      if (f.suggestion) lines.push(`  *Suggestion:* ${f.suggestion}`);
    }
  }
  return lines.join("\n");
}
```

- [ ] **Step 6: Implement `src/stages/review/apply.ts`**

```ts
import type { StageContext } from "../_shared/context.js";
import type { ReviewVerdict } from "./aggregate.js";

export async function applyReview(ctx: StageContext, verdict: ReviewVerdict, iteration: number): Promise<void> {
  if (!ctx.pr) throw new Error("applyReview requires ctx.pr");
  const adapter = ctx.reviewGithub ?? ctx.github;
  await adapter.postReview(ctx.pr.number, { event: verdict.event, body: verdict.body });
  ctx.audit.emit({
    type: "review_posted",
    prNumber: ctx.pr.number,
    verdict: verdict.event === "APPROVE" ? "approve" : "request_changes",
    iteration,
  });
}
```

If the review-App adapter is configured (`ctx.reviewGithub != null`), use it. Otherwise fall back to the primary adapter — but log that the bot is reviewing its own PR (GitHub will reject `APPROVE`/`REQUEST_CHANGES`). The orchestrator (Plan 3) decides whether to skip the review stage when no review-App is configured.

- [ ] **Step 7: Write `test/stages/review.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { aggregateFindings } from "../../src/stages/review/aggregate.js";
import { applyReview } from "../../src/stages/review/apply.js";
import { makeMockGithub } from "../github/_mock-github.js";

describe("aggregateFindings", () => {
  it("approves when all lenses succeed with only nits", () => {
    const v = aggregateFindings([
      { lens: "compliance", decision: { lens: "compliance", findings: [], summary: "ok" }, error: null },
      { lens: "bugs",       decision: { lens: "bugs", findings: [{ severity: "nit", title: "n", detail: "d" }], summary: "ok" }, error: null },
      { lens: "security",   decision: { lens: "security", findings: [], summary: "ok" }, error: null },
      { lens: "smells",     decision: { lens: "smells", findings: [], summary: "ok" }, error: null },
    ]);
    expect(v.event).toBe("APPROVE");
  });

  it("requests changes when any lens reports a blocker", () => {
    const v = aggregateFindings([
      { lens: "compliance", decision: { lens: "compliance", findings: [{ severity: "blocker", title: "x", detail: "d" }], summary: "x" }, error: null },
      { lens: "bugs",       decision: { lens: "bugs", findings: [], summary: "ok" }, error: null },
      { lens: "security",   decision: { lens: "security", findings: [], summary: "ok" }, error: null },
      { lens: "smells",     decision: { lens: "smells", findings: [], summary: "ok" }, error: null },
    ]);
    expect(v.event).toBe("REQUEST_CHANGES");
  });

  it("requests changes and surfaces lens failures", () => {
    const v = aggregateFindings([
      { lens: "compliance", decision: null, error: { kind: "agent_budget", message: "over" } },
      { lens: "bugs",       decision: { lens: "bugs", findings: [], summary: "ok" }, error: null },
      { lens: "security",   decision: { lens: "security", findings: [], summary: "ok" }, error: null },
      { lens: "smells",     decision: { lens: "smells", findings: [], summary: "ok" }, error: null },
    ]);
    expect(v.event).toBe("REQUEST_CHANGES");
    expect(v.body).toContain("Lens failures");
    expect(v.body).toContain("compliance");
  });
});

describe("applyReview", () => {
  it("posts the review via reviewGithub when configured", async () => {
    const reviewGh = makeMockGithub();
    const primaryGh = makeMockGithub();
    const ctx: any = {
      pr: { number: 100 }, github: primaryGh, reviewGithub: reviewGh,
      audit: vi.fn(),
    };
    await applyReview(ctx, { event: "APPROVE", body: "ok", findings: [], lensFailures: [] }, 1);
    expect(reviewGh.postReview).toHaveBeenCalled();
    expect(primaryGh.postReview).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run tests, expect pass**

```bash
pnpm test test/stages/review.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/stages/review/ test/stages/review.test.ts
git commit -m "feat(stages/review): port four lenses, fan-out, aggregation, apply"
```

---

## Task 4: Implement stage

**Files:**
- Create: `src/stages/implement/prompt.system.md`, `src/stages/implement/prompt.user.md.tmpl`
- Create: `src/stages/implement/decision.ts`, `tools.ts`, `runner.ts`, `apply.ts`
- Create: `test/stages/implement.test.ts`
- Read for reference: `prompts/implement.md`, `router/src/helpers/open-stage-pr.ts`, `router/src/helpers/apply-impl-postwork.ts`, `router/src/helpers/create-progress-comment.ts`, `router/src/helpers/finalize-progress-comment.ts`

The implement stage is the most involved. It writes code, opens a draft PR with the progress comment, then on success flips the PR out of draft and applies post-work labels.

- [ ] **Step 1: Port `prompts/implement.md` to `src/stages/implement/prompt.system.md` + `prompt.user.md.tmpl`**

Same split as triage. Strip the "emit JSON" instructions.

- [ ] **Step 2: Implement `src/stages/implement/decision.ts`**

```ts
import { z } from "zod";

export const ImplementDecision = z.object({
  branch: z.string().regex(/^shopfloor\/impl\/\d+-[a-z0-9-]+$/),
  prTitle: z.string().min(5),
  prBody: z.string().min(1),
  progressSummary: z.string(),
  filesChanged: z.array(z.object({
    path: z.string(),
    operation: z.enum(["create", "modify", "delete"]),
    note: z.string().optional(),
  })),
});
export type ImplementDecision = z.infer<typeof ImplementDecision>;
```

The actual filesystem changes happen via the SDK's built-in file tools and `Bash` (constrained); the decision captures the result for audit and post-work.

- [ ] **Step 3: Implement `src/stages/implement/tools.ts`**

```ts
import type { SdkTool } from "../../tools/types.js";
import type { StageContext } from "../_shared/context.js";
import { updateProgressTool } from "../../tools/update-progress.js";

export interface ImplToolsArgs {
  progressCommentId: number;
}

export function implementTools(ctx: StageContext, args: ImplToolsArgs): SdkTool[] {
  if (!ctx.issue) throw new Error("implement tools require ctx.issue");
  return [
    updateProgressTool({
      github: ctx.github,
      commentId: args.progressCommentId,
      issueNumber: ctx.issue.number,
    }),
    // SDK file tools and Bash come built-in via the Agent SDK options;
    // we do not add custom mutation tools here. Git commits and pushes are
    // performed by the agent using SDK-provided shell access constrained
    // by allowedTools.
  ];
}
```

- [ ] **Step 4: Implement `src/stages/implement/runner.ts`**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "../_shared/prompts.js";
import { implementTools } from "./tools.js";
import { ImplementDecision } from "./decision.js";
import type { StageContext } from "../_shared/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM = readFileSync(join(here, "prompt.system.md"), "utf8");
const USER_TMPL = readFileSync(join(here, "prompt.user.md.tmpl"), "utf8");

export interface RunImplementArgs {
  progressCommentId: number;
  specBody: string | null;
  planBody: string | null;
  branchName: string;
}

export async function runImplement(ctx: StageContext, args: RunImplementArgs): Promise<ImplementDecision> {
  if (!ctx.issue) throw new Error("runImplement requires ctx.issue");
  const userPrompt = renderTemplate(USER_TMPL, {
    issue_title: ctx.issue.title,
    issue_body: ctx.issue.body ?? "",
    repo: `${ctx.repo.owner}/${ctx.repo.name}`,
    branch: args.branchName,
    spec: args.specBody ?? "(no spec — quick complexity)",
    plan: args.planBody ?? "(no plan — quick complexity)",
  });
  return ctx.agent.runStage({
    systemPrompt: SYSTEM,
    userPrompt,
    tools: implementTools(ctx, { progressCommentId: args.progressCommentId }),
    decisionSchema: ImplementDecision,
    model: ctx.config.implModel,
    budgetUsd: ctx.config.budgets.implUsd,
    timeoutMs: ctx.config.timeouts.implMs,
  });
}
```

- [ ] **Step 5: Implement `src/stages/implement/apply.ts`**

```ts
import type { StageContext } from "../_shared/context.js";
import type { ImplementDecision } from "./decision.js";
import { LABELS } from "../../state/labels.js";
import { renderPrBodyWithMetadata } from "../../github/pr-metadata.js"; // Plan 1 writer

export interface ApplyImplementArgs {
  decision: ImplementDecision;
  progressCommentId: number;
  reviewIteration: number;
}

export async function applyImplement(ctx: StageContext, args: ApplyImplementArgs): Promise<{ prNumber: number }> {
  if (!ctx.issue) throw new Error("applyImplement requires ctx.issue");

  // 1. Open (or update) the draft impl PR.
  const existingPr = await findExistingImplPr(ctx, args.decision.branch);
  const body = renderPrBodyWithMetadata({
    issueNumber: ctx.issue.number,
    stage: "implement",
    reviewIteration: args.reviewIteration,
    userBody: args.decision.prBody,
  });
  const pr = existingPr
    ? (await ctx.github.updatePullRequestBody(existingPr, body), { number: existingPr })
    : await ctx.github.createPullRequest({
        title: args.decision.prTitle,
        head: args.decision.branch,
        base: "main",
        body,
        draft: true,
      });

  // 2. Finalize the progress comment.
  await ctx.github.updateIssueComment(args.progressCommentId, formatFinalProgress(args.decision));

  // 3. Flip labels: implementing → impl-in-review.
  await ctx.github.replaceLabels(ctx.issue.number, {
    add: [LABELS.implInReview],
    remove: [LABELS.implementing, LABELS.needsImpl],
  });

  // 4. Take the PR out of draft so the review stage can fire.
  await ctx.github.setPullRequestDraft(pr.number, false);

  ctx.audit.emit({ type: "pr_opened", stage: "implement", prNumber: pr.number });
  ctx.audit.emit({ type: "label_applied", issueNumber: ctx.issue.number, add: [LABELS.implInReview], remove: [LABELS.implementing, LABELS.needsImpl] });
  ctx.audit.emit({ type: "stage_decided", stage: "implement", decision: args.decision, tokensUsed: 0, costUsd: 0 });

  return { prNumber: pr.number };
}

async function findExistingImplPr(_ctx: StageContext, _branch: string): Promise<number | null> {
  // Implementation: query open PRs from the given head ref. Port v1's lookup if present.
  return null;
}

function formatFinalProgress(d: ImplementDecision): string {
  const lines = ["## Implementation summary", "", d.progressSummary, "", "### Files changed"];
  for (const f of d.filesChanged) lines.push(`- \`${f.path}\` (${f.operation})${f.note ? ` — ${f.note}` : ""}`);
  return lines.join("\n");
}
```

- [ ] **Step 6: Write `test/stages/implement.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { applyImplement } from "../../src/stages/implement/apply.js";
import { makeMockGithub } from "../github/_mock-github.js";

const decision = {
  branch: "shopfloor/impl/42-thing",
  prTitle: "feat: do thing",
  prBody: "Implements #42",
  progressSummary: "Did the thing.",
  filesChanged: [{ path: "src/thing.ts", operation: "create" as const, note: "main module" }],
};

function ctx(overrides: Partial<any> = {}) {
  return {
    repo: { owner: "octo", name: "demo" },
    issue: { number: 42, title: "feat", body: "", labels: [] },
    pr: undefined,
    github: makeMockGithub(),
    reviewGithub: null,
    audit: vi.fn(),
    ...overrides,
  };
}

describe("applyImplement", () => {
  it("creates a draft PR, finalizes progress, flips labels, un-drafts", async () => {
    const c = ctx();
    c.github.createPullRequest.mockResolvedValue({ number: 200 });
    const result = await applyImplement(c as any, { decision, progressCommentId: 9, reviewIteration: 1 });
    expect(result.prNumber).toBe(200);
    expect(c.github.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ draft: true, head: decision.branch }));
    expect(c.github.updateIssueComment).toHaveBeenCalledWith(9, expect.stringContaining("Did the thing"));
    expect(c.github.replaceLabels).toHaveBeenCalledWith(42, expect.objectContaining({
      add: ["shopfloor:impl-in-review"],
      remove: expect.arrayContaining(["shopfloor:implementing", "shopfloor:needs-impl"]),
    }));
    expect(c.github.setPullRequestDraft).toHaveBeenCalledWith(200, false);
  });
});
```

- [ ] **Step 7: Run tests, expect pass**

```bash
pnpm test test/stages/implement.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/stages/implement/ test/stages/implement.test.ts
git commit -m "feat(stages/implement): port implement stage with PR open and post-work"
```

---

## Task 5: Plan stage

**Files:**
- Create: `src/stages/plan/{prompt.system.md, prompt.user.md.tmpl, decision.ts, tools.ts, runner.ts, apply.ts}`
- Create: `test/stages/plan.test.ts`
- Read for reference: `prompts/plan.md`, `router/src/helpers/open-stage-pr.ts`, `router/src/helpers/seed-stage-pr.ts`

Plan-stage agents produce a markdown plan file. The stage opens a PR containing only that file. Human merges; orchestrator advances state.

- [ ] **Step 1: Port `prompts/plan.md` to system + user templates, stripping JSON instructions.**

- [ ] **Step 2: Implement `src/stages/plan/decision.ts`**

```ts
import { z } from "zod";

export const PlanDecision = z.object({
  branch: z.string().regex(/^shopfloor\/plan\/\d+-[a-z0-9-]+$/),
  planMarkdown: z.string().min(50),
  filePath: z.string().regex(/^docs\/shopfloor\/plans\/.+\.md$/),
  prTitle: z.string().min(5),
  prBody: z.string().min(1),
});
export type PlanDecision = z.infer<typeof PlanDecision>;
```

- [ ] **Step 3: Implement `src/stages/plan/tools.ts`**

```ts
import type { SdkTool } from "../../tools/types.js";
import type { StageContext } from "../_shared/context.js";

export function planTools(_ctx: StageContext): SdkTool[] {
  // Plan stage is design-only. No GitHub mutations. The agent's file tools
  // produce the plan file locally; the apply step commits it.
  return [];
}
```

- [ ] **Step 4: Implement `src/stages/plan/runner.ts`** following the triage/implement pattern, reading `SYSTEM` + `USER_TMPL`, passing through `ctx.config.planModel` and the matching budget/timeout.

- [ ] **Step 5: Implement `src/stages/plan/apply.ts`**

```ts
import type { StageContext } from "../_shared/context.js";
import type { PlanDecision } from "./decision.js";
import { LABELS } from "../../state/labels.js";
import { renderPrBodyWithMetadata } from "../../github/pr-metadata.js";

export async function applyPlan(ctx: StageContext, d: PlanDecision): Promise<{ prNumber: number }> {
  if (!ctx.issue) throw new Error("applyPlan requires ctx.issue");

  await ctx.github.createCommit({
    branch: d.branch,
    message: `chore(plan): add plan for #${ctx.issue.number}`,
    files: [{ path: d.filePath, content: d.planMarkdown }],
  });

  const body = renderPrBodyWithMetadata({
    issueNumber: ctx.issue.number,
    stage: "plan",
    reviewIteration: 1,
    userBody: d.prBody,
  });

  const pr = await ctx.github.createPullRequest({
    title: d.prTitle,
    head: d.branch,
    base: "main",
    body,
    draft: false,
  });

  await ctx.github.upsertIssueMetadata(ctx.issue.number, { planPath: d.filePath });
  await ctx.github.replaceLabels(ctx.issue.number, {
    add: [LABELS.planInReview],
    remove: [LABELS.planRunning, LABELS.needsPlan],
  });

  ctx.audit.emit({ type: "pr_opened", stage: "plan", prNumber: pr.number });
  ctx.audit.emit({ type: "stage_decided", stage: "plan", decision: d, tokensUsed: 0, costUsd: 0 });
  return { prNumber: pr.number };
}
```

- [ ] **Step 6: Write `test/stages/plan.test.ts`** mirroring `triage.test.ts` and `implement.test.ts` — assert that `applyPlan` commits the file, opens a non-draft PR, upserts the plan path, and flips labels.

- [ ] **Step 7: Run tests, expect pass**

```bash
pnpm test test/stages/plan.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/stages/plan/ test/stages/plan.test.ts
git commit -m "feat(stages/plan): port plan stage with PR open and label flip"
```

---

## Task 6: Spec stage

**Files:**
- Create: `src/stages/spec/{prompt.system.md, prompt.user.md.tmpl, decision.ts, tools.ts, runner.ts, apply.ts}`
- Create: `test/stages/spec.test.ts`
- Read for reference: `prompts/spec.md`, same helpers as plan

The spec stage is structurally identical to the plan stage. Only the labels, file path pattern, and prompt differ.

- [ ] **Step 1: Port `prompts/spec.md` to system + user templates.**

- [ ] **Step 2: Implement `src/stages/spec/decision.ts`**

```ts
import { z } from "zod";

export const SpecDecision = z.object({
  branch: z.string().regex(/^shopfloor\/spec\/\d+-[a-z0-9-]+$/),
  specMarkdown: z.string().min(50),
  filePath: z.string().regex(/^docs\/shopfloor\/specs\/.+\.md$/),
  prTitle: z.string().min(5),
  prBody: z.string().min(1),
});
export type SpecDecision = z.infer<typeof SpecDecision>;
```

- [ ] **Step 3: Implement `tools.ts`, `runner.ts`, `apply.ts`** mirroring the plan stage. The label flips on apply are: add `LABELS.specInReview`, remove `LABELS.specRunning`. Upsert `specPath` not `planPath`.

- [ ] **Step 4: Write `test/stages/spec.test.ts`**, mirroring `plan.test.ts`.

- [ ] **Step 5: Run tests, expect pass**

```bash
pnpm test test/stages/spec.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/stages/spec/ test/stages/spec.test.ts
git commit -m "feat(stages/spec): port spec stage with PR open and label flip"
```

---

## Task 7: Stage suite sanity check

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: every hermetic test passes (Plan 1 + Plan 2). Live test skipped.

- [ ] **Step 2: Typecheck**

```bash
pnpm exec tsc --noEmit
```

- [ ] **Step 3: Verify the stage layout matches the plan**

```bash
find src/stages -type f | sort
```

Expected: every file listed in this plan's repo-layout section is present. No stale files.

- [ ] **Step 4: Sanity-check coverage**

```bash
pnpm exec vitest run --coverage
```

Expected: stage runners and apply files at ≥ 90% line coverage. If a file is below, add the missing test path.

- [ ] **Step 5: Commit (if formatter touched anything)**

```bash
pnpm format
git diff --quiet || (git add -A && git commit -m "chore(v2): apply prettier after stages")
```

- [ ] **Step 6: Push**

```bash
git push origin v2
```

---

## Self-review checklist (for the agent executing this plan)

- [ ] Every stage has exactly the five files listed in the spec: `prompt.system.md`, `prompt.user.md.tmpl`, `decision.ts`, `tools.ts`, `runner.ts`, `apply.ts`. No drift.
- [ ] No stage file imports from another stage. Cross-stage logic belongs in `_shared/` or in Plan 3's orchestrator.
- [ ] Triage stage tools list is empty. Spec and plan stage tools lists are empty. Implement is the only stage with `update_progress`.
- [ ] Review stage uses `Promise.allSettled`, not `Promise.all`. A failed lens does not abort siblings.
- [ ] The review verdict resolves to `REQUEST_CHANGES` when any lens fails, regardless of findings.
- [ ] No stage emits prose JSON expecting parsing — all decisions come back through `decisionSchema` via the SDK's structured-output channel.
- [ ] Prompts contain no "respond with the following JSON" instructions left over from v1.
- [ ] Every `applyXxx` ends with an audit emit. No silent mutations.

Plan 3 (Orchestrator + action shell + cutover) depends on this stage suite being green.
