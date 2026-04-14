# Shopfloor v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Shopfloor v0.1, a reusable GitHub Actions workflow that wraps `anthropics/claude-code-action@v1` to drive a staged, human-gated pipeline (triage → spec → plan → implement → agent review) across GitHub issues and PRs.

**Architecture:** A deterministic TypeScript router owns all GitHub state mutations and stage dispatch. `claude-code-action` agents run in agent mode per stage and only return structured output. A small Shopfloor-namespaced MCP server provides a live-updating progress comment to the implementation agent. The public surface is one reusable workflow file (`.github/workflows/shopfloor.yml`) consumed via `uses:` and a version tag.

**Tech Stack:** TypeScript, `@actions/core`, `@actions/github`, `@octokit/rest`, `@modelcontextprotocol/sdk`, `vitest`, `pnpm` workspaces, GitHub Actions reusable workflows, `bun` runtime (for the MCP server subprocess, matching `claude-code-action`).

**Source of truth:** `docs/superpowers/specs/2026-04-14-shopfloor-design.md`. Every ambiguity here resolves to that spec.

**Prompt authoring:** Phase 4 tasks involve writing prompt templates. When executing those tasks, invoke the `prompt-engineering` skill (`/prompt-engineering`) to ensure each stage's system prompt and structured output contract follow current Anthropic best practices.

---

## Repository layout (target)

```
/
├── .github/
│   └── workflows/
│       ├── shopfloor.yml                    # THE reusable workflow (workflow_call)
│       ├── ci.yml                           # lint + tests
│       └── dogfood.yml                      # self-hosted caller
├── router/
│   ├── package.json
│   ├── tsconfig.json
│   ├── action.yml                           # main router action
│   ├── src/
│   │   ├── index.ts                         # main entry (reads event, writes outputs)
│   │   ├── state.ts                         # pure state machine
│   │   ├── github.ts                        # octokit adapter
│   │   ├── types.ts                         # shared types
│   │   └── helpers/
│   │       ├── bootstrap-labels.ts
│   │       ├── open-stage-pr.ts
│   │       ├── advance-state.ts
│   │       ├── report-failure.ts
│   │       ├── handle-merge.ts
│   │       ├── create-progress-comment.ts
│   │       ├── finalize-progress-comment.ts
│   │       ├── check-review-skip.ts
│   │       └── aggregate-review.ts
│   ├── bootstrap-labels/action.yml
│   ├── open-stage-pr/action.yml
│   ├── advance-state/action.yml
│   ├── report-failure/action.yml
│   ├── handle-merge/action.yml
│   ├── create-progress-comment/action.yml
│   ├── finalize-progress-comment/action.yml
│   ├── check-review-skip/action.yml
│   ├── aggregate-review/action.yml
│   └── test/
│       ├── state.test.ts
│       ├── github.test.ts
│       ├── aggregate-review.test.ts
│       ├── check-review-skip.test.ts
│       └── fixtures/
│           ├── events/
│           ├── reviewer-outputs/
│           └── responses/
├── mcp-servers/
│   └── shopfloor-mcp/
│       ├── package.json
│       ├── tsconfig.json
│       ├── index.ts
│       └── test/
│           └── index.test.ts
├── prompts/
│   ├── triage.md
│   ├── spec.md
│   ├── plan.md
│   ├── implement.md
│   ├── review-compliance.md
│   ├── review-bugs.md
│   ├── review-security.md
│   └── review-smells.md
├── test/
│   └── e2e/
│       ├── harness/
│       │   ├── mock-github.ts
│       │   ├── mock-claude-code-action.ts
│       │   └── orchestrator.ts
│       ├── large-happy-path.test.ts
│       ├── medium-happy-path.test.ts
│       ├── quick-happy-path.test.ts
│       ├── triage-clarification.test.ts
│       ├── stage-failure.test.ts
│       ├── abort.test.ts
│       ├── review-clean-first-iteration.test.ts
│       ├── review-passes-second-iteration.test.ts
│       └── review-iteration-cap.test.ts
├── docs/
│   ├── claude-code-action.md                # already exists
│   ├── superpowers/
│   │   ├── specs/
│   │   │   └── 2026-04-14-shopfloor-design.md
│   │   └── plans/
│   │       └── 2026-04-14-shopfloor-v0.1-implementation.md  # this file
│   └── shopfloor/
│       ├── install.md
│       ├── configuration.md
│       ├── troubleshooting.md
│       ├── architecture.md
│       └── FAQ.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
├── README.md
├── CHANGELOG.md
├── LICENSE
└── CONTRIBUTING.md
```

---

## Conventions across all tasks

- **Language:** TypeScript with strict mode. No implicit any. `"target": "ES2022"`, `"moduleResolution": "bundler"`.
- **Testing:** `vitest` for all unit and e2e tests.
- **Package manager:** `pnpm` (per user CLAUDE.md `pnpm exec tsc` rule). Never `npx` or `pnpx tsc`.
- **Commits:** Conventional Commits. NO co-authors. NEVER add Claude/Opus/Sonnet as co-author. No em dashes in commit messages or code comments.
- **Linter:** Skip a dedicated linter for v0.1. Rely on `tsc --noEmit` and `prettier --check` via CI.
- **Bot identity in commits:** When the plan says a commit happens "during task execution," the executor commits as the git user configured in the worktree. No special author.
- **Never force-push.** Never `--amend` already-pushed commits. Create new commits on failure and fix forward.

---

## Phase 0: Foundations

### Task 0.1: Initialize pnpm workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `vitest.config.ts`
- Modify: (existing) `package.json` (merge into new root)

**Context:** The repository currently has a minimal `package.json` at the root with only metadata. We're going to make this the monorepo root and use pnpm workspaces.

- [ ] **Step 1: Read the existing root `package.json`**

Run: `cat package.json`
Expected: the current metadata-only package.json.

- [ ] **Step 2: Replace root `package.json`** with monorepo root config

Create `package.json`:

```json
{
  "name": "shopfloor",
  "version": "1.0.0-rc.0",
  "private": true,
  "description": "A reusable GitHub Actions workflow that wraps claude-code-action to drive a staged, human-gated AI software delivery pipeline.",
  "author": "Niranjan Rajendran (https://github.com/niranjan94)",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/niranjan94/shopfloor.git"
  },
  "homepage": "https://shopfloor.niranjan.io",
  "bugs": {
    "url": "https://github.com/niranjan94/shopfloor/issues"
  },
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm exec tsc --noEmit",
    "typecheck:all": "pnpm -r typecheck",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "prettier": "^3.2.0",
    "typescript": "^5.4.0",
    "vitest": "^1.3.0"
  },
  "packageManager": "pnpm@9.0.0"
}
```

- [ ] **Step 3: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'router'
  - 'mcp-servers/*'
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
dist
.DS_Store
*.log
coverage
.vitest-cache
*.tsbuildinfo
```

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['router/test/**/*.test.ts', 'mcp-servers/**/test/**/*.test.ts', 'test/e2e/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['router/src/**', 'mcp-servers/shopfloor-mcp/index.ts'],
      exclude: ['**/test/**']
    }
  }
});
```

- [ ] **Step 7: Install root dev deps**

Run: `pnpm install`
Expected: `pnpm-lock.yaml` created. No workspace packages yet so nothing to hoist.

- [ ] **Step 8: Verify typecheck works**

Run: `pnpm typecheck`
Expected: passes (no TypeScript files yet, but `tsc` should find nothing to complain about). If it errors because there are no files, that's fine; we'll fix in later tasks when we add a root `tsconfig.json`.

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore vitest.config.ts pnpm-lock.yaml
git commit -m "chore: initialize pnpm workspace and base tsconfig"
```

---

## Phase 1: Router core (state machine)

### Task 1.1: Scaffold router package

**Files:**
- Create: `router/package.json`
- Create: `router/tsconfig.json`
- Create: `router/src/types.ts` (stub)
- Create: `router/src/index.ts` (stub)

- [ ] **Step 1: Create `router/package.json`**

```json
{
  "name": "@shopfloor/router",
  "version": "1.0.0-rc.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/github": "^6.0.0",
    "@octokit/rest": "^20.0.2"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create `router/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "test"]
}
```

- [ ] **Step 3: Create `router/src/types.ts` stub**

```ts
// Shared types for the Shopfloor router. See docs/superpowers/specs/2026-04-14-shopfloor-design.md section 4 and 6.2.

export type Stage = 'triage' | 'spec' | 'plan' | 'implement' | 'review' | 'none';

export type Complexity = 'quick' | 'medium' | 'large';

export type ShopfloorLabel =
  | 'shopfloor:triaging'
  | 'shopfloor:awaiting-info'
  | 'shopfloor:quick'
  | 'shopfloor:medium'
  | 'shopfloor:large'
  | 'shopfloor:needs-spec'
  | 'shopfloor:spec-in-review'
  | 'shopfloor:needs-plan'
  | 'shopfloor:plan-in-review'
  | 'shopfloor:needs-impl'
  | 'shopfloor:impl-in-review'
  | 'shopfloor:needs-review'
  | 'shopfloor:review-requested-changes'
  | 'shopfloor:review-approved'
  | 'shopfloor:review-stuck'
  | 'shopfloor:skip-review'
  | 'shopfloor:done'
  | 'shopfloor:revise'
  | `shopfloor:failed:${'triage' | 'spec' | 'plan' | 'implement' | 'review'}`;

export interface RouterDecision {
  stage: Stage;
  issueNumber?: number;
  complexity?: Complexity;
  branchName?: string;
  specFilePath?: string;
  planFilePath?: string;
  revisionMode?: boolean;
  reviewIteration?: number;
  implPrNumber?: number;
  reason?: string; // when stage === 'none', why
}

export interface PrMetadata {
  issueNumber: number;
  stage: Exclude<Stage, 'none' | 'triage'>; // stages that produce PRs
  reviewIteration: number; // 0 if absent
}
```

- [ ] **Step 4: Create `router/src/index.ts` stub**

```ts
// Entry point for the Shopfloor router action.
// Reads the GitHub event payload, resolves the stage, writes outputs for the reusable workflow.

import * as core from '@actions/core';

async function main(): Promise<void> {
  core.info('Shopfloor router: not yet implemented');
  core.setOutput('stage', 'none');
  core.setOutput('reason', 'router stub');
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
```

- [ ] **Step 5: Install workspace deps**

Run: `pnpm install`
Expected: `@shopfloor/router` linked in workspace, deps installed.

- [ ] **Step 6: Verify typecheck**

Run: `pnpm --filter @shopfloor/router typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add router/package.json router/tsconfig.json router/src/types.ts router/src/index.ts package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "chore(router): scaffold router package and base types"
```

### Task 1.2: Write state machine tests (failing)

**Files:**
- Create: `router/test/state.test.ts`
- Create: `router/test/fixtures/events/issue-opened-bare.json`
- Create: `router/test/fixtures/events/issue-labeled-needs-spec.json`
- Create: `router/test/fixtures/events/pr-synchronize-impl.json`
- Create: `router/test/fixtures/events/pr-closed-merged-spec.json`
- Create: `router/test/fixtures/events/pr-review-submitted-changes-requested.json`
- Create: `router/test/fixtures/events/issue-closed.json`
- Create: `router/test/fixtures/events/issue-unlabeled-review-stuck.json`

**Context:** We're going to test-drive the pure state machine logic. All decisions are pure functions of `{event, labels, pr_body, linked_pr}`. No GitHub API calls in `state.ts`. The adapter in `github.ts` will feed `state.ts` pre-fetched data.

- [ ] **Step 1: Create `router/test/fixtures/events/issue-opened-bare.json`**

A minimal `issues.opened` event payload shaped like GitHub's webhook schema. Populate only fields the router reads: `action`, `issue.number`, `issue.title`, `issue.body`, `issue.labels` (empty), `issue.state` ("open"), `repository.owner.login`, `repository.name`.

```json
{
  "action": "opened",
  "issue": {
    "number": 42,
    "title": "Add GitHub OAuth login",
    "body": "We need OAuth login via GitHub App.",
    "labels": [],
    "state": "open",
    "pull_request": null
  },
  "repository": {
    "owner": { "login": "niranjan94" },
    "name": "shopfloor"
  }
}
```

- [ ] **Step 2: Create the remaining fixture files**

Populate each with a minimal payload for its named event. Use the same repository block across all. For `pr-synchronize-impl.json`, the PR body must include `Shopfloor-Issue: #42` and `Shopfloor-Stage: implement` and optionally `Shopfloor-Review-Iteration: 0`. Use issue number 42 for all fixtures.

`issue-labeled-needs-spec.json`: action `labeled`, label name `shopfloor:needs-spec`, issue has labels `[shopfloor:large, shopfloor:needs-spec]`.

`pr-synchronize-impl.json`: action `synchronize`, `pull_request` object with number `45`, head ref `shopfloor/impl/42-github-oauth-login`, base ref `main`, body containing the metadata block, labels `[shopfloor:needs-review]`, state `open`, draft `false`, merged `false`.

`pr-closed-merged-spec.json`: action `closed`, pull request merged `true`, body with `Shopfloor-Stage: spec` and `Shopfloor-Issue: #42`, labels `[shopfloor:spec-in-review]`.

`pr-review-submitted-changes-requested.json`: action `submitted`, review object `state: "changes_requested"`, pull request with `Shopfloor-Stage: implement` in body.

`issue-closed.json`: action `closed`, issue state `closed`, labels `[shopfloor:needs-plan]`.

`issue-unlabeled-review-stuck.json`: action `unlabeled`, label name `shopfloor:review-stuck`, issue labels remaining `[shopfloor:needs-impl]`.

- [ ] **Step 3: Create `router/test/state.test.ts` with failing tests**

```ts
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveStage } from '../src/state';
import type { StateContext } from '../src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', 'events', `${name}.json`), 'utf-8'));
}

function ctx(eventName: string, fixtureName: string, overrides: Partial<StateContext> = {}): StateContext {
  return {
    eventName,
    payload: loadFixture(fixtureName) as StateContext['payload'],
    ...overrides
  };
}

describe('resolveStage', () => {
  test('new issue with no labels → triage', () => {
    const decision = resolveStage(ctx('issues', 'issue-opened-bare'));
    expect(decision.stage).toBe('triage');
    expect(decision.issueNumber).toBe(42);
  });

  test('issue labeled shopfloor:needs-spec → spec', () => {
    const decision = resolveStage(ctx('issues', 'issue-labeled-needs-spec'));
    expect(decision.stage).toBe('spec');
    expect(decision.issueNumber).toBe(42);
  });

  test('synchronize on impl PR → review', () => {
    const decision = resolveStage(ctx('pull_request', 'pr-synchronize-impl'));
    expect(decision.stage).toBe('review');
    expect(decision.implPrNumber).toBe(45);
    expect(decision.reviewIteration).toBe(0);
  });

  test('spec PR merged → none (with reason that triggers next-stage label flip)', () => {
    const decision = resolveStage(ctx('pull_request', 'pr-closed-merged-spec'));
    expect(decision.stage).toBe('none');
    expect(decision.reason).toBe('pr_merged_spec_triggered_label_flip');
  });

  test('changes_requested review on impl PR → implement (revision mode)', () => {
    const decision = resolveStage(ctx('pull_request_review', 'pr-review-submitted-changes-requested'));
    expect(decision.stage).toBe('implement');
    expect(decision.revisionMode).toBe(true);
  });

  test('closed issue → none, reason aborted', () => {
    const decision = resolveStage(ctx('issues', 'issue-closed'));
    expect(decision.stage).toBe('none');
    expect(decision.reason).toBe('issue_closed_aborted');
  });

  test('review-stuck label removed → review', () => {
    const decision = resolveStage(ctx('issues', 'issue-unlabeled-review-stuck'));
    expect(decision.stage).toBe('review');
  });
});
```

- [ ] **Step 4: Run tests (expect failure)**

Run: `pnpm test router/test/state.test.ts`
Expected: FAIL. Cannot find module `../src/state`.

- [ ] **Step 5: Commit the failing tests**

```bash
git add router/test/fixtures router/test/state.test.ts
git commit -m "test(router): add failing state machine tests with fixture events"
```

### Task 1.3: Implement state machine

**Files:**
- Modify: `router/src/types.ts` (add `StateContext`)
- Create: `router/src/state.ts`

- [ ] **Step 1: Extend `router/src/types.ts` with `StateContext` and payload types**

Add to the end of `router/src/types.ts`:

```ts
export interface IssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    state: 'open' | 'closed';
    pull_request?: unknown | null;
  };
  label?: { name: string };
  repository: { owner: { login: string }; name: string };
}

export interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    body: string | null;
    state: 'open' | 'closed';
    draft: boolean;
    merged: boolean;
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    labels: Array<{ name: string }>;
  };
  repository: { owner: { login: string }; name: string };
}

export interface PullRequestReviewPayload {
  action: string;
  review: {
    state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
    body: string | null;
    user: { login: string };
  };
  pull_request: PullRequestPayload['pull_request'];
  repository: { owner: { login: string }; name: string };
}

export type EventPayload = IssuePayload | PullRequestPayload | PullRequestReviewPayload;

export interface StateContext {
  eventName: string;
  payload: EventPayload;
  /** Optional: the login of the Shopfloor bot, used to distinguish agent reviews from human reviews. */
  shopfloorBotLogin?: string;
}
```

- [ ] **Step 2: Create `router/src/state.ts` with the full state machine**

Implement `resolveStage(ctx: StateContext): RouterDecision`. The logic must match spec sections 4 and 5.5's trigger subsection.

```ts
// Pure state machine for the Shopfloor router. No I/O. See spec sections 4, 5.5, and 6.2.

import type {
  Complexity,
  EventPayload,
  IssuePayload,
  PullRequestPayload,
  PullRequestReviewPayload,
  PrMetadata,
  RouterDecision,
  StateContext
} from './types';

const STATE_LABELS = new Set<string>([
  'shopfloor:triaging',
  'shopfloor:awaiting-info',
  'shopfloor:needs-spec',
  'shopfloor:spec-in-review',
  'shopfloor:needs-plan',
  'shopfloor:plan-in-review',
  'shopfloor:needs-impl',
  'shopfloor:impl-in-review',
  'shopfloor:needs-review',
  'shopfloor:review-requested-changes',
  'shopfloor:review-approved',
  'shopfloor:review-stuck',
  'shopfloor:done'
]);

const COMPLEXITY_LABELS: Record<string, Complexity> = {
  'shopfloor:quick': 'quick',
  'shopfloor:medium': 'medium',
  'shopfloor:large': 'large'
};

export function resolveStage(ctx: StateContext): RouterDecision {
  switch (ctx.eventName) {
    case 'issues':
      return resolveIssueEvent(ctx.payload as IssuePayload);
    case 'issue_comment':
      return { stage: 'none', reason: 'issue_comment_no_action_v0_1' };
    case 'pull_request':
      return resolvePullRequestEvent(ctx.payload as PullRequestPayload);
    case 'pull_request_review':
      return resolvePullRequestReviewEvent(ctx.payload as PullRequestReviewPayload, ctx.shopfloorBotLogin);
    case 'pull_request_review_comment':
      return { stage: 'none', reason: 'review_comment_not_a_trigger_v0_1' };
    default:
      return { stage: 'none', reason: `unhandled_event:${ctx.eventName}` };
  }
}

function labelNames(payload: { labels?: Array<{ name: string }> } | { issue: { labels: Array<{ name: string }> } } | { pull_request: { labels: Array<{ name: string }> } }): Set<string> {
  if ('issue' in payload) return new Set(payload.issue.labels.map((l) => l.name));
  if ('pull_request' in payload) return new Set(payload.pull_request.labels.map((l) => l.name));
  return new Set((payload as { labels?: Array<{ name: string }> }).labels?.map((l) => l.name) ?? []);
}

function stateLabel(labels: Set<string>): string | null {
  for (const l of labels) if (STATE_LABELS.has(l)) return l;
  return null;
}

function complexityOf(labels: Set<string>): Complexity | undefined {
  for (const [l, c] of Object.entries(COMPLEXITY_LABELS)) if (labels.has(l)) return c;
  return undefined;
}

function parsePrMetadata(body: string | null): PrMetadata | null {
  if (!body) return null;
  const issueMatch = body.match(/Shopfloor-Issue:\s*#(\d+)/);
  const stageMatch = body.match(/Shopfloor-Stage:\s*(spec|plan|implement|review)/);
  const iterMatch = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  if (!issueMatch || !stageMatch) return null;
  return {
    issueNumber: Number(issueMatch[1]),
    stage: stageMatch[1] as PrMetadata['stage'],
    reviewIteration: iterMatch ? Number(iterMatch[1]) : 0
  };
}

function branchSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .slice(0, 40);
}

function resolveIssueEvent(payload: IssuePayload): RouterDecision {
  const labels = labelNames(payload);
  const issueNumber = payload.issue.number;

  // Universal abort: closed issues do not advance.
  if (payload.issue.state === 'closed') {
    return { stage: 'none', issueNumber, reason: 'issue_closed_aborted' };
  }

  // Pull-request-on-issue-event special case: some events send the issue payload for PRs.
  if (payload.issue.pull_request) {
    return { stage: 'none', reason: 'issue_event_is_actually_a_pr' };
  }

  // Review-stuck unlabel: dispatch review on the associated impl PR.
  if (payload.action === 'unlabeled' && payload.label?.name === 'shopfloor:review-stuck') {
    return { stage: 'review', issueNumber, reason: 'review_stuck_removed_force_review' };
  }

  // Bare new issue → triage.
  if (payload.action === 'opened' && stateLabel(labels) === null) {
    return { stage: 'triage', issueNumber };
  }

  // Awaiting-info removed → re-triage.
  if (payload.action === 'unlabeled' && payload.label?.name === 'shopfloor:awaiting-info') {
    return { stage: 'triage', issueNumber, reason: 're_triage_after_clarification' };
  }

  // Needs-spec → spec.
  if (labels.has('shopfloor:needs-spec')) {
    return {
      stage: 'spec',
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/spec/${issueNumber}-${branchSlug(payload.issue.title)}`
    };
  }

  // Needs-plan → plan.
  if (labels.has('shopfloor:needs-plan')) {
    return {
      stage: 'plan',
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/plan/${issueNumber}-${branchSlug(payload.issue.title)}`,
      specFilePath: `docs/shopfloor/specs/${issueNumber}-${branchSlug(payload.issue.title)}.md`
    };
  }

  // Needs-impl → implement.
  if (labels.has('shopfloor:needs-impl')) {
    return {
      stage: 'implement',
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/impl/${issueNumber}-${branchSlug(payload.issue.title)}`,
      specFilePath: `docs/shopfloor/specs/${issueNumber}-${branchSlug(payload.issue.title)}.md`,
      planFilePath: `docs/shopfloor/plans/${issueNumber}-${branchSlug(payload.issue.title)}.md`
    };
  }

  // Awaiting-info labeled → no action; pipeline is paused.
  if (labels.has('shopfloor:awaiting-info')) {
    return { stage: 'none', issueNumber, reason: 'awaiting_info_paused' };
  }

  return { stage: 'none', issueNumber, reason: 'no_matching_label_rule' };
}

