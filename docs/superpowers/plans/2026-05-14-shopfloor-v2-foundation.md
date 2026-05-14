# Shopfloor v2 — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation libraries for Shopfloor v2 — state machine port, GitHub adapter, AgentAdapter interface plus Claude SDK implementation, audit/event emitter, shared agent tool factories, and input validation. End state: a `src/` tree with all non-stage code in place, all unit tests green. No stages, no orchestrator, no action shell yet (those are Plans 2 and 3).

**Architecture:** Single-package TypeScript library under `src/`, built with esbuild, tested with vitest. State machine and GitHub adapter are direct ports of v1 (`router/src/state.ts`, `router/src/github.ts`) with the same snapshot tests. AgentAdapter is a small interface; Claude implementation wraps `@anthropic-ai/claude-agent-sdk` and translates the interface into SDK calls. Audit events are JSONL on stdout with a step-summary mirror. All tests are hermetic except a gated live test for the Claude adapter.

**Tech Stack:** TypeScript, `@actions/core`, `@octokit/rest`, `@octokit/auth-app`, `@anthropic-ai/claude-agent-sdk`, `zod`, `zod-to-json-schema`, `vitest`, esbuild, pnpm.

**Source of truth:** `docs/superpowers/specs/2026-05-14-shopfloor-v2-design.md`. Every ambiguity resolves to that spec.

**Branch:** All work happens on `v2`. Create the branch from `main` before Task 1 if it does not exist:
```bash
git checkout -b v2 main
git push -u origin v2
```

---

## Repository layout (after Plan 1)

```
shopfloor/
├── src/
│   ├── state/
│   │   ├── machine.ts
│   │   ├── labels.ts
│   │   └── metadata.ts
│   ├── github/
│   │   ├── adapter.ts
│   │   ├── app-token.ts
│   │   └── pr-metadata.ts
│   ├── agents/
│   │   ├── adapter.ts          # AgentAdapter interface
│   │   ├── claude.ts           # Agent SDK implementation
│   │   └── mock.ts             # MockAgentAdapter for stage tests
│   ├── tools/
│   │   ├── types.ts            # SdkTool type alias
│   │   └── update-progress.ts
│   ├── audit/
│   │   ├── events.ts
│   │   └── step-summary.ts
│   └── config/
│       └── inputs.ts
├── test/
│   ├── state/                  # ported from router/test/
│   ├── github/
│   ├── agents/
│   ├── tools/
│   ├── audit/
│   ├── config/
│   └── fixtures/               # ported from router/test/fixtures/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── esbuild.config.mjs           # not yet wired to action, but configured
```

Plans 2 and 3 add `src/stages/`, `src/orchestrator.ts`, `src/entry.ts`, `action.yml`, `examples/`, and `dist/`.

---

## Task 1: Scaffold the v2 package

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`, `src/index.ts`, `test/smoke.test.ts`
- Note: in the v2 branch, the existing `router/`, `mcp-servers/`, `prompts/`, and `.github/workflows/shopfloor.yml` stay untouched until Plan 3's cutover task. The new `src/` lives alongside them.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "shopfloor",
  "version": "2.0.0-alpha.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:live": "vitest run --reporter=verbose test/agents/claude.live.test.ts",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "dependencies": {
    "@actions/core": "^1.11.1",
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "@octokit/auth-app": "^7.1.5",
    "@octokit/rest": "^21.0.2",
    "zod": "^3.23.8",
    "zod-to-json-schema": "^3.23.5"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "esbuild": "^0.24.0",
    "prettier": "^3.3.3",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

Pin `@anthropic-ai/claude-agent-sdk` to whatever the latest stable is at execution time; `^0.1.0` is illustrative. Verify the version via `pnpm view @anthropic-ai/claude-agent-sdk versions --json | tail -5` before pinning.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*", "test/**/*", "esbuild.config.mjs"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.live.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
    },
  },
});
```

Live tests are excluded by default. `pnpm test:live` runs them explicitly.

- [ ] **Step 4: Create `esbuild.config.mjs`**

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/entry.ts"],  // does not exist yet; Plan 3 creates it
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: "inline",
  legalComments: "external",
  logLevel: "info",
});
```

The config builds but `pnpm build` will fail until Plan 3's entry.ts exists. That is expected.

- [ ] **Step 5: Create `src/index.ts` as a placeholder**

```ts
export const SHOPFLOOR_V2_VERSION = "2.0.0-alpha.0";
```

- [ ] **Step 6: Create `test/smoke.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { SHOPFLOOR_V2_VERSION } from "../src/index.js";

describe("smoke", () => {
  it("exports a version", () => {
    expect(SHOPFLOOR_V2_VERSION).toMatch(/^2\./);
  });
});
```

- [ ] **Step 7: Install and verify**

```bash
pnpm install
pnpm test
pnpm exec tsc --noEmit
```

Expected: install succeeds, smoke test passes, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts esbuild.config.mjs src/index.ts test/smoke.test.ts pnpm-lock.yaml
git commit -m "chore(v2): scaffold src/ tree and toolchain"
```

---

## Task 2: Port label vocabulary

**Files:**
- Create: `src/state/labels.ts`
- Create: `test/state/labels.test.ts`
- Read for reference: `router/src/state.ts:1-90` (the label constants section)

- [ ] **Step 1: Write `test/state/labels.test.ts` enumerating the expected label vocabulary**

```ts
import { describe, expect, it } from "vitest";
import {
  LABELS,
  isShopfloorLabel,
  isRunningLabel,
  isFailedLabel,
  failedLabelFor,
  runningLabelFor,
  complexityLabel,
  needsLabelFor,
} from "../../src/state/labels.js";

describe("labels", () => {
  it("namespaces all labels under shopfloor:", () => {
    for (const label of Object.values(LABELS)) {
      expect(label.startsWith("shopfloor:")).toBe(true);
    }
  });

  it("identifies shopfloor labels", () => {
    expect(isShopfloorLabel("shopfloor:triaging")).toBe(true);
    expect(isShopfloorLabel("bug")).toBe(false);
  });

  it("identifies running and failed labels", () => {
    expect(isRunningLabel("shopfloor:spec-running")).toBe(true);
    expect(isFailedLabel("shopfloor:failed:implement")).toBe(true);
  });

  it("derives stage-specific failed/running labels", () => {
    expect(failedLabelFor("implement")).toBe("shopfloor:failed:implement");
    expect(runningLabelFor("review")).toBe("shopfloor:review-running");
  });

  it("derives complexity and needs labels", () => {
    expect(complexityLabel("large")).toBe("shopfloor:complexity:large");
    expect(needsLabelFor("spec")).toBe("shopfloor:needs-spec");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```bash