function resolvePullRequestEvent(payload: PullRequestPayload): RouterDecision {
  const pr = payload.pull_request;
  const meta = parsePrMetadata(pr.body);
  if (!meta) return { stage: 'none', reason: 'pr_has_no_shopfloor_metadata' };

  // Merged PR → side effect (label flip) but no stage dispatch.
  if (payload.action === 'closed' && pr.merged) {
    return { stage: 'none', reason: `pr_merged_${meta.stage}_triggered_label_flip` };
  }

  // Closed (not merged) → ignore.
  if (payload.action === 'closed') {
    return { stage: 'none', reason: 'pr_closed_not_merged_ignored' };
  }

  // Synchronize on impl PR → review stage.
  if (payload.action === 'synchronize' && meta.stage === 'implement') {
    const labels = labelNames(payload);
    if (labels.has('shopfloor:skip-review')) {
      return { stage: 'none', reason: 'skip_review_label_present' };
    }
    if (pr.draft) return { stage: 'none', reason: 'pr_is_draft' };
    if (pr.state === 'closed') return { stage: 'none', reason: 'pr_is_closed' };
    return {
      stage: 'review',
      issueNumber: meta.issueNumber,
      implPrNumber: pr.number,
      reviewIteration: meta.reviewIteration
    };
  }

  // Other PR events (opened, labeled, etc.) on non-impl stages are no-ops for routing.
  return { stage: 'none', reason: `pr_action_${payload.action}_on_${meta.stage}_no_action` };
}

function resolvePullRequestReviewEvent(
  payload: PullRequestReviewPayload,
  shopfloorBotLogin?: string
): RouterDecision {
  const pr = payload.pull_request;
  const meta = parsePrMetadata(pr.body);
  if (!meta) return { stage: 'none', reason: 'pr_has_no_shopfloor_metadata' };

  if (payload.action !== 'submitted') {
    return { stage: 'none', reason: `review_action_${payload.action}_ignored` };
  }

  if (payload.review.state !== 'changes_requested') {
    return { stage: 'none', reason: `review_state_${payload.review.state}_no_action` };
  }

  // Distinguish agent review (from Shopfloor bot) from human review.
  // Both re-trigger the stage agent, but only human reviews reach here for non-impl stages.
  const isShopfloorReview = shopfloorBotLogin && payload.review.user.login === shopfloorBotLogin;

  if (meta.stage === 'implement') {
    return {
      stage: 'implement',
      issueNumber: meta.issueNumber,
      revisionMode: true,
      reviewIteration: meta.reviewIteration,
      reason: isShopfloorReview ? 'agent_requested_changes' : 'human_requested_changes'
    };
  }

  // spec, plan PRs: revision mode retriggers that stage.
  return {
    stage: meta.stage as RouterDecision['stage'],
    issueNumber: meta.issueNumber,
    revisionMode: true
  };
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm test router/test/state.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @shopfloor/router typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add router/src/state.ts router/src/types.ts
git commit -m "feat(router): implement pure state machine for all stage transitions"
```

### Task 1.4: Extend state machine tests for edge cases

**Files:**
- Modify: `router/test/state.test.ts`
- Create: `router/test/fixtures/events/issue-unlabeled-awaiting-info.json`
- Create: `router/test/fixtures/events/issue-labeled-needs-plan-no-title.json`
- Create: `router/test/fixtures/events/pr-synchronize-impl-with-skip-review.json`
- Create: `router/test/fixtures/events/pr-synchronize-impl-draft.json`
- Create: `router/test/fixtures/events/pr-review-approved.json`
- Create: `router/test/fixtures/events/pr-review-spec-changes-requested.json`

**Context:** We want full branch coverage on `state.ts`, including the skip paths, draft PR handling, non-changes_requested reviews, and the spec/plan revision trigger.

- [ ] **Step 1: Add fixtures for each edge case**

For each fixture name, populate minimally with enough fields to exercise the code path. Use issue #42 consistently.

- [ ] **Step 2: Add tests for each edge case**

Add these tests to the existing `describe` block in `state.test.ts`:

```ts
test('awaiting-info label removed → re-triage', () => {
  const decision = resolveStage(ctx('issues', 'issue-unlabeled-awaiting-info'));
  expect(decision.stage).toBe('triage');
  expect(decision.reason).toBe('re_triage_after_clarification');
});

test('impl PR with skip-review label → none', () => {
  const decision = resolveStage(ctx('pull_request', 'pr-synchronize-impl-with-skip-review'));
  expect(decision.stage).toBe('none');
  expect(decision.reason).toBe('skip_review_label_present');
});

test('draft impl PR → none', () => {
  const decision = resolveStage(ctx('pull_request', 'pr-synchronize-impl-draft'));
  expect(decision.stage).toBe('none');
  expect(decision.reason).toBe('pr_is_draft');
});

test('approved review → none', () => {
  const decision = resolveStage(ctx('pull_request_review', 'pr-review-approved'));
  expect(decision.stage).toBe('none');
});

test('spec PR with changes_requested → spec (revision mode)', () => {
  const decision = resolveStage(ctx('pull_request_review', 'pr-review-spec-changes-requested'));
  expect(decision.stage).toBe('spec');
  expect(decision.revisionMode).toBe(true);
});

test('branch slug derivation handles special characters', () => {
  const decision = resolveStage(
    ctx('issues', 'issue-labeled-needs-plan-no-title') // title: "Fix: can't log in!"
  );
  expect(decision.stage).toBe('plan');
  expect(decision.branchName).toBe('shopfloor/plan/42-fix-cant-log-in');
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm test router/test/state.test.ts`
Expected: all tests pass (some may fail on first run if slug derivation differs; iterate on `branchSlug` until it matches).

- [ ] **Step 4: Commit**

```bash
git add router/test
git commit -m "test(router): add state machine edge-case tests"
```

### Task 1.5: Write GitHub adapter tests (failing)

**Files:**
- Create: `router/test/github.test.ts`

**Context:** The `github.ts` adapter is a thin wrapper around octokit. We test it by injecting a mocked octokit instance and verifying the shape of API calls.

- [ ] **Step 1: Create `router/test/github.test.ts`**

```ts
import { describe, expect, test, vi } from 'vitest';
import { GitHubAdapter } from '../src/github';
import type { Octokit } from '@octokit/rest';

function makeMockOctokit(overrides: Record<string, unknown> = {}): Octokit {
  return {
    rest: {
      issues: {
        addLabels: vi.fn().mockResolvedValue({ data: [] }),
        removeLabel: vi.fn().mockResolvedValue({ data: [] }),
        createComment: vi.fn().mockResolvedValue({ data: { id: 999 } }),
        updateComment: vi.fn().mockResolvedValue({ data: {} }),
        createLabel: vi.fn().mockResolvedValue({ data: {} }),
        listLabelsForRepo: vi.fn().mockResolvedValue({ data: [] }),
        update: vi.fn().mockResolvedValue({ data: {} })
      },
      pulls: {
        create: vi.fn().mockResolvedValue({ data: { number: 100, html_url: 'x' } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        createReview: vi.fn().mockResolvedValue({ data: { id: 1 } }),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
        get: vi.fn().mockResolvedValue({ data: {} })
      },
      repos: {
        createCommitStatus: vi.fn().mockResolvedValue({ data: {} }),
        getBranch: vi.fn().mockResolvedValue({ data: {} })
      },
      ...overrides
    }
  } as unknown as Octokit;
}

describe('GitHubAdapter', () => {
  const repo = { owner: 'niranjan94', repo: 'shopfloor' };

  test('addLabel calls issues.addLabels with correct shape', async () => {
    const octokit = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    await adapter.addLabel(42, 'shopfloor:triaging');
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'niranjan94',
      repo: 'shopfloor',
      issue_number: 42,
      labels: ['shopfloor:triaging']
    });
  });

  test('removeLabel ignores 404s', async () => {
    const octokit = makeMockOctokit({
      issues: { ...makeMockOctokit().rest.issues, removeLabel: vi.fn().mockRejectedValue({ status: 404 }) }
    });
    const adapter = new GitHubAdapter(octokit, repo);
    await expect(adapter.removeLabel(42, 'shopfloor:triaging')).resolves.toBeUndefined();
  });

  test('postComment returns comment id', async () => {
    const octokit = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    const id = await adapter.postIssueComment(42, 'hello');
    expect(id).toBe(999);
  });

  test('openStagePr merges title, body, metadata block', async () => {
    const octokit = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    await adapter.openStagePr({
      base: 'main',
      head: 'shopfloor/spec/42-x',
      title: 'Spec for #42',
      body: 'Body text.',
      stage: 'spec',
      issueNumber: 42
    });
    const call = (octokit.rest.pulls.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.body).toMatch(/Shopfloor-Issue: #42/);
    expect(call.body).toMatch(/Shopfloor-Stage: spec/);
    expect(call.body).toMatch(/Body text\./);
  });

  test('setCommitStatus calls createCommitStatus with context shopfloor/review', async () => {
    const octokit = makeMockOctokit();
    const adapter = new GitHubAdapter(octokit, repo);
    await adapter.setReviewStatus('abc123', 'pending', 'Running...');
    expect(octokit.rest.repos.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'niranjan94',
        repo: 'shopfloor',
        sha: 'abc123',
        state: 'pending',
        context: 'shopfloor/review',
        description: 'Running...'
      })
    );
  });
});
```

- [ ] **Step 2: Run tests (expect failure)**

Run: `pnpm test router/test/github.test.ts`
Expected: FAIL. Cannot find module `../src/github`.

- [ ] **Step 3: Commit**

```bash
git add router/test/github.test.ts
git commit -m "test(router): add failing GitHub adapter tests"
```

### Task 1.6: Implement GitHub adapter

**Files:**
- Create: `router/src/github.ts`

- [ ] **Step 1: Add `OctokitLike` structural interface to `types.ts`**

Because `@actions/github`'s `getOctokit` returns a different type from `@octokit/rest`'s `Octokit`, but the runtime shape is identical for the methods we use, we declare a minimal structural interface that both satisfy. This avoids casts at the call site.

Append to `router/src/types.ts`:

```ts
// Minimal structural type for the octokit-like object both @octokit/rest and
// @actions/github's getOctokit return. Only lists methods GitHubAdapter uses.
export interface OctokitLike {
  rest: {
    issues: {
      addLabels(params: { owner: string; repo: string; issue_number: number; labels: string[] }): Promise<unknown>;
      removeLabel(params: { owner: string; repo: string; issue_number: number; name: string }): Promise<unknown>;
      createComment(params: { owner: string; repo: string; issue_number: number; body: string }): Promise<{ data: { id: number } }>;
      updateComment(params: { owner: string; repo: string; comment_id: number; body: string }): Promise<unknown>;
      createLabel(params: { owner: string; repo: string; name: string; color: string; description?: string }): Promise<unknown>;
      listLabelsForRepo(params: { owner: string; repo: string; per_page?: number }): Promise<{ data: Array<{ name: string }> }>;
      update(params: { owner: string; repo: string; issue_number: number; state?: 'open' | 'closed' }): Promise<unknown>;
      get(params: { owner: string; repo: string; issue_number: number }): Promise<{ data: { labels: unknown; state: string } }>;
    };
    pulls: {
      create(params: { owner: string; repo: string; base: string; head: string; title: string; body: string; draft?: boolean }): Promise<{ data: { number: number; html_url: string } }>;
      update(params: { owner: string; repo: string; pull_number: number; body?: string; title?: string }): Promise<unknown>;
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{ data: unknown }>;
      listFiles(params: { owner: string; repo: string; pull_number: number; per_page?: number; page?: number }): Promise<{ data: Array<{ filename: string }> }>;
      createReview(params: { owner: string; repo: string; pull_number: number; commit_id?: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; comments?: Array<unknown> }): Promise<unknown>;
      listReviews(params: { owner: string; repo: string; pull_number: number; per_page?: number }): Promise<{ data: Array<{ id: number; user: unknown; body: string | null; commit_id: string }> }>;
    };
    repos: {
      createCommitStatus(params: { owner: string; repo: string; sha: string; state: 'pending' | 'success' | 'failure' | 'error'; context: string; description: string; target_url?: string }): Promise<unknown>;
    };
  };
}
```

- [ ] **Step 2: Implement `router/src/github.ts`**

Implement `GitHubAdapter` with methods used by the tests plus the ones helper actions will need. Keep it thin: each method maps to one or two octokit calls. The constructor takes an `OctokitLike` instead of a concrete `Octokit` type, so both `@octokit/rest` and `@actions/github`'s `getOctokit` return value satisfy it.

```ts
import type { OctokitLike } from './types';

export interface RepoContext {
  owner: string;
  repo: string;
}

export interface OpenStagePrInput {
  base: string;
  head: string;
  title: string;
  body: string;
  stage: 'spec' | 'plan' | 'implement';
  issueNumber: number;
  reviewIteration?: number;
  draft?: boolean;
}

export interface ReviewComment {
  path: string;
  body: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
}

export class GitHubAdapter {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly repo: RepoContext
  ) {}

  async addLabel(issueNumber: number, label: string): Promise<void> {
    await this.octokit.rest.issues.addLabels({
      ...this.repo,
      issue_number: issueNumber,
      labels: [label]
    });
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        ...this.repo,
        issue_number: issueNumber,
        name: label
      });
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }

  async postIssueComment(issueNumber: number, body: string): Promise<number> {
    const res = await this.octokit.rest.issues.createComment({
      ...this.repo,
      issue_number: issueNumber,
      body
    });
    return res.data.id;
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      ...this.repo,
      comment_id: commentId,
      body
    });
  }

  async openStagePr(input: OpenStagePrInput): Promise<{ number: number; url: string }> {
    const metadata = [
      '',
      '---',
      `Shopfloor-Issue: #${input.issueNumber}`,
      `Shopfloor-Stage: ${input.stage}`,
      input.stage === 'implement' ? `Shopfloor-Review-Iteration: ${input.reviewIteration ?? 0}` : null
    ]
      .filter(Boolean)
      .join('\n');

    const body = `${input.body}\n${metadata}\n`;
    const res = await this.octokit.rest.pulls.create({
      ...this.repo,
      base: input.base,
      head: input.head,
      title: input.title,
      body,
      draft: input.draft ?? false
    });
    return { number: res.data.number, url: res.data.html_url };
  }

  async updatePrBody(prNumber: number, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({
      ...this.repo,
      pull_number: prNumber,
      body
    });
  }

  async postReview(params: {
    prNumber: number;
    commitSha: string;
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    body: string;
    comments: ReviewComment[];
  }): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      ...this.repo,
      pull_number: params.prNumber,
      commit_id: params.commitSha,
      event: params.event,
      body: params.body,
      comments: params.comments
    });
  }

  async setReviewStatus(
    sha: string,
    state: 'pending' | 'success' | 'failure' | 'error',
    description: string,
    targetUrl?: string
  ): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({
      ...this.repo,
      sha,
      state,
      context: 'shopfloor/review',
      description: description.slice(0, 140),
      target_url: targetUrl
    });
  }

  async listRepoLabels(): Promise<string[]> {
    const res = await this.octokit.rest.issues.listLabelsForRepo({
      ...this.repo,
      per_page: 100
    });
    return res.data.map((l) => l.name);
  }

  async createLabel(name: string, color: string, description?: string): Promise<void> {
    try {
      await this.octokit.rest.issues.createLabel({
        ...this.repo,
        name,
        color,
        description
      });
    } catch (err: unknown) {
      if ((err as { status?: number }).status === 422) return; // label already exists
      throw err;
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.octokit.rest.issues.update({
      ...this.repo,
      issue_number: issueNumber,
      state: 'closed'
    });
  }

  async getPrReviewsAtSha(prNumber: number, sha: string): Promise<Array<{ id: number; user: { login: string } | null; body: string }>> {
    const res = await this.octokit.rest.pulls.listReviews({
      ...this.repo,
      pull_number: prNumber,
      per_page: 100
    });
    return res.data
      .filter((r) => r.commit_id === sha)
      .map((r) => ({ id: r.id, user: r.user as { login: string } | null, body: r.body ?? '' }));
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm test router/test/github.test.ts`
Expected: all pass.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @shopfloor/router typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add router/src/github.ts
git commit -m "feat(router): add GitHub adapter wrapping octokit for state mutations"
```

---

## Phase 2: Router helper actions

Each helper is a small composite or JS action under `router/<name>/`. For each helper we:

1. Define the action interface (`action.yml`).
2. Implement the helper function in `router/src/helpers/<name>.ts`.
3. Write tests against mocked octokit / stubbed events.

We share `router/src/index.ts` as the main router entry point and give each helper its own `action.yml` that points to a thin wrapper calling the corresponding helper function.

**Bundling strategy:** To avoid the complexity of bundling per-action, we ship one built `dist/index.js` for the whole router package and each `action.yml` passes a different subcommand via `INPUT_SHOPFLOOR_HELPER` env var. The main entry point dispatches.

### Task 2.1: Main router entry dispatcher

**Files:**
- Modify: `router/src/index.ts`
- Create: `router/action.yml`

- [ ] **Step 1: Rewrite `router/src/index.ts` as a dispatcher**

```ts
import * as core from '@actions/core';
import { getOctokit, context } from '@actions/github';
import { resolveStage } from './state';
import { GitHubAdapter } from './github';

import { runBootstrapLabels } from './helpers/bootstrap-labels';
import { runOpenStagePr } from './helpers/open-stage-pr';
import { runAdvanceState } from './helpers/advance-state';
import { runReportFailure } from './helpers/report-failure';
import { runHandleMerge } from './helpers/handle-merge';
import { runCreateProgressComment } from './helpers/create-progress-comment';
import { runFinalizeProgressComment } from './helpers/finalize-progress-comment';
import { runCheckReviewSkip } from './helpers/check-review-skip';
import { runAggregateReview } from './helpers/aggregate-review';

async function main(): Promise<void> {
  const helper = core.getInput('helper', { required: false }) || 'route';
  const token = core.getInput('github_token', { required: true });
  const octokit = getOctokit(token);
  const adapter = new GitHubAdapter(octokit as unknown as import('./types').OctokitLike, {
    owner: context.repo.owner,
    repo: context.repo.repo
  });
  // The single cast above bridges @actions/github's getOctokit return type to our
  // structural OctokitLike interface. Both expose the same runtime surface for the
  // methods we call.

  switch (helper) {
    case 'route': {
      const decision = resolveStage({ eventName: context.eventName, payload: context.payload as never });
      core.setOutput('stage', decision.stage);
      if (decision.issueNumber !== undefined) core.setOutput('issue_number', String(decision.issueNumber));
      if (decision.complexity) core.setOutput('complexity', decision.complexity);
      if (decision.branchName) core.setOutput('branch_name', decision.branchName);
      if (decision.specFilePath) core.setOutput('spec_file_path', decision.specFilePath);
      if (decision.planFilePath) core.setOutput('plan_file_path', decision.planFilePath);
      if (decision.revisionMode !== undefined) core.setOutput('revision_mode', String(decision.revisionMode));
      if (decision.reviewIteration !== undefined) core.setOutput('review_iteration', String(decision.reviewIteration));
      if (decision.implPrNumber !== undefined) core.setOutput('impl_pr_number', String(decision.implPrNumber));
      if (decision.reason) core.setOutput('reason', decision.reason);
      return;
    }
    case 'bootstrap-labels':
      return runBootstrapLabels(adapter);
    case 'open-stage-pr':
      return runOpenStagePr(adapter);
    case 'advance-state':
      return runAdvanceState(adapter);
    case 'report-failure':
      return runReportFailure(adapter);
    case 'handle-merge':
      return runHandleMerge(adapter);
    case 'create-progress-comment':
      return runCreateProgressComment(adapter);
    case 'finalize-progress-comment':
      return runFinalizeProgressComment(adapter);
    case 'check-review-skip':
      return runCheckReviewSkip(adapter);
    case 'aggregate-review':
      return runAggregateReview(adapter);
    default:
      core.setFailed(`Unknown helper: ${helper}`);
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
```

**NOTE:** the `GitHubAdapter` expects an `Octokit` from `@octokit/rest` but `@actions/github`'s `getOctokit` returns a different type with the same runtime shape. Either cast or refactor `GitHubAdapter` to accept `ReturnType<typeof getOctokit>`. For simplicity, adapt the constructor to accept `any`-ish and TypeScript-cast at the boundary. During implementation, type the constructor with a minimal interface that includes just the methods used, then pass either octokit type.

- [ ] **Step 2: Create `router/action.yml`**

```yaml
name: Shopfloor Router
description: Core dispatcher for the Shopfloor reusable workflow. Resolves the stage or invokes a helper.
inputs:
  helper:
    description: 'Which helper to run: route (default), bootstrap-labels, open-stage-pr, advance-state, report-failure, handle-merge, create-progress-comment, finalize-progress-comment, check-review-skip, aggregate-review'
    required: false
    default: route
  github_token:
    description: GitHub token
    required: true
outputs:
  stage: { description: 'Resolved stage' }
  issue_number: { description: 'Issue number in context' }
  complexity: { description: 'Complexity label, if set' }
  branch_name: { description: 'Branch name to create/use' }
  spec_file_path: { description: 'Spec file path' }
  plan_file_path: { description: 'Plan file path' }
  revision_mode: { description: 'Whether this is a revision run' }
  review_iteration: { description: 'Current review iteration counter' }
  impl_pr_number: { description: 'Implementation PR number, when relevant' }
  reason: { description: 'Why the router returned this decision' }
runs:
  using: node20
  main: dist/index.js
```

- [ ] **Step 3: Create all helper stub files** so the imports compile

Create `router/src/helpers/bootstrap-labels.ts`:

```ts
import type { GitHubAdapter } from '../github';
export async function runBootstrapLabels(_adapter: GitHubAdapter): Promise<void> {
  throw new Error('Not implemented');
}
```

Repeat for each of the 9 helpers, each exporting its `run<Name>` function as a stub that throws.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @shopfloor/router typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add router/src router/action.yml
git commit -m "feat(router): add main dispatcher and helper stubs"
```

### Task 2.2: Bootstrap labels helper (test + implement)

**Files:**
- Create: `router/test/helpers/bootstrap-labels.test.ts`
- Modify: `router/src/helpers/bootstrap-labels.ts`
- Create: `router/bootstrap-labels/action.yml`

**Context:** Ensures every `shopfloor:*` label exists on the repo. Idempotent. Runs inside the router's `route` step or as its own helper on demand.

- [ ] **Step 1: Write failing test**

Create `router/test/helpers/bootstrap-labels.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { GitHubAdapter } from '../../src/github';
import { bootstrapLabels } from '../../src/helpers/bootstrap-labels';

describe('bootstrapLabels', () => {
  test('creates every missing label with correct color', async () => {
    const listLabelsForRepo = vi.fn().mockResolvedValue({ data: [{ name: 'shopfloor:triaging' }] });
    const createLabel = vi.fn().mockResolvedValue({ data: {} });
    const adapter = new GitHubAdapter(
      { rest: { issues: { listLabelsForRepo, createLabel } } } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
      { owner: 'o', repo: 'r' }
    );
    const created = await bootstrapLabels(adapter);
    expect(created.length).toBeGreaterThanOrEqual(15); // everything except shopfloor:triaging
    expect(createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'o', repo: 'r', name: 'shopfloor:done', color: expect.any(String) })
    );
    expect(created).not.toContain('shopfloor:triaging');
  });
});
```

- [ ] **Step 2: Run test (fail)**

Run: `pnpm test router/test/helpers/bootstrap-labels.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `bootstrapLabels`**

Rewrite `router/src/helpers/bootstrap-labels.ts`:

```ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

const LABEL_DEFS: Array<{ name: string; color: string; description: string }> = [
  { name: 'shopfloor:triaging', color: 'fbca04', description: 'Shopfloor triage agent is evaluating this issue.' },
  { name: 'shopfloor:awaiting-info', color: 'd93f0b', description: 'Shopfloor is waiting for the issue author to answer clarifying questions.' },
  { name: 'shopfloor:quick', color: '0e8a16', description: 'Classified as a quick fix (straight to implementation).' },
  { name: 'shopfloor:medium', color: '1d76db', description: 'Classified as medium (skip spec, go to plan).' },
  { name: 'shopfloor:large', color: '5319e7', description: 'Classified as large (full spec, plan, impl flow).' },
  { name: 'shopfloor:needs-spec', color: 'a2eeef', description: 'Ready for the spec agent.' },
  { name: 'shopfloor:spec-in-review', color: 'a2eeef', description: 'Spec PR awaiting human review.' },
  { name: 'shopfloor:needs-plan', color: 'a2eeef', description: 'Ready for the plan agent.' },
  { name: 'shopfloor:plan-in-review', color: 'a2eeef', description: 'Plan PR awaiting human review.' },
  { name: 'shopfloor:needs-impl', color: 'a2eeef', description: 'Ready for the implementation agent.' },
  { name: 'shopfloor:needs-review', color: 'a2eeef', description: 'Implementation complete, agent review queued.' },
  { name: 'shopfloor:review-requested-changes', color: 'e99695', description: 'Agent review requested changes; impl will re-run.' },
  { name: 'shopfloor:review-approved', color: '0e8a16', description: 'Agent review passed; ready for human merge.' },
  { name: 'shopfloor:review-stuck', color: 'b60205', description: 'Review loop exceeded iteration cap; needs human.' },
  { name: 'shopfloor:impl-in-review', color: 'a2eeef', description: 'Impl PR awaiting human review (skip-review case).' },
  { name: 'shopfloor:skip-review', color: 'ededed', description: 'Bypass the agent review stage for this ticket.' },
  { name: 'shopfloor:done', color: '0e8a16', description: 'Implementation merged. Pipeline complete.' },
  { name: 'shopfloor:revise', color: 'ededed', description: 'Manual trigger to re-run the current stage.' },
  { name: 'shopfloor:failed:triage', color: 'b60205', description: 'Triage stage failed.' },
  { name: 'shopfloor:failed:spec', color: 'b60205', description: 'Spec stage failed.' },
  { name: 'shopfloor:failed:plan', color: 'b60205', description: 'Plan stage failed.' },
  { name: 'shopfloor:failed:implement', color: 'b60205', description: 'Implementation stage failed.' },
  { name: 'shopfloor:failed:review', color: 'b60205', description: 'Review stage failed.' }
];

export async function bootstrapLabels(adapter: GitHubAdapter): Promise<string[]> {
  const existing = new Set(await adapter.listRepoLabels());
  const created: string[] = [];
  for (const def of LABEL_DEFS) {
    if (existing.has(def.name)) continue;
    await adapter.createLabel(def.name, def.color, def.description);
    created.push(def.name);
  }
  return created;
}

export async function runBootstrapLabels(adapter: GitHubAdapter): Promise<void> {
  const created = await bootstrapLabels(adapter);
  core.info(`Shopfloor bootstrap: created ${created.length} missing labels`);
  core.setOutput('created_labels', JSON.stringify(created));
}
```

- [ ] **Step 4: Run test (pass)**

Run: `pnpm test router/test/helpers/bootstrap-labels.test.ts`
Expected: pass.

- [ ] **Step 5: Create `router/bootstrap-labels/action.yml`**

```yaml
name: Shopfloor Bootstrap Labels
description: Idempotently creates any missing shopfloor:* labels on the repository.
inputs:
  github_token:
    description: GitHub token
    required: true
outputs:
  created_labels:
    description: 'JSON array of label names that were created'
runs:
  using: node20
  main: ../dist/index.js
```

The `main` points to the shared `dist/index.js` which reads the `INPUT_HELPER` automatically when the caller sets it, but because composite actions can't set inputs on nested actions directly, we invoke via `env.INPUT_HELPER=bootstrap-labels`. Use a wrapper composite that sets `INPUT_HELPER` and then runs the router action.