pnpm test test/state/labels.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/state/labels.ts`**

Open `router/src/state.ts` and locate the label constants near the top (lines roughly 1-90 in v1). Port them verbatim into `src/state/labels.ts`. Keep names identical. Group them into a single `LABELS` const-object plus the helper predicates and derivers used by the tests.

Skeleton:

```ts
export const STAGES = ["triage", "spec", "plan", "implement", "review"] as const;
export type Stage = (typeof STAGES)[number];

export const COMPLEXITIES = ["quick", "medium", "large"] as const;
export type Complexity = (typeof COMPLEXITIES)[number];

export const LABELS = {
  triaging: "shopfloor:triaging",
  triageNeeded: "shopfloor:triage",
  needsSpec: "shopfloor:needs-spec",
  specRunning: "shopfloor:spec-running",
  specInReview: "shopfloor:spec-in-review",
  needsPlan: "shopfloor:needs-plan",
  planRunning: "shopfloor:plan-running",
  planInReview: "shopfloor:plan-in-review",
  needsImpl: "shopfloor:needs-impl",
  implementing: "shopfloor:implementing",
  implInReview: "shopfloor:impl-in-review",
  needsReview: "shopfloor:needs-review",
  reviewRunning: "shopfloor:review-running",
  reviewStuck: "shopfloor:review-stuck",
  done: "shopfloor:done",
  skipReview: "shopfloor:skip-review",
} as const;

export function isShopfloorLabel(name: string): boolean {
  return name.startsWith("shopfloor:");
}

export function isRunningLabel(name: string): boolean {
  return /^shopfloor:[a-z]+-running$/.test(name);
}

export function isFailedLabel(name: string): boolean {
  return name.startsWith("shopfloor:failed:");
}

export function failedLabelFor(stage: Stage): string {
  return `shopfloor:failed:${stage}`;
}

export function runningLabelFor(stage: Stage): string {
  return `shopfloor:${stage}-running`;
}

export function complexityLabel(c: Complexity): string {
  return `shopfloor:complexity:${c}`;
}

export function needsLabelFor(stage: Exclude<Stage, "triage" | "review">): string {
  const map = { spec: "shopfloor:needs-spec", plan: "shopfloor:needs-plan", implement: "shopfloor:needs-impl" } as const;
  return map[stage];
}
```

Cross-check against v1: every label v1 uses must appear here, even if a test does not exercise it. Search `router/src/state.ts` for `"shopfloor:"` to enumerate.

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test test/state/labels.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/labels.ts test/state/labels.test.ts
git commit -m "feat(state): port label vocabulary to src/state/labels.ts"
```

---

## Task 3: Port metadata parsers

**Files:**
- Create: `src/state/metadata.ts`
- Create: `test/state/metadata.test.ts`
- Read for reference: `router/src/state.ts:83-167` (parsePrMetadata, parseIssueMetadata, parseStageBranchRef, branchSlug)

- [ ] **Step 1: Copy v1 metadata-related tests**

Copy `router/test/state-pr-metadata.test.ts` and any test that exercises `parsePrMetadata`, `parseIssueMetadata`, `parseStageBranchRef`, or `branchSlug` from `router/test/` into `test/state/metadata.test.ts`. Update imports to point at `../../src/state/metadata.js`. Do not change the test bodies.

If v1 has snapshot files for these tests under `router/test/__snapshots__/`, copy them to `test/state/__snapshots__/`.

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/state/metadata.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Port `parsePrMetadata`, `parseIssueMetadata`, `parseStageBranchRef`, `branchSlug` from `router/src/state.ts`**

Copy the four functions and any local helpers they call into `src/state/metadata.ts`. Update internal imports. Keep behavior identical.

Public API of `src/state/metadata.ts`:

```ts
export function parsePrMetadata(body: string | null | undefined): PrMetadata | null;
export function parseIssueMetadata(body: string | null | undefined): IssueMetadata | null;
export function parseStageBranchRef(ref: string): StageBranchRef | null;
export function branchSlug(title: string): string;

export type PrMetadata = { issueNumber: number; stage: Stage; reviewIteration: number };
export type IssueMetadata = { slug?: string; specPath?: string; planPath?: string };
export type StageBranchRef = { stage: "spec" | "plan" | "impl"; issueNumber: number; slug: string };
```