**Simplification:** Instead of 9 separate `action.yml` files, we keep only `router/action.yml` (the primary one) and have the reusable workflow call it with different `helper:` inputs. Drop the nested action directories for v0.1. This simplifies bundling dramatically. The spec's "separate helper actions" shape is preserved logically through the `helper:` input.

Revise: delete `router/bootstrap-labels/action.yml`, and instead make every caller in the reusable workflow invoke the main router action with `helper: bootstrap-labels`.

- [ ] **Step 6: Commit**

```bash
git add router/src/helpers/bootstrap-labels.ts router/test/helpers/bootstrap-labels.test.ts
git commit -m "feat(router): add bootstrap-labels helper with tests"
```

### Task 2.3: open-stage-pr helper

**Files:**
- Create: `router/test/helpers/open-stage-pr.test.ts`
- Modify: `router/src/helpers/open-stage-pr.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test, vi } from 'vitest';
import { openStagePr, runOpenStagePr } from '../../src/helpers/open-stage-pr';
import { GitHubAdapter } from '../../src/github';

function makeAdapter(octokitOverrides: Partial<Record<string, unknown>> = {}): GitHubAdapter {
  const createPrMock = vi.fn().mockResolvedValue({ data: { number: 43, html_url: 'https://x/43' } });
  return new GitHubAdapter(
    {
      rest: {
        issues: { createComment: vi.fn().mockResolvedValue({ data: { id: 1 } }), addLabels: vi.fn() },
        pulls: { create: createPrMock, update: vi.fn() },
        ...octokitOverrides
      }
    } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
    { owner: 'o', repo: 'r' }
  );
}

describe('openStagePr', () => {
  test('opens a PR with metadata block and returns number', async () => {
    const adapter = makeAdapter();
    const result = await openStagePr(adapter, {
      issueNumber: 42,
      stage: 'spec',
      branchName: 'shopfloor/spec/42-foo',
      baseBranch: 'main',
      title: 'Spec for #42',
      body: 'Body.'
    });
    expect(result.prNumber).toBe(43);
  });
});
```

- [ ] **Step 2: Run test (fail), implement, rerun (pass)**

Implement `router/src/helpers/open-stage-pr.ts`:

```ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

export interface OpenStagePrParams {
  issueNumber: number;
  stage: 'spec' | 'plan' | 'implement';
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  reviewIteration?: number;
  draft?: boolean;
}

export async function openStagePr(
  adapter: GitHubAdapter,
  params: OpenStagePrParams
): Promise<{ prNumber: number; url: string }> {
  const pr = await adapter.openStagePr({
    base: params.baseBranch,
    head: params.branchName,
    title: params.title,
    body: params.body,
    stage: params.stage,
    issueNumber: params.issueNumber,
    reviewIteration: params.reviewIteration,
    draft: params.draft
  });
  return { prNumber: pr.number, url: pr.url };
}

export async function runOpenStagePr(adapter: GitHubAdapter): Promise<void> {
  const params: OpenStagePrParams = {
    issueNumber: Number(core.getInput('issue_number', { required: true })),
    stage: core.getInput('stage', { required: true }) as OpenStagePrParams['stage'],
    branchName: core.getInput('branch_name', { required: true }),
    baseBranch: core.getInput('base_branch', { required: true }),
    title: core.getInput('pr_title', { required: true }),
    body: core.getInput('pr_body', { required: true }),
    reviewIteration: core.getInput('review_iteration') ? Number(core.getInput('review_iteration')) : undefined,
    draft: core.getInput('draft') === 'true'
  };
  const result = await openStagePr(adapter, params);
  core.setOutput('pr_number', String(result.prNumber));
  core.setOutput('pr_url', result.url);
}
```

Run: `pnpm test router/test/helpers/open-stage-pr.test.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add router/src/helpers/open-stage-pr.ts router/test/helpers/open-stage-pr.test.ts
git commit -m "feat(router): add open-stage-pr helper with tests"
```

### Task 2.4: advance-state helper

**Files:**
- Create: `router/test/helpers/advance-state.test.ts`
- Modify: `router/src/helpers/advance-state.ts`

**Purpose:** Flip labels on an issue or PR. Given `fromLabels`, `toLabels`, and a target, remove the from set and add the to set. Idempotent.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test, vi } from 'vitest';
import { GitHubAdapter } from '../../src/github';
import { advanceState } from '../../src/helpers/advance-state';

describe('advanceState', () => {
  test('removes fromLabels and adds toLabels', async () => {
    const addLabels = vi.fn().mockResolvedValue({ data: [] });
    const removeLabel = vi.fn().mockResolvedValue({ data: [] });
    const adapter = new GitHubAdapter(
      { rest: { issues: { addLabels, removeLabel } } } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
      { owner: 'o', repo: 'r' }
    );
    await advanceState(adapter, 42, ['shopfloor:needs-spec'], ['shopfloor:spec-in-review']);
    expect(removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: 'shopfloor:needs-spec' }));
    expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['shopfloor:spec-in-review'] }));
  });
});
```

- [ ] **Step 2: Implement**

```ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

export async function advanceState(
  adapter: GitHubAdapter,
  issueNumber: number,
  fromLabels: string[],
  toLabels: string[]
): Promise<void> {
  for (const l of fromLabels) await adapter.removeLabel(issueNumber, l);
  for (const l of toLabels) await adapter.addLabel(issueNumber, l);
}

export async function runAdvanceState(adapter: GitHubAdapter): Promise<void> {
  const issueNumber = Number(core.getInput('issue_number', { required: true }));
  const fromLabels = (core.getInput('from_labels') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const toLabels = (core.getInput('to_labels') || '').split(',').map((s) => s.trim()).filter(Boolean);
  await advanceState(adapter, issueNumber, fromLabels, toLabels);
  core.info(`advance-state: ${fromLabels.join(',')} -> ${toLabels.join(',')}`);
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add router/src/helpers/advance-state.ts router/test/helpers/advance-state.test.ts
git commit -m "feat(router): add advance-state helper with tests"
```

### Task 2.5: report-failure helper

**Files:**
- Create: `router/test/helpers/report-failure.test.ts`
- Modify: `router/src/helpers/report-failure.ts`

**Purpose:** Called in `if: failure()` steps. Posts a diagnostic comment and applies `shopfloor:failed:<stage>`.

- [ ] **Step 1: Test-first**

```ts
test('posts diagnostic comment and applies failed label', async () => {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const addLabels = vi.fn().mockResolvedValue({ data: [] });
  const adapter = new GitHubAdapter(
    { rest: { issues: { createComment, addLabels } } } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
    { owner: 'o', repo: 'r' }
  );
  await reportFailure(adapter, { issueNumber: 42, stage: 'spec', runUrl: 'https://x/run/1' });
  expect(createComment).toHaveBeenCalledWith(
    expect.objectContaining({ body: expect.stringContaining('spec') })
  );
  expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['shopfloor:failed:spec'] }));
});
```

- [ ] **Step 2: Implement**

```ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

export interface ReportFailureParams {
  issueNumber: number;
  stage: 'triage' | 'spec' | 'plan' | 'implement' | 'review';
  runUrl: string;
  targetPrNumber?: number; // optional, when a PR exists; otherwise posts on origin issue
}

export async function reportFailure(adapter: GitHubAdapter, params: ReportFailureParams): Promise<void> {
  const target = params.targetPrNumber ?? params.issueNumber;
  const body = [
    `**Shopfloor stage \`${params.stage}\` failed.**`,
    '',
    `See the [workflow run](${params.runUrl}) for details.`,
    '',
    `You can retry by removing the \`shopfloor:failed:${params.stage}\` label.`
  ].join('\n');
  await adapter.postIssueComment(target, body);
  await adapter.addLabel(params.issueNumber, `shopfloor:failed:${params.stage}`);
}

export async function runReportFailure(adapter: GitHubAdapter): Promise<void> {
  await reportFailure(adapter, {
    issueNumber: Number(core.getInput('issue_number', { required: true })),
    stage: core.getInput('stage', { required: true }) as ReportFailureParams['stage'],
    runUrl: core.getInput('run_url', { required: true }),
    targetPrNumber: core.getInput('target_pr_number') ? Number(core.getInput('target_pr_number')) : undefined
  });
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add router/src/helpers/report-failure.ts router/test/helpers/report-failure.test.ts
git commit -m "feat(router): add report-failure helper with tests"
```

### Task 2.6: handle-merge helper

**Files:**
- Create: `router/test/helpers/handle-merge.test.ts`
- Modify: `router/src/helpers/handle-merge.ts`

**Purpose:** Called when a `pull_request.closed` with `merged: true` event fires on a Shopfloor PR. Parses metadata, flips labels on the origin issue to advance to the next stage.

- [ ] **Step 1: Test-first**

Test: merging a spec PR transitions the origin issue from `shopfloor:spec-in-review` to `shopfloor:needs-plan`. Merging a plan PR transitions to `needs-impl`. Merging an impl PR transitions to `shopfloor:done` and closes the issue.

```ts
test('spec PR merged → needs-plan', async () => {
  const addLabels = vi.fn();
  const removeLabel = vi.fn();
  const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const adapter = new GitHubAdapter(
    { rest: { issues: { addLabels, removeLabel, createComment, update: vi.fn() } } } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
    { owner: 'o', repo: 'r' }
  );
  await handleMerge(adapter, { issueNumber: 42, mergedStage: 'spec', prNumber: 43 });
  expect(removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: 'shopfloor:spec-in-review' }));
  expect(addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['shopfloor:needs-plan'] }));
});
```

- [ ] **Step 2: Implement**

```ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';
import { advanceState } from './advance-state';

export interface HandleMergeParams {
  issueNumber: number;
  mergedStage: 'spec' | 'plan' | 'implement';
  prNumber: number;
}

export async function handleMerge(adapter: GitHubAdapter, params: HandleMergeParams): Promise<void> {
  switch (params.mergedStage) {
    case 'spec':
      await advanceState(adapter, params.issueNumber, ['shopfloor:spec-in-review'], ['shopfloor:needs-plan']);
      await adapter.postIssueComment(params.issueNumber, `Spec merged in #${params.prNumber}. Moving to planning stage.`);
      return;
    case 'plan':
      await advanceState(adapter, params.issueNumber, ['shopfloor:plan-in-review'], ['shopfloor:needs-impl']);
      await adapter.postIssueComment(params.issueNumber, `Plan merged in #${params.prNumber}. Moving to implementation stage.`);
      return;
    case 'implement':
      await advanceState(
        adapter,
        params.issueNumber,
        ['shopfloor:impl-in-review', 'shopfloor:review-approved'],
        ['shopfloor:done']
      );
      await adapter.postIssueComment(params.issueNumber, `Implementation merged in #${params.prNumber}. Pipeline complete.`);
      await adapter.closeIssue(params.issueNumber);
      return;
  }
}

export async function runHandleMerge(adapter: GitHubAdapter): Promise<void> {
  await handleMerge(adapter, {
    issueNumber: Number(core.getInput('issue_number', { required: true })),
    mergedStage: core.getInput('merged_stage', { required: true }) as HandleMergeParams['mergedStage'],
    prNumber: Number(core.getInput('pr_number', { required: true }))
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add router/src/helpers/handle-merge.ts router/test/helpers/handle-merge.test.ts
git commit -m "feat(router): add handle-merge helper with tests"
```

### Task 2.7: create-progress-comment and finalize-progress-comment helpers

**Files:**
- Create: `router/test/helpers/progress-comment.test.ts`
- Modify: `router/src/helpers/create-progress-comment.ts`
- Modify: `router/src/helpers/finalize-progress-comment.ts`

**Purpose:** `create` posts the initial "Implementation starting..." comment on the impl PR and returns its ID. `finalize` replaces the body with a terminal state string.

- [ ] **Step 1: Test-first**

```ts
test('create-progress-comment returns the comment id', async () => {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 777 } });
  const adapter = new GitHubAdapter(
    { rest: { issues: { createComment } } } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
    { owner: 'o', repo: 'r' }
  );
  const id = await createProgressComment(adapter, 45);
  expect(id).toBe(777);
});

test('finalize replaces comment body', async () => {
  const updateComment = vi.fn().mockResolvedValue({ data: {} });
  const adapter = new GitHubAdapter(
    { rest: { issues: { updateComment } } } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
    { owner: 'o', repo: 'r' }
  );
  await finalizeProgressComment(adapter, 777, 'success', 'All tasks complete.');
  expect(updateComment).toHaveBeenCalledWith(
    expect.objectContaining({ comment_id: 777, body: expect.stringContaining('All tasks complete.') })
  );
});
```

- [ ] **Step 2: Implement both helpers**

```ts
// create-progress-comment.ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

export async function createProgressComment(adapter: GitHubAdapter, prNumber: number): Promise<number> {
  return adapter.postIssueComment(
    prNumber,
    '**Shopfloor implementation in progress.**\n\nI will update this comment with progress as I work. Stand by.'
  );
}

export async function runCreateProgressComment(adapter: GitHubAdapter): Promise<void> {
  const id = await createProgressComment(adapter, Number(core.getInput('pr_number', { required: true })));
  core.setOutput('comment_id', String(id));
}
```

```ts
// finalize-progress-comment.ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

export async function finalizeProgressComment(
  adapter: GitHubAdapter,
  commentId: number,
  terminalState: 'success' | 'failure',
  finalBody: string
): Promise<void> {
  const header = terminalState === 'success' ? '**Shopfloor implementation complete.**' : '**Shopfloor implementation ended with errors.**';
  await adapter.updateComment(commentId, `${header}\n\n${finalBody}`);
}

export async function runFinalizeProgressComment(adapter: GitHubAdapter): Promise<void> {
  await finalizeProgressComment(
    adapter,
    Number(core.getInput('comment_id', { required: true })),
    core.getInput('terminal_state', { required: true }) as 'success' | 'failure',
    core.getInput('final_body', { required: true })
  );
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add router/src/helpers/create-progress-comment.ts router/src/helpers/finalize-progress-comment.ts router/test/helpers/progress-comment.test.ts
git commit -m "feat(router): add progress comment helpers with tests"
```

### Task 2.8: check-review-skip helper

**Files:**
- Create: `router/test/helpers/check-review-skip.test.ts`
- Modify: `router/src/helpers/check-review-skip.ts`

**Purpose:** Evaluates the skip conditions for the review stage (spec section 5.5.1) and returns a decision.

- [ ] **Step 1: Test-first**

```ts
test('returns skip=true when PR has shopfloor:skip-review label', async () => {
  const adapter = makeAdapterWithPr({
    labels: [{ name: 'shopfloor:skip-review' }],
    changedFiles: ['src/foo.ts']
  });
  const result = await checkReviewSkip(adapter, 45);
  expect(result.skip).toBe(true);
  expect(result.reason).toBe('skip_review_label');
});

test('returns skip=true when PR changed files are all in docs/shopfloor/', async () => {
  const adapter = makeAdapterWithPr({ changedFiles: ['docs/shopfloor/specs/42-x.md'] });
  const result = await checkReviewSkip(adapter, 45);
  expect(result.skip).toBe(true);
  expect(result.reason).toBe('only_shopfloor_docs');
});

test('returns skip=false on normal impl PR', async () => {
  const adapter = makeAdapterWithPr({ changedFiles: ['src/auth.ts'] });
  const result = await checkReviewSkip(adapter, 45);
  expect(result.skip).toBe(false);
});

test('returns skip=true when origin issue carries shopfloor:skip-review', async () => {
  const adapter = makeAdapterWithPr({
    body: 'Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement',
    issueLabels: [{ name: 'shopfloor:skip-review' }],
    changedFiles: ['src/auth.ts']
  });
  const result = await checkReviewSkip(adapter, 45);
  expect(result.skip).toBe(true);
  expect(result.reason).toBe('skip_review_label_issue');
});

test('returns skip=true when origin issue is closed', async () => {
  const adapter = makeAdapterWithPr({
    body: 'Body\n---\nShopfloor-Issue: #42',
    issueState: 'closed',
    changedFiles: ['src/auth.ts']
  });
  const result = await checkReviewSkip(adapter, 45);
  expect(result.skip).toBe(true);
  expect(result.reason).toBe('origin_issue_closed');
});
```

The `makeAdapterWithPr` test helper must support the new optional `issueLabels`, `issueState`, and `body` fields. Stub `getIssue` in the mock to return whatever the test passes for `issueLabels`/`issueState`.

(Implement `makeAdapterWithPr` as a shared test helper that returns a `GitHubAdapter` stub with the `getPr` and `listChangedFiles` methods mocked to return the given data.)

- [ ] **Step 2: Extend `GitHubAdapter` with `getPr` and `listChangedFiles`**

```ts
async getPr(prNumber: number): Promise<{
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  labels: Array<{ name: string }>;
  head: { sha: string };
  body: string | null;
}> {
  const res = await this.octokit.rest.pulls.get({ ...this.repo, pull_number: prNumber });
  return res.data as never;
}

async listChangedFiles(prNumber: number): Promise<string[]> {
  const files: string[] = [];
  let page = 1;
  for (;;) {
    const res = await this.octokit.rest.pulls.listFiles({ ...this.repo, pull_number: prNumber, per_page: 100, page });
    files.push(...res.data.map((f) => f.filename));
    if (res.data.length < 100) break;
    page++;
  }
  return files;
}
```

- [ ] **Step 3: Extend `GitHubAdapter` with `getIssue`**

Add to `router/src/github.ts`:

```ts
async getIssue(issueNumber: number): Promise<{ labels: Array<{ name: string }>; state: 'open' | 'closed' }> {
  const res = await this.octokit.rest.issues.get({ ...this.repo, issue_number: issueNumber });
  return { labels: res.data.labels as Array<{ name: string }>, state: res.data.state as 'open' | 'closed' };
}
```

- [ ] **Step 4: Implement `check-review-skip.ts`**

The helper must check **both** PR labels and the origin issue's labels per spec section 5.5.1 conditions 6 and 7. The origin issue number is parsed from the PR body's `Shopfloor-Issue:` metadata.

```ts
import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';

export interface CheckReviewSkipResult {
  skip: boolean;
  reason?: string;
}

function parseIssueNumberFromBody(body: string | null): number | null {
  if (!body) return null;
  const m = body.match(/Shopfloor-Issue:\s*#(\d+)/);
  return m ? Number(m[1]) : null;
}

export async function checkReviewSkip(adapter: GitHubAdapter, prNumber: number): Promise<CheckReviewSkipResult> {
  const pr = await adapter.getPr(prNumber);
  if (pr.state === 'closed') return { skip: true, reason: 'pr_closed' };
  if (pr.draft) return { skip: true, reason: 'pr_draft' };
  if (pr.labels.some((l) => l.name === 'shopfloor:skip-review')) return { skip: true, reason: 'skip_review_label_pr' };

  // Spec 5.5.1 condition 7: check origin issue's labels too.
  const originIssueNumber = parseIssueNumberFromBody(pr.body ?? null);
  if (originIssueNumber !== null) {
    const issue = await adapter.getIssue(originIssueNumber);
    if (issue.state === 'closed') return { skip: true, reason: 'origin_issue_closed' };
    if (issue.labels.some((l) => l.name === 'shopfloor:skip-review')) {
      return { skip: true, reason: 'skip_review_label_issue' };
    }
  }

  const files = await adapter.listChangedFiles(prNumber);
  if (files.length === 0) return { skip: true, reason: 'no_changed_files' };
  if (files.every((f) => f.startsWith('docs/shopfloor/'))) return { skip: true, reason: 'only_shopfloor_docs' };

  // already-reviewed at this SHA
  const reviews = await adapter.getPrReviewsAtSha(prNumber, pr.head.sha);
  const hasShopfloorReview = reviews.some((r) => r.body.startsWith('<!-- shopfloor-review -->'));
  if (hasShopfloorReview) return { skip: true, reason: 'already_reviewed_at_sha' };

  return { skip: false };
}

export async function runCheckReviewSkip(adapter: GitHubAdapter): Promise<void> {
  const prNumber = Number(core.getInput('pr_number', { required: true }));
  const result = await checkReviewSkip(adapter, prNumber);
  core.setOutput('skip', String(result.skip));
  if (result.reason) core.setOutput('reason', result.reason);
}
```

- [ ] **Step 4: Run tests, commit**

```bash
git add router/src/helpers/check-review-skip.ts router/src/github.ts router/test/helpers/check-review-skip.test.ts
git commit -m "feat(router): add check-review-skip helper and PR file listing"
```

### Task 2.9: aggregate-review helper (highest-risk piece)

**Files:**
- Create: `router/test/helpers/aggregate-review.test.ts`
- Create: `router/test/fixtures/reviewer-outputs/compliance-clean.json`
- Create: `router/test/fixtures/reviewer-outputs/compliance-issues.json`
- Create: `router/test/fixtures/reviewer-outputs/bugs-clean.json`
- Create: `router/test/fixtures/reviewer-outputs/bugs-issues.json`
- Create: `router/test/fixtures/reviewer-outputs/security-clean.json`
- Create: `router/test/fixtures/reviewer-outputs/smells-clean.json`
- Create: `router/test/fixtures/reviewer-outputs/smells-low-confidence.json`
- Modify: `router/src/helpers/aggregate-review.ts`

**Context:** This is the single most complex helper. It takes the outputs of the 4 matrix cells (each a JSON string), dedupes comments, filters by confidence, posts a single batched review (APPROVE or REQUEST_CHANGES), updates the commit status, manages the iteration counter, and handles the iteration cap. Full spec in section 5.5.3.

- [ ] **Step 1: Populate reviewer-output fixtures**

Each fixture is the JSON an individual reviewer would emit per its schema (section 5.5.2 output schema). For the `clean` fixtures: `verdict: "clean"`, empty `comments`. For `issues` fixtures: `verdict: "issues_found"`, a non-empty `comments` array with `path`, `line`, `side`, `body`, `confidence`, `category`.

For `smells-low-confidence.json`, populate with `confidence: 60` so it should be filtered out.

For `compliance-issues.json` and `bugs-issues.json`, have them share one comment at the same `{path: "src/auth.ts", line: 42}` so we can test the dedupe.

- [ ] **Step 2: Write failing tests**

```ts
import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateReview } from '../../src/helpers/aggregate-review';
import { GitHubAdapter } from '../../src/github';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(join(__dirname, '../fixtures/reviewer-outputs', `${name}.json`), 'utf-8');
}

function makeAdapter(): { adapter: GitHubAdapter; spies: { postReview: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn>; addLabels: ReturnType<typeof vi.fn>; postComment: ReturnType<typeof vi.fn>; updatePr: ReturnType<typeof vi.fn>; getPr: ReturnType<typeof vi.fn> } } {
  const postReview = vi.fn().mockResolvedValue({ data: {} });
  const setStatus = vi.fn().mockResolvedValue({ data: {} });
  const addLabels = vi.fn().mockResolvedValue({ data: [] });
  const postComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
  const updatePr = vi.fn().mockResolvedValue({ data: {} });
  const getPr = vi.fn().mockResolvedValue({
    data: { body: 'Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0', head: { sha: 'abc' } }
  });

  const adapter = new GitHubAdapter(
    {
      rest: {
        pulls: { createReview: postReview, update: updatePr, get: getPr, listReviews: vi.fn().mockResolvedValue({ data: [] }) },
        issues: { addLabels, createComment: postComment, removeLabel: vi.fn().mockResolvedValue({ data: [] }) },
        repos: { createCommitStatus: setStatus }
      }
    } as unknown as ConstructorParameters<typeof GitHubAdapter>[0],
    { owner: 'o', repo: 'r' }
  );
  return { adapter, spies: { postReview, setStatus, addLabels, postComment, updatePr, getPr } };
}

describe('aggregateReview', () => {
  test('all clean → APPROVE review and success status', async () => {
    const { adapter, spies } = makeAdapter();
    await aggregateReview(adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture('compliance-clean'),
        bugs: fixture('bugs-clean'),
        security: fixture('security-clean'),
        smells: fixture('smells-clean')
      }
    });
    expect(spies.postReview).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 45,
        event: 'APPROVE',
        comments: []
      })
    );
    expect(spies.setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'success' }));
    expect(spies.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['shopfloor:review-approved'] }));
  });

  test('issues found → REQUEST_CHANGES with filtered+deduped comments', async () => {
    const { adapter, spies } = makeAdapter();
    await aggregateReview(adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture('compliance-issues'),
        bugs: fixture('bugs-issues'),
        security: fixture('security-clean'),
        smells: fixture('smells-low-confidence')
      }
    });

    expect(spies.postReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'REQUEST_CHANGES' })
    );

    const reviewCall = spies.postReview.mock.calls[0][0] as { comments: Array<{ path: string }> };
    // Dedupe: the duplicate comment at src/auth.ts:42 appears once (not twice).
    expect(reviewCall.comments.filter((c) => c.path === 'src/auth.ts').length).toBe(1);
    // Filter: the low-confidence smell is dropped.
    expect(reviewCall.comments.some((c) => c.body.includes('low-confidence'))).toBe(false);

    expect(spies.setStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'failure' }));
    expect(spies.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['shopfloor:review-requested-changes'] }));
  });

  test('iteration cap exceeded → review-stuck, no REQUEST_CHANGES posted', async () => {
    const { adapter, spies } = makeAdapter();
    spies.getPr.mockResolvedValue({
      data: { body: 'Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 3', head: { sha: 'abc' } }
    });
    await aggregateReview(adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture('compliance-issues'),
        bugs: fixture('bugs-clean'),
        security: fixture('security-clean'),
        smells: fixture('smells-clean')
      }
    });
    expect(spies.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ['shopfloor:review-stuck'] }));
    expect(spies.postReview).not.toHaveBeenCalled();
    expect(spies.setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failure', description: expect.stringContaining('cap') })
    );
  });

  test('matrix cell failed (empty output) → treated as "no findings" from that reviewer', async () => {
    const { adapter, spies } = makeAdapter();
    await aggregateReview(adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: '',
        bugs: fixture('bugs-clean'),
        security: fixture('security-clean'),
        smells: fixture('smells-clean')
      }
    });
    expect(spies.postReview).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE' }));
  });
});
```

- [ ] **Step 3: Implement `aggregate-review.ts`**

```ts
import * as core from '@actions/core';
import type { GitHubAdapter, ReviewComment } from '../github';

interface ReviewerOutput {
  verdict: 'clean' | 'issues_found';
  summary: string;
  comments: Array<{
    path: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
    body: string;
    confidence: number;
    category: 'compliance' | 'bug' | 'security' | 'smell';
  }>;
}

export interface AggregateReviewParams {
  issueNumber: number;
  prNumber: number;
  confidenceThreshold: number;
  maxIterations: number;
  reviewerOutputs: Record<'compliance' | 'bugs' | 'security' | 'smells', string>;
  workflowRunUrl?: string;
}

const SHOPFLOOR_REVIEW_MARKER = '<!-- shopfloor-review -->';