Import `Stage` from `./labels.js`.

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test test/state/metadata.test.ts
```

Expected: PASS, including any snapshot matches.

- [ ] **Step 5: Commit**

```bash
git add src/state/metadata.ts test/state/metadata.test.ts test/state/__snapshots__/
git commit -m "feat(state): port PR/issue/branch metadata parsers"
```

---

## Task 4: Port the state machine

**Files:**
- Create: `src/state/machine.ts`
- Create: `test/state/machine.test.ts`
- Read for reference: `router/src/state.ts` (full file), `router/test/state.test.ts`, `router/src/types.ts:1-332`

- [ ] **Step 1: Port shared types**

Add a `src/state/types.ts` (or append to `machine.ts` if small) containing the shared decision types from `router/src/types.ts` — `RouterDecision`, `StateContext`, `StageContext`-related shapes referenced by `resolveStage`. Do not pull in types specific to v1 helpers (e.g. `OpenStagePrInput`); only what `resolveStage` needs.

- [ ] **Step 2: Copy v1's state-machine test file verbatim**

Copy `router/test/state.test.ts` to `test/state/machine.test.ts`. Update imports:

```ts
import { resolveStage, computeStageFromLabels } from "../../src/state/machine.js";
import { LABELS } from "../../src/state/labels.js";
```

Copy any fixtures it depends on (`router/test/fixtures/events/*`) to `test/fixtures/events/`. Update fixture-loading paths.

Copy `router/test/__snapshots__/state.test.ts.snap` (if present) to `test/state/__snapshots__/machine.test.ts.snap`. Rename inner snapshot keys to match the new test file name.

- [ ] **Step 3: Run, expect failure**

```bash
pnpm test test/state/machine.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Port `resolveStage` and friends from `router/src/state.ts`**

Copy `resolveStage`, `computeStageFromLabels`, `resolveIssueEvent`, `resolvePullRequestEvent`, and any local helpers into `src/state/machine.ts`. Update imports:

```ts
import { LABELS, STAGES, type Stage, type Complexity, complexityLabel, needsLabelFor, failedLabelFor, runningLabelFor } from "./labels.js";
import { parsePrMetadata, parseIssueMetadata, parseStageBranchRef, branchSlug } from "./metadata.js";
```

Keep function names and signatures identical to v1. Do not refactor.

- [ ] **Step 5: Run all state tests**

```bash
pnpm test test/state/
```

Expected: PASS. All snapshots match. If a snapshot drifts, the port introduced a behavior change — investigate and fix the port, never update the snapshot.

- [ ] **Step 6: Commit**

```bash
git add src/state/machine.ts src/state/types.ts test/state/machine.test.ts test/state/__snapshots__/ test/fixtures/
git commit -m "feat(state): port resolveStage and event routing to src/state/machine.ts"
```

---

## Task 5: Port the GitHub App token mint

**Files:**
- Create: `src/github/app-token.ts`
- Create: `test/github/app-token.test.ts`
- Read for reference: `mcp-servers/shopfloor-mcp/index.ts:25-119` (JWT + installation token), `router/src/github.ts` (any App-token usage)

- [ ] **Step 1: Write `test/github/app-token.test.ts`**

The mint function is mostly I/O; test the cache and JWT-encoding behavior with mocked Octokit.

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mintInstallationToken, __resetTokenCache } from "../../src/github/app-token.js";

describe("mintInstallationToken", () => {
  beforeEach(() => __resetTokenCache());

  it("returns a token from the mock auth function", async () => {
    const auth = vi.fn().mockResolvedValue({ token: "ghs_test", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const tok = await mintInstallationToken({
      clientId: "Iv23test",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nstub\n-----END RSA PRIVATE KEY-----\n",
      owner: "octo",
      repo: "demo",
      authFactory: () => auth,
    });
    expect(tok).toBe("ghs_test");
    expect(auth).toHaveBeenCalledOnce();
  });

  it("caches the token for the configured margin", async () => {
    const auth = vi.fn().mockResolvedValue({ token: "ghs_test", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const args = {
      clientId: "Iv23test",
      privateKey: "k",
      owner: "octo",
      repo: "demo",
      authFactory: () => auth,
    };
    await mintInstallationToken(args);
    await mintInstallationToken(args);
    expect(auth).toHaveBeenCalledOnce();
  });

  it("refreshes when token is within the expiry margin", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString(); // 1 minute
    const later = new Date(Date.now() + 3600_000).toISOString();
    const auth = vi.fn().mockResolvedValueOnce({ token: "first", expiresAt: soon })
                       .mockResolvedValueOnce({ token: "second", expiresAt: later });
    const args = {
      clientId: "Iv23test", privateKey: "k", owner: "octo", repo: "demo",
      authFactory: () => auth,
      expiryMarginMs: 5 * 60_000,
    };
    expect(await mintInstallationToken(args)).toBe("first");
    expect(await mintInstallationToken(args)).toBe("second");
    expect(auth).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/github/app-token.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/github/app-token.ts`**

Use `@octokit/auth-app` directly rather than re-rolling JWT signing. The v1 MCP server reimplemented JWT signing inline; we replace that with the official package.

```ts
import { createAppAuth } from "@octokit/auth-app";

export interface MintArgs {
  clientId: string;
  privateKey: string;
  owner: string;
  repo: string;
  /** Inject for tests */
  authFactory?: (opts: { appId: string; privateKey: string }) => (req: { type: "installation"; installationId: number }) => Promise<{ token: string; expiresAt: string }>;
  /** Refresh tokens that expire within this margin */
  expiryMarginMs?: number;
}