function parseReviewer(raw: string): ReviewerOutput | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewerOutput;
    if (parsed.verdict !== 'clean' && parsed.verdict !== 'issues_found') return null;
    if (!Array.isArray(parsed.comments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function tokenOverlap(a: string, b: string): number {
  const aSet = new Set(a.slice(0, 200).toLowerCase().split(/\W+/).filter(Boolean));
  const bSet = new Set(b.slice(0, 200).toLowerCase().split(/\W+/).filter(Boolean));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const t of aSet) if (bSet.has(t)) intersection++;
  return intersection / Math.min(aSet.size, bSet.size);
}

function dedupeComments(all: ReviewerOutput['comments']): ReviewerOutput['comments'] {
  const keepers: ReviewerOutput['comments'] = [];
  for (const c of all) {
    const duplicate = keepers.find(
      (k) => k.path === c.path && k.line === c.line && k.side === c.side && tokenOverlap(k.body, c.body) >= 0.75
    );
    if (duplicate) {
      if (c.confidence > duplicate.confidence) {
        // replace lower-confidence with higher
        const idx = keepers.indexOf(duplicate);
        keepers[idx] = c;
      }
      continue;
    }
    keepers.push(c);
  }
  return keepers;
}

function parseIterationFromBody(body: string | null): number {
  if (!body) return 0;
  const m = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

function writeIterationToBody(body: string | null, iteration: number): string {
  const baseBody = body ?? '';
  if (baseBody.match(/Shopfloor-Review-Iteration:\s*\d+/)) {
    return baseBody.replace(/Shopfloor-Review-Iteration:\s*\d+/, `Shopfloor-Review-Iteration: ${iteration}`);
  }
  return baseBody.trimEnd() + `\nShopfloor-Review-Iteration: ${iteration}\n`;
}

export async function aggregateReview(adapter: GitHubAdapter, params: AggregateReviewParams): Promise<void> {
  const outputs = {
    compliance: parseReviewer(params.reviewerOutputs.compliance),
    bugs: parseReviewer(params.reviewerOutputs.bugs),
    security: parseReviewer(params.reviewerOutputs.security),
    smells: parseReviewer(params.reviewerOutputs.smells)
  };
  const parsed = Object.values(outputs).filter((v): v is ReviewerOutput => v !== null);
  const successfulCells = parsed.length;

  const pr = await adapter.getPr(params.prNumber);
  const headSha = pr.head.sha;
  const currentIteration = parseIterationFromBody(pr.body ?? null);

  await adapter.setReviewStatus(headSha, 'pending', 'Shopfloor review: aggregating findings...', params.workflowRunUrl);

  // Spec 5.5.3 step 3: verify each reviewer stayed in scope. A reviewer producing
  // comments tagged with a different category is a prompt-injection or misbehaviour
  // signal. Log it, but do not drop the comments outright; we still let them flow
  // through dedupe and filter. This gives us observability without destabilising
  // the pipeline.
  const SOURCE_CATEGORY: Record<string, string> = {
    compliance: 'compliance',
    bugs: 'bug',
    security: 'security',
    smells: 'smell'
  };
  for (const [source, out] of Object.entries(outputs)) {
    if (!out) continue;
    const expected = SOURCE_CATEGORY[source];
    const outOfScope = out.comments.filter((c) => c.category !== expected);
    if (outOfScope.length > 0) {
      core.warning(
        `aggregateReview: ${source} reviewer returned ${outOfScope.length} out-of-scope comment(s) (expected category '${expected}')`
      );
    }
  }

  // Collect all comments, tagged by source.
  const allComments = parsed.flatMap((r) => r.comments);
  // Dedupe.
  const deduped = dedupeComments(allComments);
  // Filter.
  const filtered = deduped.filter((c) => c.confidence >= params.confidenceThreshold);

  const allClean = parsed.every((r) => r.verdict === 'clean') && filtered.length === 0;
  const verdict: 'clean' | 'issues_found' = allClean ? 'clean' : 'issues_found';

  if (verdict === 'clean') {
    const body = `${SHOPFLOOR_REVIEW_MARKER}\n**Shopfloor agent review: clean** across ${successfulCells}/4 reviewers.\n\n${parsed.map((r) => `- ${r.summary}`).join('\n')}`;
    await adapter.postReview({
      prNumber: params.prNumber,
      commitSha: headSha,
      event: 'APPROVE',
      body,
      comments: []
    });
    await adapter.setReviewStatus(headSha, 'success', 'Shopfloor review passed', params.workflowRunUrl);
    await adapter.addLabel(params.issueNumber, 'shopfloor:review-approved');
    await adapter.removeLabel(params.issueNumber, 'shopfloor:needs-review');
    await adapter.removeLabel(params.issueNumber, 'shopfloor:review-requested-changes');
    return;
  }

  // Issues found. Check iteration cap.
  const nextIteration = currentIteration + 1;
  if (nextIteration > params.maxIterations) {
    await adapter.addLabel(params.issueNumber, 'shopfloor:review-stuck');
    await adapter.removeLabel(params.issueNumber, 'shopfloor:needs-review');
    await adapter.removeLabel(params.issueNumber, 'shopfloor:review-requested-changes');
    await adapter.postIssueComment(
      params.prNumber,
      `Shopfloor agent review has been through ${params.maxIterations} iterations without converging. A human should take over this PR. See commit status for the current findings list.`
    );
    await adapter.setReviewStatus(headSha, 'failure', `Shopfloor review: iteration cap reached (${params.maxIterations})`, params.workflowRunUrl);
    return;
  }

  // Post Request Changes review with batched comments.
  const reviewBody = [
    SHOPFLOOR_REVIEW_MARKER,
    `**Shopfloor agent review: changes requested** (iteration ${nextIteration}/${params.maxIterations}).`,
    '',
    parsed.map((r) => `- ${r.summary}`).join('\n')
  ].join('\n');

  const batchedComments: ReviewComment[] = filtered.map((c) => ({
    path: c.path,
    line: c.line,
    side: c.side,
    start_line: c.start_line,
    start_side: c.start_side,
    body: `[${c.category} / confidence ${c.confidence}]\n\n${c.body}`
  }));

  await adapter.postReview({
    prNumber: params.prNumber,
    commitSha: headSha,
    event: 'REQUEST_CHANGES',
    body: reviewBody,
    comments: batchedComments
  });
  await adapter.setReviewStatus(headSha, 'failure', `Shopfloor review requested changes (iteration ${nextIteration})`, params.workflowRunUrl);
  await adapter.addLabel(params.issueNumber, 'shopfloor:review-requested-changes');
  await adapter.removeLabel(params.issueNumber, 'shopfloor:needs-review');

  // Update PR body with incremented iteration counter.
  const newBody = writeIterationToBody(pr.body ?? null, nextIteration);
  await adapter.updatePrBody(params.prNumber, newBody);
}

export async function runAggregateReview(adapter: GitHubAdapter): Promise<void> {
  const params: AggregateReviewParams = {
    issueNumber: Number(core.getInput('issue_number', { required: true })),
    prNumber: Number(core.getInput('pr_number', { required: true })),
    confidenceThreshold: Number(core.getInput('confidence_threshold') || 80),
    maxIterations: Number(core.getInput('max_iterations') || 3),
    reviewerOutputs: {
      compliance: core.getInput('compliance_output') || '',
      bugs: core.getInput('bugs_output') || '',
      security: core.getInput('security_output') || '',
      smells: core.getInput('smells_output') || ''
    },
    workflowRunUrl: core.getInput('workflow_run_url') || undefined
  };
  await aggregateReview(adapter, params);
}
```

- [ ] **Step 4: Run tests (pass)**

Run: `pnpm test router/test/helpers/aggregate-review.test.ts`
Expected: all pass. Iterate on implementation until they do.

- [ ] **Step 5: Commit**

```bash
git add router/src/helpers/aggregate-review.ts router/test/helpers/aggregate-review.test.ts router/test/fixtures/reviewer-outputs
git commit -m "feat(router): add aggregate-review helper with dedupe, filter, iteration cap"
```

### Task 2.10: Router build step

**Files:**
- Create: `router/esbuild.config.mjs`
- Modify: `router/package.json` (add build script)

**Context:** `action.yml` points to `dist/index.js`. We need to bundle the router TypeScript plus its dependencies into a single file for `node20` action runtimes.

- [ ] **Step 1: Install esbuild as dev dep in router**

Run: `pnpm --filter @shopfloor/router add -D esbuild`

- [ ] **Step 2: Create `router/esbuild.config.mjs`**

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true
});
```

- [ ] **Step 3: Update `router/package.json` scripts**

```json
"scripts": {
  "build": "node esbuild.config.mjs",
  "typecheck": "tsc --noEmit"
}
```

- [ ] **Step 4: Run build**

Run: `pnpm --filter @shopfloor/router build`
Expected: `router/dist/index.js` exists.

- [ ] **Step 5: Verify `node router/dist/index.js` runs (without inputs it will fail, but the failure must be a missing-input error, not a syntax error)**

Run: `node router/dist/index.js`
Expected: stderr includes "Input required and not supplied: github_token" (or similar). That means the build succeeded and `@actions/core` loaded.

- [ ] **Step 6: Add `router/dist` to `.gitignore` but commit it anyway as a build artifact used by the action**

Actually: GitHub Actions that are referenced by tag (`@v1`) must have their built artifact committed. So **remove** `dist` from `.gitignore` and commit it. Ugly but standard practice for JS actions.

Edit `.gitignore` to remove the `dist` line.

- [ ] **Step 7: Commit**

```bash
git add router/esbuild.config.mjs router/package.json router/dist .gitignore pnpm-lock.yaml
git commit -m "chore(router): add esbuild config and commit dist artifact"
```

---

## Phase 3: Shopfloor MCP server

### Task 3.1: Scaffold MCP server package

**Files:**
- Create: `mcp-servers/shopfloor-mcp/package.json`
- Create: `mcp-servers/shopfloor-mcp/tsconfig.json`
- Create: `mcp-servers/shopfloor-mcp/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@shopfloor/mcp-server",
  "version": "1.0.0-rc.0",
  "private": true,
  "type": "module",
  "main": "index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.6.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0"
  }
}
```

- [ ] **Step 2: Create tsconfig**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["index.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create stub `index.ts`**

```ts
#!/usr/bin/env bun
// Shopfloor MCP server. Exposes Shopfloor-owned tools to the implementation agent.
// For v0.1: just update_progress. See spec section 6.4.
console.error('Shopfloor MCP server: not yet implemented');
process.exit(1);
```

- [ ] **Step 4: Install**

Run: `pnpm install`
Expected: `@shopfloor/mcp-server` added to workspace.

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/shopfloor-mcp package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(mcp): scaffold shopfloor MCP server package"
```

### Task 3.2: Test-first implementation of update_progress tool

**Files:**
- Create: `mcp-servers/shopfloor-mcp/test/index.test.ts`
- Modify: `mcp-servers/shopfloor-mcp/index.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { updateProgress } from '../index';

describe('updateProgress tool', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.REPO_OWNER = 'niranjan94';
    process.env.REPO_NAME = 'shopfloor';
    process.env.SHOPFLOOR_COMMENT_ID = '777';
    process.env.GITHUB_API_URL = 'https://api.github.com';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_TOKEN;
    delete process.env.SHOPFLOOR_COMMENT_ID;
  });

  test('patches the correct comment endpoint with the body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await updateProgress({ body: '# Todo\n- [x] step 1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/niranjan94/shopfloor/issues/comments/777',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        body: JSON.stringify({ body: '# Todo\n- [x] step 1' })
      })
    );
  });

  test('throws when SHOPFLOOR_COMMENT_ID is missing', async () => {
    delete process.env.SHOPFLOOR_COMMENT_ID;
    await expect(updateProgress({ body: 'x' })).rejects.toThrow(/SHOPFLOOR_COMMENT_ID/);
  });

  test('throws when GitHub API returns non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(updateProgress({ body: 'x' })).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Implement `index.ts` as both an MCP server entry and an exported function for testing**

```ts
#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export async function updateProgress(input: { body: string }): Promise<{ ok: true }> {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const commentId = process.env.SHOPFLOOR_COMMENT_ID;
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';

  if (!token) throw new Error('GITHUB_TOKEN required');
  if (!owner || !repo) throw new Error('REPO_OWNER and REPO_NAME required');
  if (!commentId) throw new Error('SHOPFLOOR_COMMENT_ID required');

  const res = await fetch(`${apiUrl}/repos/${owner}/${repo}/issues/comments/${commentId}`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ body: input.body })
  });

  if (!res.ok) {
    const text = typeof (res as Response).text === 'function' ? await (res as Response).text() : '';
    throw new Error(`GitHub API returned ${res.status}: ${text}`);
  }
  return { ok: true };
}

async function runServer(): Promise<void> {
  const server = new McpServer({ name: 'shopfloor', version: '1.0.0-rc.0' });
  server.tool(
    'update_progress',
    'Replace the body of the Shopfloor implementation progress comment with new content (typically a markdown checklist of tasks with completion state).',
    { body: z.string().describe('New comment body as markdown') },
    async ({ body }) => {
      try {
        await updateProgress({ body });
        return { content: [{ type: 'text', text: 'Progress comment updated.' }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `update_progress failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run the server when executed as the main script, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  runServer().catch((err) => {
    console.error('shopfloor-mcp fatal:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Run tests (pass)**

Run: `pnpm test mcp-servers/shopfloor-mcp/test/index.test.ts`
Expected: all pass.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @shopfloor/mcp-server typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add mcp-servers/shopfloor-mcp/index.ts mcp-servers/shopfloor-mcp/test/index.test.ts
git commit -m "feat(mcp): implement shopfloor update_progress tool with tests"
```

---

## Phase 4: Prompts

Each prompt task invokes the `prompt-engineering` skill (`/prompt-engineering`) to ensure the template follows current Claude best practices. The task files themselves only need the right structure, the correct placeholders, the tool allowlist documentation in the system prompt, and the structured output contract.

**Every prompt file must:**

1. Open with a strict system prompt block establishing the agent's single purpose.
2. Explicitly prohibit: posting comments, opening PRs, modifying labels, calling non-allowlisted tools.
3. Specify the exact structured output schema the agent must return.
4. Use `{{placeholder}}` syntax for variables the router will substitute.

### Task 4.1: Write triage prompt

**Files:**
- Create: `prompts/triage.md`

- [ ] **Step 1: Invoke prompt-engineering skill**

Run: `/prompt-engineering`

Use the skill to draft a system prompt for the triage agent. Inputs: the purpose and constraints from spec section 5.1. Must produce the structured output schema from spec section 5.1.

- [ ] **Step 2: Save draft to `prompts/triage.md`**

Required placeholders to interpolate: `{{issue_number}}`, `{{issue_title}}`, `{{issue_body}}`, `{{issue_comments}}`, `{{repo_owner}}`, `{{repo_name}}`, `{{claude_md_contents}}` (if any exist in the repo).

Required structured-output contract (copied from spec 5.1):

```json
{
  "status": "classified" | "needs_clarification",
  "complexity": "quick" | "medium" | "large",
  "rationale": "string",
  "clarifying_questions": ["string"]
}
```

- [ ] **Step 3: Manually review the prompt**

Check: no em dashes, no mention of posting comments, explicit prohibition on writing files, allowlist enumerated.

- [ ] **Step 4: Commit**

```bash
git add prompts/triage.md
git commit -m "feat(prompts): add triage stage prompt template"
```

### Task 4.2: Write spec prompt

**Files:**
- Create: `prompts/spec.md`

- [ ] **Step 1: Invoke `/prompt-engineering` for the spec agent.**

- [ ] **Step 2: Save draft**

Placeholders: `{{issue_number}}`, `{{issue_title}}`, `{{issue_body}}`, `{{issue_comments}}`, `{{triage_rationale}}`, `{{branch_name}}`, `{{spec_file_path}}`, `{{repo_owner}}`, `{{repo_name}}`, `{{previous_spec_contents}}` (empty on first run; populated during revisions), `{{review_comments_json}}` (empty on first run).

Structured-output contract:

```json
{
  "file_path": "string",
  "pr_title": "string",
  "pr_body": "string",
  "summary_for_issue_comment": "string"
}
```

- [ ] **Step 3: Commit**

```bash
git add prompts/spec.md
git commit -m "feat(prompts): add spec stage prompt template"
```

### Task 4.3: Write plan prompt

Same shape as 4.2 but for the plan agent. Placeholders additionally include `{{spec_file_contents}}`.

Structured output: same as spec.

Commit message: `feat(prompts): add plan stage prompt template`.

### Task 4.4: Write implement prompt

**Files:**
- Create: `prompts/implement.md`

- [ ] **Step 1: Invoke `/prompt-engineering` for the implementation agent.**

- [ ] **Step 2: Save draft**

Placeholders: `{{issue_number}}`, `{{issue_title}}`, `{{issue_body}}`, `{{spec_file_contents}}`, `{{plan_file_contents}}`, `{{branch_name}}`, `{{progress_comment_id}}` (informational), `{{review_comments_json}}` (empty on first run; populated on revision), `{{iteration_count}}`, `{{bash_allowlist}}`.

Crucial prompt instruction: explicitly tell the agent to invoke `mcp__shopfloor__update_progress` at the start of the run with a TODO checklist parsed from the plan, and to update it as each task completes.

Structured-output contract:

```json
{
  "pr_title": "string",
  "pr_body": "string",
  "summary_for_issue_comment": "string",
  "changed_files": ["string"]
}
```

- [ ] **Step 3: Commit**

```bash
git add prompts/implement.md
git commit -m "feat(prompts): add implement stage prompt template"
```

### Task 4.5: Write review prompts (compliance, bugs, security, smells)

Four separate files: `prompts/review-compliance.md`, `prompts/review-bugs.md`, `prompts/review-security.md`, `prompts/review-smells.md`.

**Common structure for all four:**

- Placeholders: `{{pr_number}}`, `{{pr_title}}`, `{{pr_body}}`, `{{diff}}` (pre-trimmed `git diff base...head`), `{{changed_files}}`, `{{spec_file_contents}}`, `{{plan_file_contents}}`, `{{issue_body}}`, `{{iteration_count}}`, `{{previous_review_comments_json}}` (for follow-up iterations).
- Read-only tool allowlist (Read, Glob, Grep, git read-only Bash).
- Structured output matches spec 5.5.2:

```json
{
  "verdict": "clean" | "issues_found",
  "summary": "string",
  "comments": [
    {
      "path": "string",
      "line": 123,
      "side": "LEFT" | "RIGHT",
      "start_line": 120,
      "start_side": "RIGHT",
      "body": "string",
      "confidence": 90,
      "category": "compliance" | "bug" | "security" | "smell"
    }
  ]
}
```

**Per-reviewer differences:**

- **compliance:** reads `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, and flags violations. Category must be `compliance`.
- **bugs:** reads the spec and plan, flags missed requirements and obvious defects. Category must be `bug`.
- **security:** pattern-based security review. Category must be `security`.
- **smells:** style, duplication, dead code. Category must be `smell`.

For each of the four files:

- [ ] **Step 1: Invoke `/prompt-engineering` for that reviewer**
- [ ] **Step 2: Save draft**
- [ ] **Step 3: Manually review for scope creep (e.g., compliance reviewer commenting on smells)**
- [ ] **Step 4: Commit with message `feat(prompts): add review-<name> stage prompt template`**

### Task 4.6: Prompt snapshot tests

**Files:**
- Create: `router/src/prompt-render.ts`
- Create: `router/test/prompt-render.test.ts`
- Create: `router/test/__snapshots__/` (managed by vitest)

**Purpose:** Lock in that prompt files render correctly given fixture contexts, so accidental edits to the placeholders get caught.

- [ ] **Step 1: Implement a small renderer**

`router/src/prompt-render.ts`:

```ts
import { readFileSync } from 'node:fs';

export function renderPrompt(filePath: string, context: Record<string, string>): string {
  const template = readFileSync(filePath, 'utf-8');
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    if (key in context) return context[key];
    return `{{MISSING:${key}}}`;
  });
}
```

- [ ] **Step 2: Write snapshot test**

```ts
import { expect, test } from 'vitest';
import { renderPrompt } from '../src/prompt-render';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

test('triage prompt renders with fixture context', () => {
  const rendered = renderPrompt(join(repoRoot, 'prompts/triage.md'), {
    issue_number: '42',
    issue_title: 'Add GitHub OAuth',
    issue_body: 'Users want to log in with GitHub.',
    issue_comments: '',
    repo_owner: 'niranjan94',
    repo_name: 'shopfloor',
    claude_md_contents: ''
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain('{{MISSING');
});

// Repeat for spec, plan, implement, review-compliance, review-bugs, review-security, review-smells.
```

- [ ] **Step 3: Run tests**

Run: `pnpm test router/test/prompt-render.test.ts`
Expected: snapshots created on first run, tests pass.

- [ ] **Step 4: Commit**

```bash
git add prompts router/src/prompt-render.ts router/test/prompt-render.test.ts router/test/__snapshots__
git commit -m "test(prompts): add snapshot tests for prompt rendering"
```

---

## Phase 5: Reusable workflow

### Task 5.1: Reusable workflow skeleton with route job

**Files:**
- Create: `.github/workflows/shopfloor.yml`

**Note:** This file contains the public interface. Every input the spec defines (section 6.1) must be declared as a `workflow_call` input.

- [ ] **Step 1: Create `.github/workflows/shopfloor.yml` with the full input surface**

```yaml
name: Shopfloor
on:
  workflow_call:
    inputs:
      triage_model: { type: string, default: sonnet }
      spec_model: { type: string, default: opus }
      plan_model: { type: string, default: opus }
      impl_model: { type: string, default: opus }
      triage_max_turns: { type: number, default: 10 }
      spec_max_turns: { type: number, default: 10 }
      plan_max_turns: { type: number, default: 15 }
      impl_max_turns: { type: number, default: 70 }
      triage_timeout_minutes: { type: number, default: 10 }
      spec_timeout_minutes: { type: number, default: 20 }
      plan_timeout_minutes: { type: number, default: 30 }
      impl_timeout_minutes: { type: number, default: 60 }
      branch_prefix: { type: string, default: 'shopfloor/' }
      artifacts_dir: { type: string, default: 'docs/shopfloor/' }
      impl_bash_allowlist: { type: string, default: 'pnpm install,pnpm test:*,pnpm lint:*,pnpm build,pnpm exec tsc' }
      additional_tools: { type: string, default: '' }
      review_compliance_model: { type: string, default: sonnet }
      review_bugs_model: { type: string, default: opus }
      review_security_model: { type: string, default: opus }
      review_smells_model: { type: string, default: opus }
      review_compliance_max_turns: { type: number, default: 15 }
      review_bugs_max_turns: { type: number, default: 15 }
      review_security_max_turns: { type: number, default: 15 }
      review_smells_max_turns: { type: number, default: 15 }
      review_compliance_enabled: { type: boolean, default: true }
      review_bugs_enabled: { type: boolean, default: true }
      review_security_enabled: { type: boolean, default: true }
      review_smells_enabled: { type: boolean, default: true }
      review_timeout_minutes: { type: number, default: 20 }
      review_confidence_threshold: { type: number, default: 80 }
      max_review_iterations: { type: number, default: 3 }
      use_bedrock: { type: boolean, default: false }
      use_vertex: { type: boolean, default: false }
      use_foundry: { type: boolean, default: false }
      ssh_signing_key_enabled: { type: boolean, default: false }
      keep_artifacts_forever: { type: boolean, default: true }
    secrets:
      anthropic_api_key: { required: false }
      claude_code_oauth_token: { required: false }
      aws_access_key_id: { required: false }
      aws_secret_access_key: { required: false }
      aws_region: { required: false }
      aws_bearer_token_bedrock: { required: false }
      anthropic_vertex_project_id: { required: false }
      cloud_ml_region: { required: false }
      google_application_credentials: { required: false }
      anthropic_foundry_resource: { required: false }
      github_app_id: { required: false }
      github_app_private_key: { required: false }
      ssh_signing_key: { required: false }

concurrency:
  # v0.1 limitation: GitHub Actions concurrency expressions cannot parse the
  # Shopfloor-Issue metadata from a PR body, so we cannot group strictly by
  # origin issue across issue and PR events. We use "issue.number when present,
  # otherwise PR number" which serializes:
  #   - multiple events on the same origin issue
  #   - multiple events on the same PR
  # but NOT events that touch the origin issue and its child PRs simultaneously.
  # Practical impact is minimal because spec/plan/impl PRs write to disjoint
  # file paths (docs/shopfloor/{specs,plans}/... versus source code), so the
  # worst-case race produces stale label state rather than data corruption.
  # The router's state machine detects stale state and emits stage=none when it
  # sees inconsistent labels, so races degrade gracefully.
  group: shopfloor-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  route:
    runs-on: ubuntu-latest
    outputs:
      stage: ${{ steps.router.outputs.stage }}
      issue_number: ${{ steps.router.outputs.issue_number }}
      complexity: ${{ steps.router.outputs.complexity }}
      branch_name: ${{ steps.router.outputs.branch_name }}
      spec_file_path: ${{ steps.router.outputs.spec_file_path }}
      plan_file_path: ${{ steps.router.outputs.plan_file_path }}
      revision_mode: ${{ steps.router.outputs.revision_mode }}
      review_iteration: ${{ steps.router.outputs.review_iteration }}
      impl_pr_number: ${{ steps.router.outputs.impl_pr_number }}
      reason: ${{ steps.router.outputs.reason }}
    steps:
      - uses: actions/checkout@v6
      - id: bootstrap
        uses: ./router
        with:
          helper: bootstrap-labels
          github_token: ${{ secrets.GITHUB_TOKEN }}
      - id: router
        uses: ./router
        with:
          helper: route
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add reusable workflow skeleton with route job"
```

### Task 5.2: Wire triage stage

**Files:**
- Modify: `.github/workflows/shopfloor.yml`

- [ ] **Step 1: Add the `triage` job**

Append under `jobs:`:

```yaml
  triage:
    needs: route
    if: needs.route.outputs.stage == 'triage'
    runs-on: ubuntu-latest
    timeout-minutes: ${{ inputs.triage_timeout_minutes }}
    outputs:
      github_token: ${{ steps.agent.outputs.github_token }}
    steps:
      - uses: actions/checkout@v6
      - name: Build triage prompt
        id: prompt
        run: |
          # TODO: interpolate {{placeholders}} into prompts/triage.md and echo the result
          echo 'prompt_body<<EOF' >> "$GITHUB_OUTPUT"
          cat prompts/triage.md >> "$GITHUB_OUTPUT"
          echo 'EOF' >> "$GITHUB_OUTPUT"
      - id: agent
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.anthropic_api_key }}
          claude_code_oauth_token: ${{ secrets.claude_code_oauth_token }}
          prompt: ${{ steps.prompt.outputs.prompt_body }}
          claude_args: |
            --model ${{ inputs.triage_model }}
            --max-turns ${{ inputs.triage_max_turns }}
            --allowedTools "Read,Glob,Grep,WebFetch"
            --json-schema '{"type":"object","properties":{"status":{"enum":["classified","needs_clarification"]},"complexity":{"enum":["quick","medium","large"]},"rationale":{"type":"string"},"clarifying_questions":{"type":"array","items":{"type":"string"}}},"required":["status"]}'
      - name: Apply triage decision
        if: success()
        run: |
          # TODO: parse steps.agent.outputs.structured_output, call router helpers to post comment and flip labels
          echo "triage decision application not yet implemented"
      - name: Report failure
        if: failure()
        uses: ./router
        with:
          helper: report-failure
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

**Note:** The "Build triage prompt" and "Apply triage decision" steps are placeholders. A follow-up task (5.2a) will replace them with the real interpolation + parse logic via a new `router` helper subcommand (`render-prompt` and `apply-triage-decision`), or inline shell/jq.

- [ ] **Step 2: Commit (skeleton)**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): wire triage stage skeleton with claude-code-action"
```

### Task 5.2a: Add `render-prompt` and `apply-triage-decision` helpers

**Files:**
- Modify: `router/src/helpers/` (add two new helpers)
- Modify: `router/src/index.ts` (register dispatcher entries)
- Modify: `.github/workflows/shopfloor.yml`

**Context:** To keep the workflow clean, move the "interpolate prompt with fixture" and "turn structured output into label flips + comments" into router helpers.

- [ ] **Step 1: Implement `router/src/helpers/render-prompt.ts`**

Reads a prompt file path and a context JSON (as input) and writes the rendered prompt to a file (output path). Uses the `renderPrompt` function already in `router/src/prompt-render.ts`.

- [ ] **Step 2: Implement `router/src/helpers/apply-triage-decision.ts`**

Takes the structured output JSON, calls the adapter to post a comment and flip labels. On `needs_clarification`: post the questions, apply `shopfloor:awaiting-info`. On `classified`: post the rationale, apply complexity + next-stage label.

- [ ] **Step 3: Add both to the dispatcher in `router/src/index.ts`**

- [ ] **Step 4: Write tests for both helpers** (against mocked adapter, following the pattern from earlier helpers)

- [ ] **Step 5: Replace the workflow's placeholder steps with these helper calls**

- [ ] **Step 6: Run tests, rebuild router, commit**

```bash
pnpm test router/test/helpers
pnpm --filter @shopfloor/router build
git add router/src router/test router/dist .github/workflows/shopfloor.yml
git commit -m "feat(workflow): add render-prompt and apply-triage-decision helpers"
```

### Task 5.3: Wire spec stage

**Files:**
- Modify: `.github/workflows/shopfloor.yml`

Follow the same pattern as triage:

1. `spec` job gated on `needs.route.outputs.stage == 'spec'`.
2. Checkout, create branch (`git checkout -b ${{ needs.route.outputs.branch_name }}`).
3. Render spec prompt via `render-prompt` helper.
4. Run `claude-code-action` with spec-specific `--allowedTools` (Read, Glob, Grep, Edit, Write) and spec JSON schema.
5. After the agent step, push the branch and call `open-stage-pr` helper with the structured output fields.
6. Call `advance-state` helper to flip `shopfloor:needs-spec` → `shopfloor:spec-in-review`.
7. `if: failure()` call `report-failure`.

Each substep is its own bullet in the plan. Commit message: `feat(workflow): wire spec stage with branch creation and PR opening`.

### Task 5.4: Wire plan stage

Same shape as spec, different prompt, different tool allowlist (Read, Glob, Grep, Edit, Write, read-only git Bash), different target file path. Commit: `feat(workflow): wire plan stage`.

### Task 5.5: Wire implement stage with MCP config injection

**Files:**
- Modify: `.github/workflows/shopfloor.yml`

**Critical differences from spec/plan:**

- **Pre-work:** create the impl branch, open the PR *before* the agent runs (with placeholder body), post the initial progress comment on that PR, capture its ID.
- **Write the MCP config file** to `$RUNNER_TEMP/shopfloor-mcp.json` with `SHOPFLOOR_COMMENT_ID` set to the captured comment ID.
- **claude_args:** include `--mcp-config $RUNNER_TEMP/shopfloor-mcp.json` and `--allowedTools` including `mcp__shopfloor__update_progress`.
- **Post-work:** update the PR body with agent's final narrative, finalize the progress comment, check `shopfloor:skip-review` (via `check-review-skip`) then apply either `shopfloor:needs-review` or `shopfloor:impl-in-review`.
- **Token threading (spec section 9.3):** capture `claude-code-action`'s minted `github_token` as `steps.agent.outputs.github_token`. All subsequent router-helper steps in the same job pass it as their `github_token` input instead of `secrets.GITHUB_TOKEN`, so the router's GitHub API calls appear under the same bot identity as the agent's. Fall back to `secrets.GITHUB_TOKEN` only when the agent step did not produce a token (failure path).
- **Export the token as a job output:** the job declares `outputs.impl_github_token: ${{ steps.agent.outputs.github_token }}` so downstream jobs in the same workflow run (e.g., the aggregator, if it ever runs in this run) can read it. Note: since the review stage fires on a *separate* workflow run triggered by `synchronize`, this specific output is consumed only within the same-run case (not the impl→review handoff, which crosses workflow runs).

**Concrete workflow shape:**

```yaml
  implement:
    needs: route
    if: needs.route.outputs.stage == 'implement'
    runs-on: ubuntu-latest
    timeout-minutes: ${{ inputs.impl_timeout_minutes }}
    outputs:
      impl_github_token: ${{ steps.agent.outputs.github_token }}
      pr_number: ${{ steps.open_pr.outputs.pr_number }}
      comment_id: ${{ steps.progress.outputs.comment_id }}
    steps:
      - uses: actions/checkout@v6
      - name: Create impl branch
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git checkout -b "${{ needs.route.outputs.branch_name }}"
          git push -u origin "${{ needs.route.outputs.branch_name }}"
      - id: open_pr
        uses: ./router
        with:
          helper: open-stage-pr
          github_token: ${{ secrets.GITHUB_TOKEN }}
          issue_number: ${{ needs.route.outputs.issue_number }}
          stage: implement
          branch_name: ${{ needs.route.outputs.branch_name }}
          base_branch: ${{ github.event.repository.default_branch }}
          pr_title: "[WIP] Implementation for #${{ needs.route.outputs.issue_number }}"
          pr_body: "Shopfloor is drafting this PR now. The body will be replaced when work completes."
          draft: 'false'
      - id: progress
        uses: ./router
        with:
          helper: create-progress-comment
          github_token: ${{ secrets.GITHUB_TOKEN }}
          pr_number: ${{ steps.open_pr.outputs.pr_number }}
      - name: Write Shopfloor MCP config
        run: |
          cat > "$RUNNER_TEMP/shopfloor-mcp.json" <<EOF
          {
            "mcpServers": {
              "shopfloor": {
                "command": "bun",
                "args": ["run", "${{ github.action_path }}/mcp-servers/shopfloor-mcp/index.ts"],
                "env": {
                  "GITHUB_TOKEN": "${{ secrets.GITHUB_TOKEN }}",
                  "REPO_OWNER": "${{ github.repository_owner }}",
                  "REPO_NAME": "${{ github.event.repository.name }}",
                  "SHOPFLOOR_COMMENT_ID": "${{ steps.progress.outputs.comment_id }}",
                  "GITHUB_API_URL": "${{ github.api_url }}"
                }
              }
            }
          }
          EOF
      - name: Render implement prompt
        id: prompt
        uses: ./router
        with:
          helper: render-prompt
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # ... prompt file path and context JSON
      - id: agent
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.anthropic_api_key }}
          claude_code_oauth_token: ${{ secrets.claude_code_oauth_token }}
          prompt: ${{ steps.prompt.outputs.rendered }}
          claude_args: |
            --model ${{ inputs.impl_model }}
            --max-turns ${{ inputs.impl_max_turns }}
            --allowedTools "Read,Glob,Grep,Edit,Write,Bash(${{ inputs.impl_bash_allowlist }}),Bash(git log:*),Bash(git diff:*),mcp__shopfloor__update_progress"
            --mcp-config $RUNNER_TEMP/shopfloor-mcp.json
            --json-schema '<impl schema>'
      - name: Finalize progress comment
        if: always()
        uses: ./router
        with:
          helper: finalize-progress-comment
          github_token: ${{ steps.agent.outputs.github_token || secrets.GITHUB_TOKEN }}
          comment_id: ${{ steps.progress.outputs.comment_id }}
          terminal_state: ${{ job.status == 'success' && 'success' || 'failure' }}
          final_body: ${{ fromJSON(steps.agent.outputs.structured_output).summary_for_issue_comment || 'Implementation ended with errors.' }}
      - name: Update PR body and apply next-state label
        if: success()
        uses: ./router
        with:
          helper: apply-impl-postwork
          github_token: ${{ steps.agent.outputs.github_token || secrets.GITHUB_TOKEN }}
          pr_number: ${{ steps.open_pr.outputs.pr_number }}
          issue_number: ${{ needs.route.outputs.issue_number }}
          pr_title: ${{ fromJSON(steps.agent.outputs.structured_output).pr_title }}
          pr_body: ${{ fromJSON(steps.agent.outputs.structured_output).pr_body }}
      - name: Report failure
        if: failure()
        uses: ./router
        with:
          helper: report-failure
          github_token: ${{ steps.agent.outputs.github_token || secrets.GITHUB_TOKEN }}
          issue_number: ${{ needs.route.outputs.issue_number }}
          stage: implement
          run_url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

Note the new `apply-impl-postwork` helper: takes the agent's PR title/body, updates the PR, runs `check-review-skip` internally, and applies either `shopfloor:needs-review` or `shopfloor:impl-in-review`. Add it alongside `apply-triage-decision` in Task 5.2a or as a follow-up commit under Task 5.5.

Commit: `feat(workflow): wire implement stage with MCP config injection and token threading`.

### Task 5.6: Wire review stage matrix

**Files:**
- Modify: `.github/workflows/shopfloor.yml`

- [ ] **Step 1: Add `review-skip-check` job**

```yaml
  review-skip-check:
    needs: route
    if: needs.route.outputs.stage == 'review'
    runs-on: ubuntu-latest
    outputs:
      skip: ${{ steps.check.outputs.skip }}
      reason: ${{ steps.check.outputs.reason }}
    steps:
      - uses: actions/checkout@v6
      - id: check
        uses: ./router
        with:
          helper: check-review-skip
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Add four reviewer matrix jobs**

For each reviewer (compliance, bugs, security, smells), declare a job like:

```yaml
  review-compliance:
    needs: [route, review-skip-check]
    if: needs.route.outputs.stage == 'review' && needs.review-skip-check.outputs.skip == 'false' && inputs.review_compliance_enabled
    runs-on: ubuntu-latest
    timeout-minutes: ${{ inputs.review_timeout_minutes }}
    outputs:
      structured_output: ${{ steps.agent.outputs.structured_output }}
      github_token: ${{ steps.agent.outputs.github_token }}
    steps:
      - uses: actions/checkout@v6
        with:
          ref: refs/pull/${{ needs.route.outputs.impl_pr_number }}/head
          fetch-depth: 0
      - name: Render compliance prompt
        id: prompt
        uses: ./router
        with:
          helper: render-prompt
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # ... input file path, context JSON
      - id: agent
        uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.anthropic_api_key }}
          prompt: ${{ steps.prompt.outputs.rendered }}
          claude_args: |
            --model ${{ inputs.review_compliance_model }}
            --max-turns ${{ inputs.review_compliance_max_turns }}
            --allowedTools "Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git show:*),WebFetch"
            --json-schema '<paste schema from spec 5.5.2>'
```

Repeat for bugs, security, smells with their respective model/max_turns/enabled inputs.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): wire review stage 4-cell matrix with per-reviewer config"
```

### Task 5.7: Wire review aggregator job

- [ ] **Step 1: Add `review-aggregator` job**

```yaml
  review-aggregator:
    needs: [route, review-skip-check, review-compliance, review-bugs, review-security, review-smells]
    if: always() && needs.route.outputs.stage == 'review' && needs.review-skip-check.outputs.skip == 'false'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: ./router
        with:
          helper: aggregate-review
          # Spec 9.3 token threading: prefer any surviving matrix cell's minted token so the
          # aggregator's posts (the approving or request-changes review, the commit status)
          # appear under the same bot identity as the review agents. Fall back across cells
          # in case one failed; fall back to GITHUB_TOKEN only if all four failed.
          github_token: >-
            ${{
              needs.review-compliance.outputs.github_token ||
              needs.review-bugs.outputs.github_token ||
              needs.review-security.outputs.github_token ||
              needs.review-smells.outputs.github_token ||
              secrets.GITHUB_TOKEN
            }}
          issue_number: ${{ needs.route.outputs.issue_number }}
          pr_number: ${{ needs.route.outputs.impl_pr_number }}
          confidence_threshold: ${{ inputs.review_confidence_threshold }}
          max_iterations: ${{ inputs.max_review_iterations }}
          compliance_output: ${{ needs.review-compliance.outputs.structured_output }}
          bugs_output: ${{ needs.review-bugs.outputs.structured_output }}
          security_output: ${{ needs.review-security.outputs.structured_output }}
          smells_output: ${{ needs.review-smells.outputs.structured_output }}
          workflow_run_url: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

The `if: always()` is intentional: the aggregator runs even if some matrix cells failed, treating their missing output as "no findings" (see spec 13 / aggregator test task 2.9).

Note: `router/action.yml` needs to accept the extra inputs (confidence_threshold, max_iterations, reviewer outputs). Extend its input declarations accordingly before this workflow change compiles.

- [ ] **Step 2: Extend `router/action.yml` with the new inputs**

- [ ] **Step 3: Commit**

```bash
git add router/action.yml .github/workflows/shopfloor.yml
git commit -m "feat(workflow): wire review aggregator job with if-always and per-cell outputs"
```

### Task 5.8: Handle merge transitions

**Files:**
- Modify: `.github/workflows/shopfloor.yml`

- [ ] **Step 1: Add a `handle-merge` job** gated on `pull_request.closed && merged == true && pr has Shopfloor-Stage metadata`

```yaml
  handle-merge:
    needs: route
    if: github.event_name == 'pull_request' && github.event.action == 'closed' && github.event.pull_request.merged == true && startsWith(needs.route.outputs.reason, 'pr_merged_')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: ./router
        with:
          helper: handle-merge
          github_token: ${{ secrets.GITHUB_TOKEN }}
          issue_number: ${{ needs.route.outputs.issue_number }}
          merged_stage: ${{ <derive from reason string> }}
          pr_number: ${{ github.event.pull_request.number }}
```

Derivation of `merged_stage` from `reason`: the router's `reason` output looks like `pr_merged_spec_triggered_label_flip`, `pr_merged_plan_triggered_label_flip`, or `pr_merged_implement_triggered_label_flip`. Extract the middle token with a shell step:

```yaml
      - id: parse_merged_stage
        run: |
          reason='${{ needs.route.outputs.reason }}'
          # Strip the "pr_merged_" prefix and "_triggered_label_flip" suffix
          stage="${reason#pr_merged_}"
          stage="${stage%_triggered_label_flip}"
          echo "merged_stage=$stage" >> "$GITHUB_OUTPUT"
```

Then reference `${{ steps.parse_merged_stage.outputs.merged_stage }}` in the `handle-merge` helper call below.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/shopfloor.yml
git commit -m "feat(workflow): handle PR merge transitions with label flips"
```

### Task 5.9: Handle revision triggers

Add workflow steps that detect `pull_request_review.submitted` with `changes_requested` state and dispatch the correct stage in revision mode. Most of this already happens automatically through the `route` job's state resolution; the extra work is passing the revision context (review comments JSON) into the stage job's prompt.

Commit: `feat(workflow): handle Request-changes and shopfloor:revise revision triggers`.

### Task 5.10: Handle failures with diagnostic comments

Every stage job must include a final `if: failure()` step calling `report-failure`. Loop through all stages and add the step.

Commit: `feat(workflow): handle failures with diagnostic comments and retry labels`.

### Task 5.11: Concurrency and abort

- The `concurrency:` block at workflow top is already in 5.1. Verify it's present.
- Add a guard at the top of the `route` job that emits `stage=none` if the issue is closed, to cheaply short-circuit any further dispatch.

Commit: `feat(workflow): finalize concurrency and closed-issue abort guard`.

---

## Phase 6: End-to-end harness and tests

### Task 6.1: Mock GitHub API server

**Files:**
- Create: `test/e2e/harness/mock-github.ts`

**Purpose:** A small Express-like in-process mock that serves the subset of the GitHub REST API Shopfloor uses. Backed by an in-memory state object (issues, PRs, labels, comments, reviews, statuses).

- [ ] **Step 1: Install `express` or implement with raw `http`**

`pnpm add -D express @types/express`

- [ ] **Step 2: Implement endpoints**

Minimum endpoints:

- `POST /repos/:owner/:repo/issues/:issue/comments`
- `PATCH /repos/:owner/:repo/issues/comments/:id`
- `POST /repos/:owner/:repo/issues/:issue/labels`
- `DELETE /repos/:owner/:repo/issues/:issue/labels/:name`
- `GET /repos/:owner/:repo/labels`
- `POST /repos/:owner/:repo/labels`
- `PATCH /repos/:owner/:repo/issues/:issue`
- `POST /repos/:owner/:repo/pulls`
- `PATCH /repos/:owner/:repo/pulls/:num`
- `GET /repos/:owner/:repo/pulls/:num`
- `GET /repos/:owner/:repo/pulls/:num/files`
- `GET /repos/:owner/:repo/pulls/:num/reviews`
- `POST /repos/:owner/:repo/pulls/:num/reviews`
- `POST /repos/:owner/:repo/statuses/:sha`

Implementation: in-memory maps keyed by repo, issue number, PR number. Return shapes match octokit's `data` field. Track method calls for assertion.

- [ ] **Step 3: Export `startMockServer()` and `getRecordedCalls()`**

- [ ] **Step 4: Commit**

```bash
git add test/e2e/harness/mock-github.ts package.json pnpm-lock.yaml
git commit -m "test(e2e): add in-process mock GitHub API server"
```

### Task 6.2: Mock claude-code-action stub

**Files:**
- Create: `test/e2e/harness/mock-claude-code-action.ts`

**Purpose:** Replace `claude-code-action` with a stub that reads a fixture and returns canned structured output. Used by the orchestrator.

```ts
export function mockClaudeCodeAction(fixturePath: string): { structured_output: string; github_token?: string } {
  const data = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  return { structured_output: JSON.stringify(data), github_token: 'mock-bot-token' };
}
```

Commit: `test(e2e): add mock claude-code-action stub`.

### Task 6.3: Orchestrator harness

**Files:**
- Create: `test/e2e/harness/orchestrator.ts`

**Purpose:** Plays the role of the reusable workflow's job wiring. Given a sequence of events, it:

1. Calls `resolveStage` on each event.
2. For each stage dispatched, simulates the stage job by calling the mock claude-code-action with a fixture, then running the appropriate post-work helpers directly against the mock GitHub API.
3. Records the full call sequence for assertions.

- [ ] **Step 1: Implement `Orchestrator` class**

```ts
import { startMockServer } from './mock-github';
import { mockClaudeCodeAction } from './mock-claude-code-action';
import { GitHubAdapter } from '../../../router/src/github';
import { resolveStage } from '../../../router/src/state';
// import helpers...

export class Orchestrator {
  constructor(private readonly adapter: GitHubAdapter, private readonly fixtures: Record<string, string>) {}

  async handleEvent(eventName: string, payload: unknown): Promise<void> {
    const decision = resolveStage({ eventName, payload: payload as never });
    if (decision.stage === 'none') return;

    switch (decision.stage) {
      case 'triage': {
        const out = mockClaudeCodeAction(this.fixtures['triage']);
        const parsed = JSON.parse(out.structured_output);
        // Apply triage decision via helper
        // ...
        return;
      }
      // ...similar for spec, plan, implement, review
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add test/e2e/harness/orchestrator.ts
git commit -m "test(e2e): add orchestrator harness driving state + helpers"
```

### Task 6.4: Large-complexity happy path test

**Files:**
- Create: `test/e2e/large-happy-path.test.ts`
- Create: `test/e2e/fixtures/large/triage.json`
- Create: `test/e2e/fixtures/large/spec.json`
- Create: `test/e2e/fixtures/large/plan.json`
- Create: `test/e2e/fixtures/large/impl.json`
- Create: `test/e2e/fixtures/large/review-compliance-clean.json`
- Create: `test/e2e/fixtures/large/review-bugs-clean.json`
- Create: `test/e2e/fixtures/large/review-security-clean.json`
- Create: `test/e2e/fixtures/large/review-smells-clean.json`

- [ ] **Step 1: Populate fixtures**

Triage fixture: `{status: "classified", complexity: "large", rationale: "..."}`. Spec/plan/impl fixtures match their stage output schemas. Review fixtures match the reviewer schema with `verdict: "clean"`.

- [ ] **Step 2: Write the e2e test**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from './harness/orchestrator';
// ... setup

describe('large complexity happy path', () => {
  let orch: Orchestrator;
  let mockServer: Awaited<ReturnType<typeof startMockServer>>;

  beforeEach(async () => { mockServer = await startMockServer(); orch = new Orchestrator(/* ... */); });
  afterEach(async () => { await mockServer.close(); });

  test('issue → spec → plan → impl → review(clean) → done', async () => {
    // 1. Simulate issue opened
    await orch.handleEvent('issues', { action: 'opened', issue: { number: 42, title: 'Add OAuth', body: '...', labels: [], state: 'open' }, repository: { owner: { login: 'o' }, name: 'r' } });
    // 2. Simulate label-added events that the orchestrator would fire after stage completions, and so on through the whole pipeline.
    // 3. Assert final state: issue #42 is closed, has label shopfloor:done, the impl PR is approved, commit status is success.

    const calls = mockServer.getRecordedCalls();
    expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/pulls$/) })); // at least one PR opened
    // ... more assertions
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add test/e2e
git commit -m "test(e2e): add large-complexity happy path test"
```

### Task 6.5: Medium and quick happy path tests

Same shape as 6.4 but with different triage fixtures: medium skips spec, quick skips spec+plan.

Commit: `test(e2e): add medium and quick happy path tests`.

### Task 6.6: Triage clarification and abort tests

**Files:**
- Create: `test/e2e/triage-clarification.test.ts`
- Create: `test/e2e/abort.test.ts`

- Triage clarification: fixture returns `{status: "needs_clarification", clarifying_questions: ["..."]}`. Assert that `shopfloor:awaiting-info` is applied and no downstream stages run.
- Abort: in the middle of a pipeline, simulate `issues.closed`. Assert the orchestrator stops.

Commit: `test(e2e): add triage-clarification and abort path tests`.

### Task 6.7: Stage failure test

Simulate a thrown error from the mocked claude-code-action in the middle of the pipeline. Assert that `report-failure` is called, the `shopfloor:failed:<stage>` label is applied, and no subsequent stages run.

Commit: `test(e2e): add stage-failure test`.

### Task 6.8: Review clean first iteration

Set all four reviewer fixtures to `verdict: "clean"`. Run the pipeline through impl. Assert the aggregator posts `APPROVE`, applies `shopfloor:review-approved`, sets commit status to `success`, and does NOT dispatch another impl stage.

Commit: `test(e2e): add review-clean-first-iteration test`.

### Task 6.9: Review passes on second iteration

- **First iteration fixtures:** at least one reviewer produces an `issues_found` with a high-confidence comment.
- **Second iteration fixtures:** after the impl agent "revises," all four reviewers return clean.

Assert iteration counter flows from 0 → 1 after first review, then from 1 → still 1 after clean (no increment on clean). Assert both reviews are posted on the PR. Assert the PR ends in `shopfloor:review-approved`.

Commit: `test(e2e): add review-passes-second-iteration test`.

### Task 6.10: Review iteration cap

Fixtures: every review iteration produces `issues_found`. Run the pipeline. Assert that after iteration N=max_iterations, the aggregator applies `shopfloor:review-stuck`, posts a takeover comment, and does not dispatch another impl stage.

Commit: `test(e2e): add review-iteration-cap test`.

### Task 6.11: Verify full test suite passes

- [ ] Run: `pnpm test`
- Expected: all unit and e2e tests pass.
- If any fail, fix forward. Do not skip tests.

Commit (if any fixes): `fix: resolve test failures in full suite run`.

---

## Phase 7: Docs

### Task 7.1: README with install and pitch

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write one-sentence pitch + the three install steps from spec section 8**
- [ ] **Step 2: Include the caller workflow copy-paste block with correct permissions**
- [ ] **Step 3: Link to deeper docs under `docs/shopfloor/`**
- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): add install guide and one-sentence pitch"
```

### Task 7.2: Install guide

**Files:**
- Create: `docs/shopfloor/install.md`

Covers: secret setup, Claude GitHub App install, caller workflow copy-paste, first-run bootstrap walkthrough, optional custom GitHub App.

Commit: `docs(user): add install guide`.

### Task 7.3: Configuration guide

**Files:**
- Create: `docs/shopfloor/configuration.md`

Document every input from spec section 6.1 with a usage example.

Commit: `docs(user): add configuration guide`.

### Task 7.4: Troubleshooting guide

**Files:**
- Create: `docs/shopfloor/troubleshooting.md`

Cover: branch protection, signed commits, CODEOWNERS, GHES, custom PR templates, failed stages, review-stuck recovery, skip-review usage.

Commit: `docs(user): add troubleshooting guide`.

### Task 7.5: Architecture doc (user-facing)

**Files:**
- Create: `docs/shopfloor/architecture.md`

A plain-English summary of the state machine, router/agent boundary, and review loop. Lighter than the spec.

Commit: `docs(user): add architecture guide`.

### Task 7.6: FAQ

**Files:**
- Create: `docs/shopfloor/FAQ.md`

Common questions: "Will this commit secrets?", "Does it work on private repos?", "Can I override the model per stage?", "What if I don't want the agent to review my PR?", "How do I pause the pipeline?".

Commit: `docs(user): add FAQ`.

---

## Phase 8: Dogfood and release

### Task 8.1: Dogfood caller workflow

**Files:**
- Create: `.github/workflows/dogfood.yml`

```yaml
name: Shopfloor on Shopfloor
on:
  issues:
    types: [opened, edited, closed, labeled, unlabeled]
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, synchronize, closed, labeled, unlabeled]
  pull_request_review:
    types: [submitted]

jobs:
  shopfloor:
    uses: ./.github/workflows/shopfloor.yml
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
      actions: read
      statuses: write
      checks: read
    secrets: inherit
```

Commit: `feat(dogfood): add self-hosted caller workflow for dogfooding`.

### Task 8.2: CI workflow for lint + tests

**Files:**
- Create: `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck:all
      - run: pnpm test
      - run: pnpm format:check
      - run: pnpm --filter @shopfloor/router build
      - name: Verify router dist is up to date
        run: |
          if ! git diff --exit-code router/dist; then
            echo "router/dist is out of date. Run 'pnpm --filter @shopfloor/router build' and commit."
            exit 1
          fi
```

Commit: `ci: add lint, test, and router-dist verification workflow`.

### Task 8.3: Run dogfood end-to-end on a real issue

- [ ] **Step 1: Open a test issue on the Shopfloor repo** (via `gh issue create`)
- [ ] **Step 2: Wait for Shopfloor to run** through all stages
- [ ] **Step 3: Manually inspect:** was the spec written well? Did the plan PR make sense? Did the impl agent produce real changes? Did the review loop work? Did the commit status flip correctly?
- [ ] **Step 4: Fix any real-world bugs** in separate follow-up commits with `fix:` prefix.
- [ ] **Step 5: Close the test issue** or merge the full pipeline.

This is the single most important validation step in the whole plan. Do not skip.

### Task 8.4: Tag v1.0.0-rc.1

- [ ] **Step 1: Run `pnpm test` one final time** to confirm everything green
- [ ] **Step 2: Verify `router/dist/index.js` is committed and current**
- [ ] **Step 3: Update `CHANGELOG.md` with v1.0.0-rc.1 entry**
- [ ] **Step 4: Tag**

```bash
git tag -a v1.0.0-rc.1 -m "Shopfloor v1.0.0-rc.1"
git push origin v1.0.0-rc.1
```

- [ ] **Step 5: Create a v1 moving tag** (so users can `@v1` their caller workflow)

The `-f` on `push` here is deliberate and limited to the `v1` tag ref. This is the standard pattern for JS GitHub Actions that publish a moving major-version tag. The user's non-negotiable rule against force-pushing applies to *branches* (especially `main`/`master`), not to moving version tags. If in doubt, skip the force-push and create `v1.0.0-rc.2` instead.

```bash
git tag -fa v1 -m "v1 moving tag points to v1.0.0-rc.1"
git push -f origin v1
```

- [ ] **Step 6: Commit `CHANGELOG.md` update**

```bash
git add CHANGELOG.md
git commit -m "chore(release): v1.0.0-rc.1"
```

- [ ] **Step 7: Announce** in README that v1 is available.

---

## Risks and mitigations captured during planning

- **esbuild bundling of router helpers requires all helpers to be static imports** from `index.ts`. Dynamic requires break bundling. All helpers follow this pattern already.
- **@actions/github's `getOctokit` return type** differs from `@octokit/rest`'s `Octokit` class. Workaround: `GitHubAdapter` constructor types the parameter as a minimal structural interface, or uses `as unknown as Octokit` at the call site in `index.ts`. Callers in tests use the `@octokit/rest` shape directly.
- **Prompt file interpolation** happens via a shared helper (`renderPrompt`) rather than shell envsubst to handle multi-line values and special characters correctly.
- **Matrix cell failures** are tolerated by the aggregator's `if: always()` guard and the helper's "empty output = no findings" logic. Tests cover this explicitly (task 2.9).
- **Iteration counter desync** (e.g., a human manually edits the PR body and removes the counter) is handled by treating a missing counter as 0, which in the worst case runs one extra review iteration.
- **Token threading between jobs**: the impl job re-exports `claude-code-action`'s minted token as its own output. Downstream jobs read `needs.implement.outputs.impl_github_token`. Jobs that run before any `claude-code-action` invocation fall back to `secrets.GITHUB_TOKEN`.
- **`act` limitations** prevent full workflow-level e2e testing. The harness instead tests at the helper + state machine level, which is sufficient because the workflow YAML itself is thin wiring.
- **Bundled router/dist in git** is an eyesore but standard for JS GitHub Actions referenced by tag. CI verifies it is up to date.

---

## Definition of done

- [ ] All phases complete
- [ ] `pnpm test` passes on main
- [ ] `pnpm typecheck:all` passes
- [ ] `router/dist/index.js` committed and in sync with `router/src`
- [ ] Dogfood task 8.3 completed successfully on a real issue
- [ ] `v1.0.0-rc.1` tag pushed
- [ ] `v1` moving tag pushed
- [ ] README has install instructions, pitch, and links to `docs/shopfloor/`
- [ ] Spec document referenced from README

---

**End of plan.**