type CacheEntry = { token: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export function __resetTokenCache(): void {
  cache.clear();
}

export async function mintInstallationToken(args: MintArgs): Promise<string> {
  const margin = args.expiryMarginMs ?? 5 * 60_000;
  const key = `${args.clientId}|${args.owner}/${args.repo}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt - Date.now() > margin) return cached.token;

  const authFn = args.authFactory
    ? args.authFactory({ appId: args.clientId, privateKey: args.privateKey })
    : createAppAuth({ appId: args.clientId, privateKey: args.privateKey });

  const installationId = await resolveInstallationId(args);
  const result = await authFn({ type: "installation", installationId });
  cache.set(key, { token: result.token, expiresAt: new Date(result.expiresAt).getTime() });
  return result.token;
}

async function resolveInstallationId(args: MintArgs): Promise<number> {
  // Implementation: GET /repos/:owner/:repo/installation with a JWT-authenticated client.
  // Use createAppAuth(...) once with { type: "app" } to obtain a JWT, then call the REST endpoint.
  // Tests inject `authFactory` and skip this path; cover it in a separate integration test or
  // hand-test in Plan 3's smoke.
  throw new Error("resolveInstallationId: implement when wiring entry.ts in Plan 3");
}
```

Acceptable to leave `resolveInstallationId` as a `throw` for now — Plan 3 wires the entry point and supplies the installation ID, since in GitHub Actions the installation ID is discoverable from the event payload or via `actions/create-github-app-token`. Document this in a code comment.

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test test/github/app-token.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github/app-token.ts test/github/app-token.test.ts
git commit -m "feat(github): add App-token mint with caching"
```

---

## Task 6: Port the GitHub adapter

**Files:**
- Create: `src/github/adapter.ts`
- Create: `src/github/pr-metadata.ts`
- Create: `test/github/adapter.test.ts`
- Read for reference: `router/src/github.ts` (full file), `router/test/github.test.ts`

- [ ] **Step 1: Port v1 GitHubAdapter test verbatim**

Copy `router/test/github.test.ts` to `test/github/adapter.test.ts`. Update imports:

```ts
import { GitHubAdapter } from "../../src/github/adapter.js";
```

If the v1 test relies on a mocked Octokit factory, port the mock into `test/github/_mock-octokit.ts` and import.

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/github/adapter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Port `GitHubAdapter` from `router/src/github.ts`**

Copy the class into `src/github/adapter.ts`. Trim methods that exist only to support v1 helpers we are not porting (review carefully — most methods will stay). Update internal type imports to point at `../state/labels.js`, `../state/metadata.js`.

Methods retained at minimum (verify against v1 — this list is illustrative, not authoritative):

```ts
class GitHubAdapter {
  constructor(opts: { octokit: Octokit; owner: string; repo: string });

  // labels
  getIssueLabels(issueNumber: number): Promise<string[]>;
  replaceLabels(issueNumber: number, change: { add?: string[]; remove?: string[] }): Promise<void>;
  ensureLabelsExist(labels: Array<{ name: string; color: string; description?: string }>): Promise<void>;

  // issues
  getIssue(issueNumber: number): Promise<Issue>;
  upsertIssueMetadata(issueNumber: number, md: IssueMetadata): Promise<void>;
  addIssueComment(issueNumber: number, body: string): Promise<{ id: number }>;
  updateIssueComment(commentId: number, body: string): Promise<void>;

  // PRs
  getPullRequest(prNumber: number): Promise<PullRequest>;
  createPullRequest(args: CreatePrArgs): Promise<{ number: number }>;
  updatePullRequestBody(prNumber: number, body: string): Promise<void>;
  setPullRequestDraft(prNumber: number, draft: boolean): Promise<void>;
  listPullRequestFiles(prNumber: number): Promise<File[]>;
  listPullRequestReviewComments(prNumber: number): Promise<ReviewComment[]>;

  // branches
  createOrUpdateRef(ref: string, sha: string): Promise<void>;
  getRef(ref: string): Promise<{ sha: string } | null>;
  createCommit(args: { branch: string; message: string; files: Array<{ path: string; content: string }> }): Promise<{ sha: string }>;

  // reviews (used by the review stage; some calls require the review-App adapter)
  postReview(prNumber: number, args: { event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string; comments?: ReviewComment[] }): Promise<void>;
}
```

Move `parsePrMetadata`/`parseIssueMetadata` helpers' GitHub-side writers (e.g. `upsertIssueMetadata`) into `src/github/pr-metadata.ts`. The parsers stay in `src/state/metadata.ts`; the GitHub-mutating writers live with the adapter.

`src/github/pr-metadata.ts` must export `renderPrBodyWithMetadata`, which Plan 2's stage `apply*` files import. Signature and behavior:

```ts
import type { Stage } from "../state/labels.js";

export interface PrBodyArgs {
  issueNumber: number;
  stage: Stage;
  reviewIteration: number;
  userBody: string;
}

export function renderPrBodyWithMetadata(args: PrBodyArgs): string {
  const meta = [
    `Shopfloor-Issue: #${args.issueNumber}`,
    `Shopfloor-Stage: ${args.stage}`,
    `Shopfloor-Review-Iteration: ${args.reviewIteration}`,
  ].join("\n");
  return `${args.userBody.trimEnd()}\n\n<!-- shopfloor:metadata -->\n${meta}\n<!-- /shopfloor:metadata -->\n`;
}
```

Add a unit test (`test/github/pr-metadata.test.ts`) covering: a fresh body gets the metadata block appended; round-trip with `parsePrMetadata` (from `src/state/metadata.ts`) recovers the same fields.

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test test/github/
```

Expected: PASS. If a v1 test exercises a helper-specific method we did not port, either port the method or delete that test (record which) — but only if the method is truly unused by Plans 2 and 3.

- [ ] **Step 5: Commit**

```bash
git add src/github/adapter.ts src/github/pr-metadata.ts test/github/adapter.test.ts test/github/_mock-octokit.ts
git commit -m "feat(github): port GitHubAdapter to src/github/adapter.ts"
```

---

## Task 7: AgentAdapter interface and MockAgentAdapter

**Files:**
- Create: `src/agents/adapter.ts`
- Create: `src/agents/mock.ts`
- Create: `src/tools/types.ts`
- Create: `test/agents/mock.test.ts`

- [ ] **Step 1: Write `test/agents/mock.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockAgentAdapter } from "../../src/agents/mock.js";

describe("MockAgentAdapter", () => {
  const Schema = z.object({ verdict: z.enum(["ok", "bad"]) });

  it("returns the canned decision matching a prompt prefix", async () => {
    const agent = new MockAgentAdapter([
      { matchUserPromptIncludes: "issue-42", decision: { verdict: "ok" } },
    ]);
    const result = await agent.runStage({
      systemPrompt: "you are triage",
      userPrompt: "please triage issue-42",
      tools: [],
      decisionSchema: Schema,
      model: "claude-haiku",
    });
    expect(result).toEqual({ verdict: "ok" });
  });

  it("throws when no canned decision matches", async () => {
    const agent = new MockAgentAdapter([]);
    await expect(
      agent.runStage({
        systemPrompt: "", userPrompt: "unmatched", tools: [], decisionSchema: Schema, model: "claude-haiku",
      })
    ).rejects.toThrow(/no canned decision/i);
  });

  it("supports throwing a canned error", async () => {
    const agent = new MockAgentAdapter([{ matchUserPromptIncludes: "boom", error: { kind: "agent_budget", message: "over" } }]);
    await expect(
      agent.runStage({
        systemPrompt: "", userPrompt: "boom", tools: [], decisionSchema: Schema, model: "claude-haiku",
      })
    ).rejects.toMatchObject({ kind: "agent_budget" });
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/agents/mock.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/types.ts`**

```ts
// Placeholder type — Plan 1 only uses tools structurally. The Claude adapter
// translates these into createSdkMcpServer() invocations; the mock ignores them.
export type SdkTool = {
  name: string;
  description: string;
  inputSchema: unknown;       // Zod raw shape at call sites
  handler: (input: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
};
```

- [ ] **Step 4: Implement `src/agents/adapter.ts`**

```ts
import type { z } from "zod";
import type { SdkTool } from "../tools/types.js";

export type AgentErrorKind =
  | "agent_timeout"
  | "agent_budget"
  | "agent_max_turns"
  | "agent_invalid_output"
  | "agent_execution";

export class AgentError extends Error {
  constructor(public readonly kind: AgentErrorKind, message: string, public readonly subtype?: string) {
    super(message);
    this.name = "AgentError";
  }
}

export interface RunStageArgs<T> {
  systemPrompt: string;
  userPrompt: string;
  tools: SdkTool[];
  decisionSchema: z.ZodType<T>;
  model: string;
  budgetUsd?: number;
  timeoutMs?: number;
  abortController?: AbortController;
}

export interface AgentAdapter {
  runStage<T>(args: RunStageArgs<T>): Promise<T>;
}
```

- [ ] **Step 5: Implement `src/agents/mock.ts`**

```ts
import type { AgentAdapter, AgentErrorKind, RunStageArgs } from "./adapter.js";
import { AgentError } from "./adapter.js";

export type CannedResponse =
  | { matchUserPromptIncludes: string; decision: unknown }
  | { matchUserPromptIncludes: string; error: { kind: AgentErrorKind; message: string } };

export class MockAgentAdapter implements AgentAdapter {
  constructor(private readonly responses: CannedResponse[]) {}

  async runStage<T>(args: RunStageArgs<T>): Promise<T> {
    for (const r of this.responses) {
      if (!args.userPrompt.includes(r.matchUserPromptIncludes)) continue;
      if ("error" in r) throw new AgentError(r.error.kind, r.error.message);
      return args.decisionSchema.parse(r.decision);
    }
    throw new Error(`MockAgentAdapter: no canned decision matched prompt: ${args.userPrompt.slice(0, 80)}`);
  }
}
```

- [ ] **Step 6: Run tests, expect pass**

```bash
pnpm test test/agents/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agents/adapter.ts src/agents/mock.ts src/tools/types.ts test/agents/mock.test.ts
git commit -m "feat(agents): introduce AgentAdapter interface and MockAgentAdapter"
```

---

## Task 8: Claude Agent SDK implementation

**Files:**
- Create: `src/agents/claude.ts`
- Create: `test/agents/claude.test.ts` (unit, hermetic, mocks the SDK)
- Create: `test/agents/claude.live.test.ts` (gated, makes a real API call)
- Read for reference: `https://code.claude.com/docs/en/agent-sdk/typescript.md`, the spec §6.

Before writing tasks, read the current SDK docs to confirm exact API names and option shapes — they may have moved since the spec grounding. If the SDK ships type definitions, use them; do not hand-roll types.

- [ ] **Step 1: Write hermetic unit test for the adapter, mocking `query()`**

The test asserts that the adapter:
1. Builds an in-process MCP server containing the supplied tools.
2. Passes `model`, `maxBudgetUsd`, `systemPrompt`, `outputFormat`, and `abortController` correctly.
3. Resolves with the parsed `structured_output` from a fake terminal `SDKResultMessage`.
4. Maps `error_max_budget_usd` → `AgentError` with `kind: "agent_budget"`.

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import { AgentError } from "../../src/agents/adapter.js";

// Hoist-friendly mock of the SDK. Adjust paths/exports to match the real SDK surface.
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const calls: any[] = [];
  return {
    __calls: calls,
    query: vi.fn((opts: any) => {
      calls.push(opts);
      const stream = opts.__nextStream as Array<{ type: string; [k: string]: unknown }>;
      return (async function* () { for (const m of stream) yield m; })();
    }),
    createSdkMcpServer: vi.fn((opts: any) => ({ __server: opts })),
    tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
      name, description, inputSchema, handler,
    })),
  };
});

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentAdapter } from "../../src/agents/claude.js";

describe("ClaudeAgentAdapter", () => {
  beforeEach(() => vi.clearAllMocks());

  const Decision = z.object({ verdict: z.string() });

  it("resolves with parsed structured_output on success", async () => {
    (sdk as any).query.mockImplementation((opts: any) => {
      const stream = [
        { type: "system" },
        { type: "result", subtype: "success", structured_output: { verdict: "ok" } },
      ];
      return (async function* () { for (const m of stream) yield m; })();
    });
    const agent = new ClaudeAgentAdapter();
    const result = await agent.runStage({
      systemPrompt: "S", userPrompt: "U", tools: [], decisionSchema: Decision, model: "claude-haiku",
    });
    expect(result).toEqual({ verdict: "ok" });
  });

  it("maps error_max_budget_usd to AgentError(agent_budget)", async () => {
    (sdk as any).query.mockImplementation(() => (async function* () {
      yield { type: "result", subtype: "error_max_budget_usd" };
    })());
    const agent = new ClaudeAgentAdapter();
    await expect(
      agent.runStage({
        systemPrompt: "S", userPrompt: "U", tools: [], decisionSchema: Decision, model: "claude-haiku", budgetUsd: 1,
      })
    ).rejects.toBeInstanceOf(AgentError);
  });

  it("translates timeoutMs into an AbortController", async () => {
    const ctrl = new AbortController();
    (sdk as any).query.mockImplementation((opts: any) => {
      // Capture the options for assertion.
      (sdk as any).__lastOpts = opts;
      return (async function* () {
        yield { type: "result", subtype: "success", structured_output: { verdict: "ok" } };
      })();
    });
    const agent = new ClaudeAgentAdapter();
    await agent.runStage({
      systemPrompt: "S", userPrompt: "U", tools: [], decisionSchema: Decision, model: "claude-haiku",
      timeoutMs: 1000, abortController: ctrl,
    });
    expect((sdk as any).__lastOpts.abortController).toBeInstanceOf(AbortController);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/agents/claude.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agents/claude.ts`**

Verify the actual SDK exports before writing this. The names below (`query`, `createSdkMcpServer`, `tool`, options shape) come from the spec's grounding report; confirm with `node -e "console.log(Object.keys(require('@anthropic-ai/claude-agent-sdk')))"` and the docs.

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  query,
  createSdkMcpServer,
  // tool,                       // not used directly here; tools are produced by tools/* factories
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, RunStageArgs } from "./adapter.js";
import { AgentError } from "./adapter.js";

const SUBTYPE_TO_KIND: Record<string, "agent_budget" | "agent_max_turns" | "agent_invalid_output" | "agent_execution"> = {
  error_max_budget_usd: "agent_budget",
  error_max_turns: "agent_max_turns",
  error_max_structured_output_retries: "agent_invalid_output",
  error_during_execution: "agent_execution",
};

export class ClaudeAgentAdapter implements AgentAdapter {
  async runStage<T>(args: RunStageArgs<T>): Promise<T> {
    const controller = args.abortController ?? new AbortController();
    const timer = args.timeoutMs != null
      ? setTimeout(() => controller.abort(), args.timeoutMs)
      : null;

    try {
      const mcpServer = createSdkMcpServer({
        name: "shopfloor",
        version: "2.0.0",
        tools: args.tools as any, // tools come pre-built by stage factories
      });

      const stream = query({
        prompt: args.userPrompt,
        options: {
          model: args.model,
          systemPrompt: args.systemPrompt,
          mcpServers: { shopfloor: mcpServer },
          allowedTools: args.tools.map(t => `mcp__shopfloor__${t.name}`),
          outputFormat: { type: "json_schema", schema: zodToJsonSchema(args.decisionSchema as z.ZodTypeAny) },
          maxBudgetUsd: args.budgetUsd,
          abortController: controller,
        },
      });

      for await (const msg of stream as AsyncIterable<any>) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success") {
          return args.decisionSchema.parse(msg.structured_output);
        }
        const kind = SUBTYPE_TO_KIND[msg.subtype as string] ?? "agent_execution";
        throw new AgentError(kind, `claude session ended with ${msg.subtype}`, msg.subtype as string);
      }
      throw new AgentError("agent_execution", "claude session ended without a result message");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

If the SDK's actual `outputFormat` key, terminal-message shape, or option names differ from what's written above, adjust both the implementation and the unit test. The contract from the spec is non-negotiable; the SDK call shape will mirror whatever the docs say at execution time.

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test test/agents/claude.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the gated live test**

```ts
// test/agents/claude.live.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ClaudeAgentAdapter } from "../../src/agents/claude.js";

const RUN_LIVE = process.env.ANTHROPIC_API_KEY != null;

describe.skipIf(!RUN_LIVE)("ClaudeAgentAdapter (live)", () => {
  it("returns a structured decision for a trivial prompt", async () => {
    const Decision = z.object({ greeting: z.string() });
    const agent = new ClaudeAgentAdapter();
    const result = await agent.runStage({
      systemPrompt: "Return a friendly greeting in JSON.",
      userPrompt: "say hi",
      tools: [],
      decisionSchema: Decision,
      model: "claude-haiku",
      budgetUsd: 0.5,
      timeoutMs: 60_000,
    });
    expect(typeof result.greeting).toBe("string");
  }, 90_000);
});
```

- [ ] **Step 6: Verify the live test runs only when invoked explicitly**

```bash
pnpm test
# expected: hermetic tests pass; live test reported as skipped or excluded
```

If `ANTHROPIC_API_KEY` is set in your shell, run `pnpm test:live` to exercise the real SDK end-to-end. Do not commit any captured response fixtures.

- [ ] **Step 7: Commit**

```bash
git add src/agents/claude.ts test/agents/claude.test.ts test/agents/claude.live.test.ts
git commit -m "feat(agents): add Claude Agent SDK implementation"
```

---

## Task 9: Audit event emitter

**Files:**
- Create: `src/audit/events.ts`
- Create: `src/audit/step-summary.ts`
- Create: `test/audit/events.test.ts`

- [ ] **Step 1: Write `test/audit/events.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { createAuditEmitter, type AuditEvent } from "../../src/audit/events.js";

describe("AuditEmitter", () => {
  it("writes one JSONL line per event with ts and runId", () => {
    const sink: string[] = [];
    const emit = createAuditEmitter({ runId: "r1", sink: line => sink.push(line) });
    emit({ type: "stage_resolved", stage: "triage", reason: "issue.opened", issueNumber: 7 } as AuditEvent);
    expect(sink).toHaveLength(1);
    const parsed = JSON.parse(sink[0]!);
    expect(parsed).toMatchObject({ type: "stage_resolved", stage: "triage", runId: "r1", issueNumber: 7 });
    expect(typeof parsed.ts).toBe("string");
  });

  it("serializes nested decision payloads", () => {
    const sink: string[] = [];
    const emit = createAuditEmitter({ runId: "r2", sink: line => sink.push(line) });
    emit({ type: "stage_decided", stage: "triage", decision: { complexity: "large" }, tokensUsed: 100, costUsd: 0.01 } as AuditEvent);
    const parsed = JSON.parse(sink[0]!);
    expect(parsed.decision).toEqual({ complexity: "large" });
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/audit/events.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/audit/events.ts`**

```ts
import type { Stage } from "../state/labels.js";

export type AuditEvent =
  | { type: "stage_resolved"; stage: Stage | "none"; reason: string; issueNumber?: number }
  | { type: "precheck_failed"; stage: Stage; reason: string }
  | { type: "stage_started"; stage: Stage; model: string; runId: string }
  | { type: "agent_tool_call"; stage: Stage; tool: string; argsPreview: string }
  | { type: "stage_decided"; stage: Stage; decision: unknown; tokensUsed: number; costUsd: number }
  | { type: "label_applied"; issueNumber: number; add: string[]; remove: string[] }
  | { type: "pr_opened"; stage: Stage; prNumber: number }
  | { type: "review_posted"; prNumber: number; verdict: "approve" | "request_changes"; iteration: number }
  | { type: "stage_failed"; stage: Stage; error: { message: string; kind: string } }
  | { type: "budget_exceeded"; stage: Stage; spentUsd: number; capUsd: number };

export type AuditEmitter = (event: AuditEvent) => void;

export interface CreateAuditEmitterArgs {
  runId: string;
  sink?: (line: string) => void;
}

export function createAuditEmitter(args: CreateAuditEmitterArgs): AuditEmitter {
  const sink = args.sink ?? ((line) => process.stdout.write(line + "\n"));
  return (event) => {
    const payload = { ts: new Date().toISOString(), runId: args.runId, ...event };
    sink(JSON.stringify(payload));
  };
}
```

- [ ] **Step 4: Write `test/audit/step-summary.test.ts` and implement `src/audit/step-summary.ts`**

The step-summary writer appends a Markdown table row to `process.env.GITHUB_STEP_SUMMARY` (or a custom path) for each event of a curated subset. Implement and test together.

```ts
// test/audit/step-summary.test.ts
import { describe, expect, it } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStepSummaryMirror } from "../../src/audit/step-summary.js";

describe("step-summary mirror", () => {
  it("appends a markdown row for curated event types", () => {
    const dir = mkdtempSync(join(tmpdir(), "summary-"));
    const path = join(dir, "summary.md");
    writeFileSync(path, "");
    const mirror = createStepSummaryMirror({ path });
    mirror({ type: "stage_started", stage: "triage", model: "claude-haiku", runId: "r1" } as any);
    mirror({ type: "label_applied", issueNumber: 42, add: ["shopfloor:triaging"], remove: [] } as any);
    mirror({ type: "agent_tool_call", stage: "triage", tool: "update_progress", argsPreview: "..." } as any);

    const out = readFileSync(path, "utf8");
    expect(out).toContain("triage");
    expect(out).toContain("shopfloor:triaging");
    expect(out).not.toContain("agent_tool_call"); // tool calls are not mirrored
  });
});
```

```ts
// src/audit/step-summary.ts
import { appendFileSync } from "node:fs";
import type { AuditEvent, AuditEmitter } from "./events.js";

const MIRRORED = new Set<AuditEvent["type"]>([
  "stage_started",
  "stage_decided",
  "stage_failed",
  "label_applied",
  "pr_opened",
  "review_posted",
  "budget_exceeded",
]);

export interface CreateMirrorArgs {
  path?: string; // defaults to process.env.GITHUB_STEP_SUMMARY
}

export function createStepSummaryMirror(args: CreateMirrorArgs = {}): AuditEmitter {
  const path = args.path ?? process.env.GITHUB_STEP_SUMMARY;
  return (event) => {
    if (!path) return;
    if (!MIRRORED.has(event.type)) return;
    appendFileSync(path, renderRow(event) + "\n");
  };
}

function renderRow(e: AuditEvent): string {
  switch (e.type) {
    case "stage_started":   return `- **${e.stage}** started with model \`${e.model}\``;
    case "stage_decided":   return `- **${e.stage}** decided (tokens: ${e.tokensUsed}, cost: $${e.costUsd.toFixed(4)})`;
    case "stage_failed":    return `- **${e.stage}** failed: \`${e.error.kind}\` — ${e.error.message}`;
    case "label_applied":   return `- labels on #${e.issueNumber}: +[${e.add.join(", ")}] -[${e.remove.join(", ")}]`;
    case "pr_opened":       return `- PR opened for **${e.stage}** stage: #${e.prNumber}`;
    case "review_posted":   return `- review #${e.iteration} on PR #${e.prNumber}: **${e.verdict}**`;
    case "budget_exceeded": return `- budget exceeded in **${e.stage}**: $${e.spentUsd.toFixed(2)} / $${e.capUsd.toFixed(2)}`;
    default:                return `- ${(e as any).type}`;
  }
}
```

Wire `events.ts` and `step-summary.ts` together via a small `combineEmitters` helper so consumers can hand one emitter to the orchestrator that fans out to both. Add a quick test for the combiner.

- [ ] **Step 5: Run all audit tests, expect pass**

```bash
pnpm test test/audit/
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/audit/ test/audit/
git commit -m "feat(audit): add JSONL event emitter and step-summary mirror"
```

---

## Task 10: update_progress in-process tool

**Files:**
- Create: `src/tools/update-progress.ts`
- Create: `test/tools/update-progress.test.ts`
- Read for reference: `mcp-servers/shopfloor-mcp/index.ts:177-240`

- [ ] **Step 1: Write `test/tools/update-progress.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { updateProgressTool } from "../../src/tools/update-progress.js";

describe("updateProgressTool", () => {
  it("PATCHes the configured comment with the supplied body", async () => {
    const github = {
      updateIssueComment: vi.fn().mockResolvedValue(undefined),
    };
    const tool = updateProgressTool({ github, commentId: 12345, issueNumber: 7 });
    const result = await tool.handler({ body: "## Progress\n- [x] step one\n- [ ] step two\n" });
    expect(github.updateIssueComment).toHaveBeenCalledWith(12345, "## Progress\n- [x] step one\n- [ ] step two\n");
    expect(result.isError).not.toBe(true);
  });

  it("returns isError true when the API call fails", async () => {
    const github = {
      updateIssueComment: vi.fn().mockRejectedValue(new Error("403")),
    };
    const tool = updateProgressTool({ github, commentId: 1, issueNumber: 2 });
    const result = await tool.handler({ body: "x" });
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/tools/update-progress.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/tools/update-progress.ts`**

The SDK's `tool(name, description, zodShape, handler)` helper is the natural target. Check the SDK exports at execution time and adapt.

```ts
import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkTool } from "./types.js";

export interface UpdateProgressArgs {
  github: { updateIssueComment(id: number, body: string): Promise<void> };
  commentId: number;
  issueNumber: number;
}

const inputShape = { body: z.string().min(1).max(60_000) };

export function updateProgressTool(args: UpdateProgressArgs): SdkTool {
  return tool(
    "update_progress",
    "Replace the body of the pinned progress comment on the issue with the supplied markdown.",
    inputShape,
    async (input: { body: string }) => {
      try {
        await args.github.updateIssueComment(args.commentId, input.body);
        return { content: [{ type: "text", text: "ok" }] };
      } catch (err) {
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    },
  ) as unknown as SdkTool;
}
```

If `tool()` is not an exported helper in the installed SDK version, construct the same shape inline matching the documented schema.

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test test/tools/update-progress.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/update-progress.ts test/tools/update-progress.test.ts
git commit -m "feat(tools): port update_progress as in-process SDK tool"
```

---

## Task 11: Action input validation

**Files:**
- Create: `src/config/inputs.ts`
- Create: `test/config/inputs.test.ts`
- Read for reference: `.github/workflows/shopfloor.yml` (the `on.workflow_call.inputs` block in v1)

- [ ] **Step 1: Write `test/config/inputs.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/inputs.js";

const baseInputs: Record<string, string> = {
  anthropic_api_key: "sk-test",
  shopfloor_github_app_client_id: "Iv23test",
  shopfloor_github_app_private_key: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n",
  trigger_label: "shopfloor",
  max_review_iterations: "3",
  triage_model: "claude-haiku",
  spec_model: "claude-opus",
  plan_model: "claude-opus",
  impl_model: "claude-opus",
  review_compliance_model: "claude-opus",
  review_bugs_model: "claude-opus",
  review_security_model: "claude-opus",
  review_smells_model: "claude-opus",
  triage_max_budget_usd: "0.25",
  impl_max_budget_usd: "2.50",
  triage_timeout_ms: "120000",
};

describe("parseConfig", () => {
  it("parses valid inputs", () => {
    const cfg = parseConfig(baseInputs);
    expect(cfg.triageModel).toBe("claude-haiku");
    expect(cfg.maxReviewIterations).toBe(3);
    expect(cfg.implMaxBudgetUsd).toBe(2.5);
  });

  it("rejects missing required inputs", () => {
    const { anthropic_api_key, ...rest } = baseInputs;
    expect(() => parseConfig({ ...rest, claude_code_oauth_token: "" })).toThrow();
  });

  it("accepts claude_code_oauth_token as an alternative to anthropic_api_key", () => {
    const { anthropic_api_key, ...rest } = baseInputs;
    expect(() => parseConfig({ ...rest, claude_code_oauth_token: "oauth-tok" })).not.toThrow();
  });

  it("rejects non-numeric budget values", () => {
    expect(() => parseConfig({ ...baseInputs, impl_max_budget_usd: "lots" })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
pnpm test test/config/inputs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/config/inputs.ts`**

```ts
import { z } from "zod";

const num = (min = 0) =>
  z.string().transform((s, ctx) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < min) {
      ctx.addIssue({ code: "custom", message: `expected number ≥ ${min}, got ${s}` });
      return z.NEVER;
    }
    return n;
  });

const RawInputs = z
  .object({
    anthropic_api_key: z.string().optional().default(""),
    claude_code_oauth_token: z.string().optional().default(""),
    shopfloor_github_app_client_id: z.string().min(1),
    shopfloor_github_app_private_key: z.string().min(1),
    shopfloor_github_app_review_client_id: z.string().optional().default(""),
    shopfloor_github_app_review_private_key: z.string().optional().default(""),
    ssh_signing_key: z.string().optional().default(""),
    trigger_label: z.string().default(""),
    max_review_iterations: num(1).default("3" as unknown as number),
    triage_model: z.string().default("claude-haiku"),
    spec_model: z.string().default("claude-opus"),
    plan_model: z.string().default("claude-opus"),
    impl_model: z.string().default("claude-opus"),
    review_compliance_model: z.string().default("claude-opus"),
    review_bugs_model: z.string().default("claude-opus"),
    review_security_model: z.string().default("claude-opus"),
    review_smells_model: z.string().default("claude-opus"),
    triage_max_budget_usd: num(0).default("0.25" as unknown as number),
    spec_max_budget_usd: num(0).default("1.50" as unknown as number),
    plan_max_budget_usd: num(0).default("1.50" as unknown as number),
    impl_max_budget_usd: num(0).default("2.50" as unknown as number),
    review_max_budget_usd_per_lens: num(0).default("0.75" as unknown as number),
    triage_timeout_ms: num(1000).default("300000" as unknown as number),
    spec_timeout_ms: num(1000).default("1200000" as unknown as number),
    plan_timeout_ms: num(1000).default("1200000" as unknown as number),
    impl_timeout_ms: num(1000).default("3600000" as unknown as number),
    review_timeout_ms_per_lens: num(1000).default("900000" as unknown as number),
  })
  .refine((v) => v.anthropic_api_key || v.claude_code_oauth_token, {
    message: "one of anthropic_api_key or claude_code_oauth_token is required",
  });

export type RawInputs = z.input<typeof RawInputs>;
export type Config = ReturnType<typeof parseConfig>;

export function parseConfig(raw: Record<string, string | undefined>) {
  const cleaned = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v ?? ""]));
  const parsed = RawInputs.parse(cleaned);
  return {
    anthropicApiKey: parsed.anthropic_api_key,
    claudeCodeOAuthToken: parsed.claude_code_oauth_token,
    githubApp: {
      clientId: parsed.shopfloor_github_app_client_id,
      privateKey: parsed.shopfloor_github_app_private_key,
    },
    reviewGithubApp: parsed.shopfloor_github_app_review_client_id
      ? { clientId: parsed.shopfloor_github_app_review_client_id, privateKey: parsed.shopfloor_github_app_review_private_key }
      : null,
    sshSigningKey: parsed.ssh_signing_key || null,
    triggerLabel: parsed.trigger_label || null,
    maxReviewIterations: parsed.max_review_iterations,
    triageModel: parsed.triage_model,
    specModel: parsed.spec_model,
    planModel: parsed.plan_model,
    implModel: parsed.impl_model,
    reviewModels: {
      compliance: parsed.review_compliance_model,
      bugs: parsed.review_bugs_model,
      security: parsed.review_security_model,
      smells: parsed.review_smells_model,
    },
    budgets: {
      triageUsd: parsed.triage_max_budget_usd,
      specUsd: parsed.spec_max_budget_usd,
      planUsd: parsed.plan_max_budget_usd,
      implUsd: parsed.impl_max_budget_usd,
      reviewPerLensUsd: parsed.review_max_budget_usd_per_lens,
    },
    timeouts: {
      triageMs: parsed.triage_timeout_ms,
      specMs: parsed.spec_timeout_ms,
      planMs: parsed.plan_timeout_ms,
      implMs: parsed.impl_timeout_ms,
      reviewPerLensMs: parsed.review_timeout_ms_per_lens,
    },
  } as const;
}
```

Cross-reference the input names against v1's `.github/workflows/shopfloor.yml` `on.workflow_call.inputs` block and the spec §11. Add any v1 inputs missing above with sensible defaults; remove ones the spec explicitly drops (`helper`, `claude_args`).

- [ ] **Step 4: Run tests, expect pass**

```bash
pnpm test test/config/inputs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/inputs.ts test/config/inputs.test.ts
git commit -m "feat(config): add action input validation with Zod"
```

---

## Task 12: Final foundation check

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: ALL hermetic tests PASS. Live test skipped.

- [ ] **Step 2: Run typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Run prettier**

```bash
pnpm format:check
```

If anything is malformed:

```bash
pnpm format
git add -A
git commit -m "chore(v2): apply prettier"
```

- [ ] **Step 4: Verify branch state**

```bash
git log --oneline main..HEAD
```

Expected: roughly 11 commits matching Tasks 1–11.

- [ ] **Step 5: Push the v2 branch**

```bash
git push origin v2
```

This is a development branch; pushing is safe and is not a release.

---

## Self-review checklist (for the agent executing this plan)

Before declaring Plan 1 complete:

- [ ] Every test referenced in this plan is green when run with `pnpm test`.
- [ ] `pnpm exec tsc --noEmit` is clean.
- [ ] No `console.log` lingering outside the audit emitter.
- [ ] No imports from `router/`, `mcp-servers/`, or `prompts/` inside `src/`.
- [ ] No imports of `@anthropic-ai/claude-agent-sdk` outside `src/agents/claude.ts` and `src/tools/update-progress.ts`.
- [ ] State-machine snapshots match v1 exactly. If any drifted, the port introduced a regression — fix the port, not the snapshot.
- [ ] `src/agents/claude.ts` compiles against the installed SDK version. If the SDK's API differs from this plan's assumptions, update both `claude.ts` and `claude.test.ts` to match the SDK, not vice versa. Do not invent SDK symbols.

Plan 2 (Stages) and Plan 3 (Orchestrator + action + cutover) depend on this foundation being green.
