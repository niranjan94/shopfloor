# Shopfloor Smoke Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a developer-invoked TypeScript runner at `scripts/smoke/` (run via `pnpm smoke`) that drives `niranjan94/shopfloor-smoke` through seven scenarios against the real `niranjan94/shopfloor@v2` action and reports pass / fail / timeout per scenario.

**Architecture:** Standalone TS executed via `tsx`; talks to GitHub through `@octokit/rest` (REST) plus raw GraphQL for issue deletion. Scenarios are imperative async functions over a shared `ctx` object that exposes mutations (create issue, comment, merge PR) and polling assertions (expectLabel, expectPrOpenedFor, etc.). Unit tests cover the deterministic units (`tag`, `expect` polling logic, `cleanup` query building, footer parsing); the scenarios themselves are not unit-tested — they are the tests.

**Tech Stack:** TypeScript, Node 24+, `tsx`, `@octokit/rest`, `dotenv`, `chalk`, `vitest` (for unit tests on the helpers only), Node built-in `parseArgs`.

**Spec:** `docs/superpowers/specs/2026-05-19-shopfloor-smoke-runner-design.md`

---

## File Map

```
scripts/smoke/
  index.ts                 # CLI entry. parseArgs + dispatch.
  README.md                # Operator-facing setup, env, scenarios overview, known flakiness.
  lib/
    env.ts                 # Load .env, validate required vars.
    github.ts              # Octokit factory + thin REST helpers + GraphQL deleteIssue.
    expect.ts              # Polling assertions. ExpectTimeout class. Footer regex.
    scenario.ts            # runScenario wrapper (timeout, log, outcome translation).
    run.ts                 # Orchestrator: pre-flight, parallel/sequential, summary report.
    tag.ts                 # Generate per-run tag and per-scenario tag.
    cleanup.ts             # cleanupByTitlePrefix.
    types.ts               # Shared types: Scenario, ScenarioOutcome, SmokeCtx, etc.
  scenarios/
    quick.ts
    medium.ts
    large.ts
    awaiting-info.ts
    review-only.ts
    revision-loop.ts
    skip-review-and-revise.ts
test/smoke/
  tag.test.ts              # tag generation determinism + format.
  expect.test.ts           # Polling, backoff, timeout, regex matching (mock Octokit).
  cleanup.test.ts          # Query construction + branch deletion ordering (mock Octokit).
  footer.test.ts           # PR-footer regex matches the canonical metadata format.
.env.example               # Documents all env vars + scopes.
.gitignore                 # Add .env.
package.json               # Add "smoke" script + tsx/dotenv/chalk devDeps.
tsconfig.json              # Add "scripts/**/*" and "test/smoke/**/*" to include.
README.md                  # Add short pointer to scripts/smoke/README.md.
```

The runner is its own subtree: it never imports from `src/`. Where it needs Shopfloor formats (e.g. the PR footer or the review marker), it re-encodes them in its own files. The plan calls out the duplication explicitly so an engineer maintaining it later does not silently break the runner by changing only `src/`.

---

## Task 1: Bootstrap dependencies and config

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Add devDependencies**

Run from repo root:

```bash
pnpm add -D tsx dotenv chalk
```

Expected: three new entries appear in `package.json` `devDependencies`. `chalk@^5` (ESM-only — fine, the repo is `"type": "module"`), `tsx@^4`, `dotenv@^16`.

- [ ] **Step 2: Add the `smoke` script entry**

Edit `package.json` and insert under `"scripts"`:

```json
"smoke": "tsx scripts/smoke/index.ts",
```

Place it after `"test:live"` and before `"typecheck"`.

- [ ] **Step 3: Extend `tsconfig.json` include**

Edit `tsconfig.json`. Change the `"include"` line from:

```json
"include": ["src/**/*", "test/**/*", "esbuild.config.mjs"]
```

to:

```json
"include": ["src/**/*", "test/**/*", "scripts/**/*", "esbuild.config.mjs"]
```

(The `test/smoke/` subtree is already covered by `test/**/*`.)

- [ ] **Step 4: Gitignore `.env`**

Edit `.gitignore`. Append a blank line, then:

```
.env
```

- [ ] **Step 5: Write `.env.example`**

Create `.env.example` at the repo root with:

```dotenv
# Fine-grained PAT scoped to niranjan94/shopfloor-smoke only.
# Required scopes:
#   Issues:        read / write
#   Pull requests: read / write
#   Contents:      read / write   (to merge PRs)
#   Administration: read / write  (required for GraphQL deleteIssue)
SHOPFLOOR_SMOKE_GH_TOKEN=

# Bot login of the primary Shopfloor App installed on shopfloor-smoke.
# Typically ends in "[bot]". Used to match triage / spec / plan / impl comments.
SHOPFLOOR_PRIMARY_APP_LOGIN=shopfloor[bot]

# Bot login of the optional review App installed on shopfloor-smoke.
# Used to match review verdicts and review-only output.
SHOPFLOOR_REVIEW_APP_LOGIN=shopfloor-reviewer[bot]
```

- [ ] **Step 6: Verify typecheck still passes**

Run:

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0 with no output. (No source files added yet, so this is just confirming the tsconfig change is well-formed.)

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json .gitignore .env.example
git commit -m "chore(smoke): bootstrap tsx + dotenv + chalk and wire pnpm smoke script"
```

---

## Task 2: Shared types module

**Files:**
- Create: `scripts/smoke/lib/types.ts`

- [ ] **Step 1: Write the types file**

Create `scripts/smoke/lib/types.ts`:

```ts
import type { Octokit } from "@octokit/rest";

export type StageName = "spec" | "plan" | "implement" | "review";

export interface AppLogins {
  primary: string;
  review: string;
}

export interface ExpectOpts {
  timeoutMs?: number;
  pollMs?: number;
}

export interface PrRef {
  number: number;
  headRef: string;
  headSha: string;
}

export interface SmokeCtx {
  tag: string;
  log: (msg: string) => void;
  gh: Octokit;
  appLogins: AppLogins;
  owner: string;
  repo: string;

  // Mutations
  createIssue(opts: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ number: number }>;
  addLabel(issue: number, label: string): Promise<void>;
  removeLabel(issue: number, label: string): Promise<void>;
  commentOnIssue(issue: number, body: string): Promise<void>;
  commentOnPr(pr: number, body: string): Promise<void>;
  mergePr(pr: number, method?: "squash" | "merge"): Promise<void>;
  closePr(pr: number): Promise<void>;
  deleteBranch(ref: string): Promise<void>;

  // Polling assertions (each throws ExpectTimeout on miss)
  expectLabel(
    issue: number,
    label: string | RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
  expectLabelMissing(
    issue: number,
    label: string,
    opts?: ExpectOpts,
  ): Promise<void>;
  expectPrOpenedFor(
    issue: number,
    stage: StageName,
    opts?: ExpectOpts,
  ): Promise<PrRef>;
  expectCommentByApp(
    issue: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
  expectIssueClosed(issue: number, opts?: ExpectOpts): Promise<void>;
  expectNewCommitOn(
    pr: number,
    sinceSha: string,
    opts?: ExpectOpts,
  ): Promise<{ headSha: string }>;
  expectReviewByApp(
    pr: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
}

export type ScenarioOutcome =
  | { kind: "pass" }
  | { kind: "soft-pass"; reason: string }
  | { kind: "fail"; reason: string };

export interface Scenario {
  id: string;
  name: string;
  flaky: boolean;
  timeoutMs: number;
  run: (ctx: SmokeCtx) => Promise<ScenarioOutcome>;
}

export interface ScenarioResult {
  scenario: Scenario;
  outcome: ScenarioOutcome | { kind: "timeout"; reason: string };
  startedAt: number;
  endedAt: number;
  createdIssues: number[];
  createdPrs: number[];
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/lib/types.ts
git commit -m "feat(smoke): add shared types for scenario runner"
```

---

## Task 3: Tag generator (TDD)

**Files:**
- Create: `scripts/smoke/lib/tag.ts`
- Create: `test/smoke/tag.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/smoke/tag.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { newRunTag, scenarioTag } from "../../scripts/smoke/lib/tag.js";

describe("tag.ts", () => {
  it("newRunTag returns the canonical shape smoke-YYYYMMDD-xxxx", () => {
    vi.setSystemTime(new Date("2026-05-19T10:00:00Z"));
    const tag = newRunTag();
    expect(tag).toMatch(/^smoke-20260519-[a-z0-9]{4}$/);
    vi.useRealTimers();
  });

  it("newRunTag is unique across rapid invocations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(newRunTag());
    expect(seen.size).toBeGreaterThan(180);
  });

  it("scenarioTag composes run tag and scenario id with a slash", () => {
    expect(scenarioTag("smoke-20260519-abc1", "quick")).toBe(
      "smoke-20260519-abc1/quick",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test test/smoke/tag.test.ts
```

Expected: FAIL — module `scripts/smoke/lib/tag.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `scripts/smoke/lib/tag.ts`:

```ts
import { randomBytes } from "node:crypto";

export function newRunTag(now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  const suffix = randomBytes(2).toString("hex"); // 4 hex chars
  return `smoke-${y}${m}${d}-${suffix}`;
}

export function scenarioTag(runTag: string, scenarioId: string): string {
  return `${runTag}/${scenarioId}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test test/smoke/tag.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/lib/tag.ts test/smoke/tag.test.ts
git commit -m "feat(smoke): add per-run and per-scenario tag generators"
```

---

## Task 4: Env loader (TDD)

**Files:**
- Create: `scripts/smoke/lib/env.ts`
- Create: `test/smoke/env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/smoke/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveEnv } from "../../scripts/smoke/lib/env.js";

describe("env.ts", () => {
  it("returns all three values when all are set", () => {
    const env = resolveEnv({
      SHOPFLOOR_SMOKE_GH_TOKEN: "ghp_xxx",
      SHOPFLOOR_PRIMARY_APP_LOGIN: "shopfloor[bot]",
      SHOPFLOOR_REVIEW_APP_LOGIN: "shopfloor-reviewer[bot]",
    });
    expect(env).toEqual({
      token: "ghp_xxx",
      appLogins: {
        primary: "shopfloor[bot]",
        review: "shopfloor-reviewer[bot]",
      },
    });
  });

  it("throws when SHOPFLOOR_SMOKE_GH_TOKEN is missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_PRIMARY_APP_LOGIN: "a",
        SHOPFLOOR_REVIEW_APP_LOGIN: "b",
      }),
    ).toThrow(/SHOPFLOOR_SMOKE_GH_TOKEN/);
  });

  it("throws when SHOPFLOOR_PRIMARY_APP_LOGIN is missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_SMOKE_GH_TOKEN: "ghp",
        SHOPFLOOR_REVIEW_APP_LOGIN: "b",
      }),
    ).toThrow(/SHOPFLOOR_PRIMARY_APP_LOGIN/);
  });

  it("throws when SHOPFLOOR_REVIEW_APP_LOGIN is missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_SMOKE_GH_TOKEN: "ghp",
        SHOPFLOOR_PRIMARY_APP_LOGIN: "a",
      }),
    ).toThrow(/SHOPFLOOR_REVIEW_APP_LOGIN/);
  });

  it("treats empty strings as missing", () => {
    expect(() =>
      resolveEnv({
        SHOPFLOOR_SMOKE_GH_TOKEN: "",
        SHOPFLOOR_PRIMARY_APP_LOGIN: "a",
        SHOPFLOOR_REVIEW_APP_LOGIN: "b",
      }),
    ).toThrow(/SHOPFLOOR_SMOKE_GH_TOKEN/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test test/smoke/env.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `scripts/smoke/lib/env.ts`:

```ts
import { config as loadDotenv } from "dotenv";
import type { AppLogins } from "./types.js";

export interface ResolvedEnv {
  token: string;
  appLogins: AppLogins;
}

interface RawEnv {
  SHOPFLOOR_SMOKE_GH_TOKEN?: string | undefined;
  SHOPFLOOR_PRIMARY_APP_LOGIN?: string | undefined;
  SHOPFLOOR_REVIEW_APP_LOGIN?: string | undefined;
}

export function resolveEnv(env: RawEnv): ResolvedEnv {
  const token = env.SHOPFLOOR_SMOKE_GH_TOKEN;
  const primary = env.SHOPFLOOR_PRIMARY_APP_LOGIN;
  const review = env.SHOPFLOOR_REVIEW_APP_LOGIN;

  if (!token) {
    throw new Error(
      "SHOPFLOOR_SMOKE_GH_TOKEN is required. See .env.example for the required scopes.",
    );
  }
  if (!primary) {
    throw new Error(
      "SHOPFLOOR_PRIMARY_APP_LOGIN is required (e.g. 'shopfloor[bot]').",
    );
  }
  if (!review) {
    throw new Error(
      "SHOPFLOOR_REVIEW_APP_LOGIN is required (e.g. 'shopfloor-reviewer[bot]').",
    );
  }
  return { token, appLogins: { primary, review } };
}

// Top-level helper used by index.ts: loads .env if present, then resolves.
export function loadAndResolveEnv(): ResolvedEnv {
  loadDotenv(); // No-op if .env is absent.
  return resolveEnv(process.env);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test test/smoke/env.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/lib/env.ts test/smoke/env.test.ts
git commit -m "feat(smoke): add env loader with required-var validation"
```

---

## Task 5: PR footer parser (TDD)

**Files:**
- Create: `scripts/smoke/lib/footer.ts`
- Create: `test/smoke/footer.test.ts`

The runner does not import `parsePrMetadata` from `src/state/metadata.ts` (it is a standalone script). We re-encode the canonical regex and add a unit test that documents the format.

- [ ] **Step 1: Write the failing test**

Create `test/smoke/footer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePrFooter } from "../../scripts/smoke/lib/footer.js";

describe("parsePrFooter", () => {
  it("parses a fully-populated footer", () => {
    const body = [
      "## Plan",
      "Some plan content here.",
      "",
      "---",
      "Shopfloor-Issue: #142",
      "Shopfloor-Stage: plan",
      "Shopfloor-Review-Iteration: 0",
    ].join("\n");
    expect(parsePrFooter(body)).toEqual({
      issueNumber: 142,
      stage: "plan",
      reviewIteration: 0,
    });
  });

  it("defaults reviewIteration to 0 when missing", () => {
    const body = "Shopfloor-Issue: #7\nShopfloor-Stage: implement";
    expect(parsePrFooter(body)).toEqual({
      issueNumber: 7,
      stage: "implement",
      reviewIteration: 0,
    });
  });

  it("returns null when issue marker is missing", () => {
    expect(parsePrFooter("Shopfloor-Stage: plan")).toBeNull();
  });

  it("returns null when stage marker is missing", () => {
    expect(parsePrFooter("Shopfloor-Issue: #1")).toBeNull();
  });

  it("returns null on null/undefined/empty input", () => {
    expect(parsePrFooter(null)).toBeNull();
    expect(parsePrFooter(undefined)).toBeNull();
    expect(parsePrFooter("")).toBeNull();
  });

  it("accepts all four stage values", () => {
    for (const stage of ["spec", "plan", "implement", "review"] as const) {
      const body = `Shopfloor-Issue: #9\nShopfloor-Stage: ${stage}`;
      expect(parsePrFooter(body)?.stage).toBe(stage);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test test/smoke/footer.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `scripts/smoke/lib/footer.ts`:

```ts
import type { StageName } from "./types.js";

export interface PrFooter {
  issueNumber: number;
  stage: StageName;
  reviewIteration: number;
}

// Mirrors src/state/metadata.ts:parsePrMetadata. If the format changes in
// src/, update this file in lockstep. The runner intentionally does not
// import the production parser to keep scripts/smoke standalone.
export function parsePrFooter(
  body: string | null | undefined,
): PrFooter | null {
  if (!body) return null;
  const issueMatch = body.match(/Shopfloor-Issue:\s*#(\d+)/);
  const stageMatch = body.match(
    /Shopfloor-Stage:\s*(spec|plan|implement|review)/,
  );
  const iterMatch = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  if (!issueMatch || !stageMatch) return null;
  return {
    issueNumber: Number(issueMatch[1]),
    stage: stageMatch[1] as StageName,
    reviewIteration: iterMatch ? Number(iterMatch[1]) : 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test test/smoke/footer.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/lib/footer.ts test/smoke/footer.test.ts
git commit -m "feat(smoke): add standalone PR footer parser mirroring src/state/metadata"
```

---

## Task 6: GitHub client wrappers (no tests — thin shim)

**Files:**
- Create: `scripts/smoke/lib/github.ts`

These are thin wrappers around Octokit calls with a small retry policy. Unit-testing them adds little — the value is in the retry behaviour, and the retry policy is short enough to read directly. The scenarios themselves exercise these paths.

- [ ] **Step 1: Write the implementation**

Create `scripts/smoke/lib/github.ts`:

```ts
import { Octokit } from "@octokit/rest";

const RETRY_BASE_MS = 1000;
const RETRY_MAX = 3;

export function makeGh(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "shopfloor-smoke-runner" });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;
      const status = (err as { status?: number }).status;
      const code = (err as { code?: string }).code;
      const retriable =
        (status !== undefined && status >= 500) ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT";
      if (!retriable || attempt >= RETRY_MAX) throw err;
      const delay = RETRY_BASE_MS * attempt * attempt;
      // Plain console.warn — no chalk dependency in this layer.
      console.warn(
        `[smoke/github] retrying ${label} after ${delay}ms (attempt ${attempt + 1}/${RETRY_MAX})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function deleteIssueGraphQL(
  gh: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const node = await gh.graphql<{ repository: { issue: { id: string } } }>(
    `query($owner:String!,$repo:String!,$num:Int!){
       repository(owner:$owner,name:$repo){ issue(number:$num){ id } }
     }`,
    { owner, repo, num: issueNumber },
  );
  const id = node.repository?.issue?.id;
  if (!id) {
    throw new Error(
      `deleteIssueGraphQL: cannot resolve node id for ${owner}/${repo}#${issueNumber}`,
    );
  }
  await gh.graphql(
    `mutation($id:ID!){ deleteIssue(input:{ issueId:$id }){ __typename } }`,
    { id },
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/lib/github.ts
git commit -m "feat(smoke): add Octokit factory, retry wrapper, and GraphQL deleteIssue"
```

---

## Task 7: Polling assertions (TDD with mock Octokit)

**Files:**
- Create: `scripts/smoke/lib/expect.ts`
- Create: `test/smoke/expect.test.ts`

The polling library is the load-bearing piece — its correctness determines whether scenarios succeed or hang. Unit tests cover label matching (string + regex), label-missing semantics, PR-footer matching, timeout behaviour, and back-off interval.

- [ ] **Step 1: Write the failing test**

Create `test/smoke/expect.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  ExpectTimeout,
  makeExpectClient,
} from "../../scripts/smoke/lib/expect.js";

function fakeGhWithLabels(seq: string[][]) {
  let i = 0;
  return {
    issues: {
      listLabelsOnIssue: vi.fn(async () => {
        const labels = seq[Math.min(i++, seq.length - 1)] ?? [];
        return { data: labels.map((name) => ({ name })) };
      }),
    },
  };
}

describe("expect.ts", () => {
  it("expectLabel resolves when label appears on first poll", async () => {
    const gh = fakeGhWithLabels([["shopfloor:triaging"], ["shopfloor:quick"]]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectLabel(42, "shopfloor:quick");
    expect(gh.issues.listLabelsOnIssue).toHaveBeenCalled();
  });

  it("expectLabel matches a regex label", async () => {
    const gh = fakeGhWithLabels([["shopfloor:medium"]]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectLabel(42, /shopfloor:(quick|medium)/);
  });

  it("expectLabel throws ExpectTimeout when label never appears", async () => {
    const gh = fakeGhWithLabels([["other"]]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 25,
    });
    await expect(c.expectLabel(42, "shopfloor:done")).rejects.toBeInstanceOf(
      ExpectTimeout,
    );
  });

  it("expectLabelMissing resolves when label disappears", async () => {
    const gh = fakeGhWithLabels([["x"], []]);
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectLabelMissing(42, "x");
  });

  it("expectPrOpenedFor matches PR with correct footer", async () => {
    const gh = {
      pulls: {
        list: vi.fn(async () => ({
          data: [
            {
              number: 7,
              head: { ref: "shopfloor/plan/42-x", sha: "abc" },
              body: "Shopfloor-Issue: #42\nShopfloor-Stage: plan",
            },
          ],
        })),
      },
    };
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    const pr = await c.expectPrOpenedFor(42, "plan");
    expect(pr).toEqual({ number: 7, headRef: "shopfloor/plan/42-x", headSha: "abc" });
  });

  it("expectPrOpenedFor ignores PRs with wrong stage", async () => {
    const gh = {
      pulls: {
        list: vi.fn(async () => ({
          data: [
            {
              number: 7,
              head: { ref: "x", sha: "a" },
              body: "Shopfloor-Issue: #42\nShopfloor-Stage: spec",
            },
          ],
        })),
      },
    };
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 25,
    });
    await expect(c.expectPrOpenedFor(42, "plan")).rejects.toBeInstanceOf(
      ExpectTimeout,
    );
  });

  it("expectReviewByApp matches a review by app login + marker", async () => {
    const gh = {
      pulls: {
        listReviews: vi.fn(async () => ({
          data: [
            {
              user: { login: "shopfloor-reviewer[bot]" },
              body: "<!-- shopfloor-review -->\n**Shopfloor agent review: clean**...",
            },
          ],
        })),
      },
    };
    const c = makeExpectClient(gh as never, "owner", "repo", {
      pollMs: 1,
      defaultTimeoutMs: 5_000,
    });
    await c.expectReviewByApp(
      11,
      "shopfloor-reviewer[bot]",
      /<!-- shopfloor-review -->/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test test/smoke/expect.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `scripts/smoke/lib/expect.ts`:

```ts
import type { Octokit } from "@octokit/rest";
import { parsePrFooter } from "./footer.js";
import type { ExpectOpts, PrRef, StageName } from "./types.js";

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 8 * 60_000;
const BACKOFF_AFTER_MS = 60_000;
const BACKOFF_POLL_MS = 30_000;

export class ExpectTimeout extends Error {
  constructor(
    public readonly what: string,
    public readonly lastObserved: string,
  ) {
    super(`timed out waiting for ${what}. Last observed: ${lastObserved}`);
    this.name = "ExpectTimeout";
  }
}

interface ExpectClientOpts {
  pollMs?: number;
  defaultTimeoutMs?: number;
}

export interface ExpectClient {
  expectLabel(issue: number, label: string | RegExp, opts?: ExpectOpts): Promise<void>;
  expectLabelMissing(issue: number, label: string, opts?: ExpectOpts): Promise<void>;
  expectPrOpenedFor(issue: number, stage: StageName, opts?: ExpectOpts): Promise<PrRef>;
  expectCommentByApp(
    issue: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
  expectIssueClosed(issue: number, opts?: ExpectOpts): Promise<void>;
  expectNewCommitOn(
    pr: number,
    sinceSha: string,
    opts?: ExpectOpts,
  ): Promise<{ headSha: string }>;
  expectReviewByApp(
    pr: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void>;
}

export function makeExpectClient(
  gh: Octokit,
  owner: string,
  repo: string,
  baseOpts: ExpectClientOpts = {},
): ExpectClient {
  const basePoll = baseOpts.pollMs ?? DEFAULT_POLL_MS;
  const baseTimeout = baseOpts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function poll<T>(
    what: string,
    opts: ExpectOpts | undefined,
    probe: () => Promise<{ done: boolean; value?: T; observed: string }>,
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? baseTimeout;
    const start = Date.now();
    let lastObserved = "(none)";
    let pollMs = opts?.pollMs ?? basePoll;
    while (Date.now() - start < timeoutMs) {
      const probed = await probe();
      lastObserved = probed.observed;
      if (probed.done) return probed.value as T;
      if (Date.now() - start > BACKOFF_AFTER_MS) {
        pollMs = Math.max(pollMs, BACKOFF_POLL_MS);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new ExpectTimeout(what, lastObserved);
  }

  function labelMatches(name: string, want: string | RegExp): boolean {
    return typeof want === "string" ? name === want : want.test(name);
  }

  async function expectLabel(
    issue: number,
    label: string | RegExp,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(
      `label ${label.toString()} on #${issue}`,
      opts,
      async () => {
        const res = await gh.issues.listLabelsOnIssue({
          owner,
          repo,
          issue_number: issue,
        });
        const names = res.data.map((l) => l.name);
        const hit = names.some((n) => labelMatches(n, label));
        return { done: hit, observed: names.join(",") || "(no labels)" };
      },
    );
  }

  async function expectLabelMissing(
    issue: number,
    label: string,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(`label ${label} absent on #${issue}`, opts, async () => {
      const res = await gh.issues.listLabelsOnIssue({
        owner,
        repo,
        issue_number: issue,
      });
      const names = res.data.map((l) => l.name);
      return { done: !names.includes(label), observed: names.join(",") };
    });
  }

  async function expectPrOpenedFor(
    issue: number,
    stage: StageName,
    opts?: ExpectOpts,
  ): Promise<PrRef> {
    return poll(`PR for #${issue} stage=${stage}`, opts, async () => {
      const res = await gh.pulls.list({ owner, repo, state: "open", per_page: 50 });
      for (const pr of res.data) {
        const footer = parsePrFooter(pr.body ?? null);
        if (
          footer &&
          footer.issueNumber === issue &&
          footer.stage === stage
        ) {
          return {
            done: true,
            value: {
              number: pr.number,
              headRef: pr.head.ref,
              headSha: pr.head.sha,
            },
            observed: `#${pr.number} (footer matched)`,
          };
        }
      }
      return { done: false, observed: `${res.data.length} open PR(s), no match` };
    });
  }

  async function expectCommentByApp(
    issue: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(
      `comment by ${appLogin} on #${issue}${contains ? ` matching ${contains}` : ""}`,
      opts,
      async () => {
        const res = await gh.issues.listComments({
          owner,
          repo,
          issue_number: issue,
          per_page: 100,
        });
        const matches = res.data.filter(
          (c) =>
            c.user?.login === appLogin &&
            (!contains || (c.body && contains.test(c.body))),
        );
        return {
          done: matches.length > 0,
          observed: `${res.data.length} comment(s), ${matches.length} match`,
        };
      },
    );
  }

  async function expectIssueClosed(
    issue: number,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(`#${issue} closed`, opts, async () => {
      const res = await gh.issues.get({ owner, repo, issue_number: issue });
      return { done: res.data.state === "closed", observed: res.data.state };
    });
  }

  async function expectNewCommitOn(
    pr: number,
    sinceSha: string,
    opts?: ExpectOpts,
  ): Promise<{ headSha: string }> {
    return poll(`new commit on PR #${pr}`, opts, async () => {
      const res = await gh.pulls.get({ owner, repo, pull_number: pr });
      const sha = res.data.head.sha;
      return { done: sha !== sinceSha, value: { headSha: sha }, observed: sha };
    });
  }

  async function expectReviewByApp(
    pr: number,
    appLogin: string,
    contains?: RegExp,
    opts?: ExpectOpts,
  ): Promise<void> {
    await poll(
      `review by ${appLogin} on PR #${pr}${contains ? ` matching ${contains}` : ""}`,
      opts,
      async () => {
        const res = await gh.pulls.listReviews({
          owner,
          repo,
          pull_number: pr,
          per_page: 100,
        });
        const matches = res.data.filter(
          (r) =>
            r.user?.login === appLogin &&
            (!contains || (r.body && contains.test(r.body))),
        );
        return {
          done: matches.length > 0,
          observed: `${res.data.length} review(s), ${matches.length} match`,
        };
      },
    );
  }

  return {
    expectLabel,
    expectLabelMissing,
    expectPrOpenedFor,
    expectCommentByApp,
    expectIssueClosed,
    expectNewCommitOn,
    expectReviewByApp,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test test/smoke/expect.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/lib/expect.ts test/smoke/expect.test.ts
git commit -m "feat(smoke): add polling assertion library with timeout and back-off"
```

---

## Task 8: Cleanup module (TDD with mock Octokit)

**Files:**
- Create: `scripts/smoke/lib/cleanup.ts`
- Create: `test/smoke/cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/smoke/cleanup.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { cleanupByTitlePrefix } from "../../scripts/smoke/lib/cleanup.js";

function fakeGh(opts: {
  searchResults: Array<{
    number: number;
    pull_request?: { url: string };
    title: string;
  }>;
  prDetails?: Record<number, { head: { ref: string } }>;
}) {
  return {
    search: {
      issuesAndPullRequests: vi.fn(async () => ({
        data: { items: opts.searchResults },
      })),
    },
    pulls: {
      get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
        data: opts.prDetails?.[pull_number] ?? { head: { ref: "default-ref" } },
      })),
      update: vi.fn(async () => ({})),
    },
    git: {
      deleteRef: vi.fn(async () => ({})),
    },
    graphql: vi.fn(async (query: string) => {
      if (query.includes("repository(")) {
        return { repository: { issue: { id: "MDEx" } } };
      }
      return { deleteIssue: { __typename: "DeleteIssuePayload" } };
    }),
  };
}

describe("cleanupByTitlePrefix", () => {
  it("closes PRs, deletes branches, and deletes issues", async () => {
    const gh = fakeGh({
      searchResults: [
        { number: 7, title: "smoke-abc/quick: PR title", pull_request: { url: "..." } },
        { number: 8, title: "smoke-abc/quick: issue title" },
      ],
      prDetails: { 7: { head: { ref: "shopfloor/impl/8-x" } } },
    });
    const report = await cleanupByTitlePrefix(gh as never, "o", "r", "smoke-abc");
    expect(report.prsClosed).toBe(1);
    expect(report.branchesDeleted).toBe(1);
    expect(report.issuesDeleted).toBe(1);
    expect(gh.pulls.update).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      state: "closed",
    });
    expect(gh.git.deleteRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/shopfloor/impl/8-x",
    });
  });

  it("swallows 'Reference does not exist' on deleteRef", async () => {
    const gh = fakeGh({
      searchResults: [
        { number: 7, title: "smoke-abc/quick: PR", pull_request: { url: "..." } },
      ],
    });
    gh.git.deleteRef = vi.fn(async () => {
      const e = new Error("Reference does not exist") as Error & { status?: number };
      e.status = 422;
      throw e;
    });
    const report = await cleanupByTitlePrefix(gh as never, "o", "r", "smoke-abc");
    expect(report.errors).toEqual([]);
    expect(report.branchesDeleted).toBe(0);
  });

  it("records errors for non-422 failures without throwing", async () => {
    const gh = fakeGh({
      searchResults: [
        { number: 8, title: "smoke-abc/quick: issue" },
      ],
    });
    gh.graphql = vi.fn(async () => {
      throw new Error("permission denied");
    });
    const report = await cleanupByTitlePrefix(gh as never, "o", "r", "smoke-abc");
    expect(report.errors.length).toBe(1);
    expect(report.issuesDeleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test test/smoke/cleanup.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `scripts/smoke/lib/cleanup.ts`:

```ts
import type { Octokit } from "@octokit/rest";
import { deleteIssueGraphQL } from "./github.js";

export interface CleanupReport {
  prsClosed: number;
  branchesDeleted: number;
  issuesDeleted: number;
  errors: Array<{ context: string; message: string }>;
}

export async function cleanupByTitlePrefix(
  gh: Octokit,
  owner: string,
  repo: string,
  titlePrefix: string,
): Promise<CleanupReport> {
  const report: CleanupReport = {
    prsClosed: 0,
    branchesDeleted: 0,
    issuesDeleted: 0,
    errors: [],
  };

  // GitHub's search treats issues and PRs uniformly. Filter on
  // `is:issue` for the deletion pass and on `is:pr` for the closure
  // pass to keep the two paths separate.
  const prHits = await gh.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:pr in:title "${titlePrefix}"`,
    per_page: 100,
  });
  for (const item of prHits.data.items) {
    try {
      await gh.pulls.update({
        owner,
        repo,
        pull_number: item.number,
        state: "closed",
      });
      report.prsClosed += 1;
    } catch (err) {
      report.errors.push({
        context: `close PR #${item.number}`,
        message: (err as Error).message,
      });
      continue;
    }
    // Fetch the head ref so we can delete the branch.
    let headRef: string | undefined;
    try {
      const pr = await gh.pulls.get({ owner, repo, pull_number: item.number });
      headRef = pr.data.head.ref;
    } catch (err) {
      report.errors.push({
        context: `get PR #${item.number} head`,
        message: (err as Error).message,
      });
    }
    if (headRef) {
      try {
        await gh.git.deleteRef({
          owner,
          repo,
          ref: `heads/${headRef}`,
        });
        report.branchesDeleted += 1;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 422) continue; // Reference does not exist — swallow.
        report.errors.push({
          context: `delete branch ${headRef}`,
          message: (err as Error).message,
        });
      }
    }
  }

  const issueHits = await gh.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:issue in:title "${titlePrefix}"`,
    per_page: 100,
  });
  for (const item of issueHits.data.items) {
    try {
      await deleteIssueGraphQL(gh, owner, repo, item.number);
      report.issuesDeleted += 1;
    } catch (err) {
      report.errors.push({
        context: `delete issue #${item.number}`,
        message: (err as Error).message,
      });
    }
  }

  return report;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test test/smoke/cleanup.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke/lib/cleanup.ts test/smoke/cleanup.test.ts
git commit -m "feat(smoke): add cleanupByTitlePrefix with PR close + branch delete + issue delete"
```

---

## Task 9: Scenario wrapper

**Files:**
- Create: `scripts/smoke/lib/scenario.ts`

The wrapper sets up `ctx`, enforces the scenario-level timeout, and translates results into `ScenarioResult`. No test — it is pure plumbing that is exercised end-to-end by the scenario runs.

- [ ] **Step 1: Write the implementation**

Create `scripts/smoke/lib/scenario.ts`:

```ts
import chalk from "chalk";
import type { Octokit } from "@octokit/rest";
import { makeExpectClient } from "./expect.js";
import type {
  AppLogins,
  Scenario,
  ScenarioResult,
  SmokeCtx,
} from "./types.js";

export interface RunScenarioOpts {
  gh: Octokit;
  owner: string;
  repo: string;
  runTag: string;
  appLogins: AppLogins;
  pollMs?: number;
}

export async function runScenario(
  scenario: Scenario,
  opts: RunScenarioOpts,
): Promise<ScenarioResult> {
  const tag = `${opts.runTag}/${scenario.id}`;
  const startedAt = Date.now();
  const createdIssues: number[] = [];
  const createdPrs: number[] = [];

  const expectClient = makeExpectClient(opts.gh, opts.owner, opts.repo, {
    pollMs: opts.pollMs ?? 10_000,
  });

  const log = (msg: string) => {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const mm = Math.floor(elapsed / 60).toString().padStart(2, "0");
    const ss = (elapsed % 60).toString().padStart(2, "0");
    console.log(chalk.gray(`[${tag}] 00:${mm}:${ss}  ${msg}`));
  };

  const ctx: SmokeCtx = {
    tag,
    log,
    gh: opts.gh,
    appLogins: opts.appLogins,
    owner: opts.owner,
    repo: opts.repo,

    async createIssue({ title, body, labels }) {
      log(`> creating issue "${title}"`);
      const res = await opts.gh.issues.create({
        owner: opts.owner,
        repo: opts.repo,
        title,
        body,
        labels,
      });
      log(`+ issue #${res.data.number} created`);
      createdIssues.push(res.data.number);
      return { number: res.data.number };
    },
    async addLabel(issue, label) {
      await opts.gh.issues.addLabels({
        owner: opts.owner,
        repo: opts.repo,
        issue_number: issue,
        labels: [label],
      });
    },
    async removeLabel(issue, label) {
      try {
        await opts.gh.issues.removeLabel({
          owner: opts.owner,
          repo: opts.repo,
          issue_number: issue,
          name: label,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 404) throw err;
      }
    },
    async commentOnIssue(issue, body) {
      await opts.gh.issues.createComment({
        owner: opts.owner,
        repo: opts.repo,
        issue_number: issue,
        body,
      });
    },
    async commentOnPr(pr, body) {
      await opts.gh.issues.createComment({
        owner: opts.owner,
        repo: opts.repo,
        issue_number: pr,
        body,
      });
    },
    async mergePr(pr, method = "squash") {
      log(`> merging PR #${pr} (${method})`);
      await opts.gh.pulls.merge({
        owner: opts.owner,
        repo: opts.repo,
        pull_number: pr,
        merge_method: method,
      });
      log(`+ PR #${pr} merged`);
    },
    async closePr(pr) {
      await opts.gh.pulls.update({
        owner: opts.owner,
        repo: opts.repo,
        pull_number: pr,
        state: "closed",
      });
    },
    async deleteBranch(ref) {
      try {
        await opts.gh.git.deleteRef({
          owner: opts.owner,
          repo: opts.repo,
          ref: `heads/${ref}`,
        });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== 422) throw err;
      }
    },

    expectLabel: (...args) => {
      const desc = `label ${args[1].toString()} on #${args[0]}`;
      log(`. waiting for ${desc}`);
      return expectClient.expectLabel(...args).then(() => log(`+ ${desc}`));
    },
    expectLabelMissing: (...args) =>
      expectClient.expectLabelMissing(...args),
    expectPrOpenedFor: async (...args) => {
      const pr = await expectClient.expectPrOpenedFor(...args);
      log(`+ PR #${pr.number} opened for stage=${args[1]}`);
      createdPrs.push(pr.number);
      return pr;
    },
    expectCommentByApp: (...args) =>
      expectClient.expectCommentByApp(...args),
    expectIssueClosed: (...args) =>
      expectClient.expectIssueClosed(...args),
    expectNewCommitOn: (...args) =>
      expectClient.expectNewCommitOn(...args),
    expectReviewByApp: (...args) =>
      expectClient.expectReviewByApp(...args),
  };

  let outcome: ScenarioResult["outcome"];
  try {
    outcome = await Promise.race([
      scenario.run(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `scenario ${scenario.id} exceeded ${scenario.timeoutMs}ms`,
              ),
            ),
          scenario.timeoutMs,
        ),
      ),
    ]);
  } catch (err) {
    const msg = (err as Error).message;
    outcome = msg.includes("exceeded")
      ? { kind: "timeout", reason: msg }
      : { kind: "fail", reason: msg };
  }

  return {
    scenario,
    outcome,
    startedAt,
    endedAt: Date.now(),
    createdIssues,
    createdPrs,
  };
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/lib/scenario.ts
git commit -m "feat(smoke): add runScenario wrapper with timeout enforcement and logging"
```

---

## Task 10: Orchestrator with pre-flight and summary

**Files:**
- Create: `scripts/smoke/lib/run.ts`

- [ ] **Step 1: Write the implementation**

Create `scripts/smoke/lib/run.ts`:

```ts
import chalk from "chalk";
import type { Octokit } from "@octokit/rest";
import type {
  AppLogins,
  Scenario,
  ScenarioResult,
} from "./types.js";
import { runScenario } from "./scenario.js";

export interface RunAllOpts {
  gh: Octokit;
  owner: string;
  repo: string;
  runTag: string;
  appLogins: AppLogins;
  sequential: boolean;
  pollMs?: number;
}

export async function preflight(opts: {
  gh: Octokit;
  owner: string;
  repo: string;
  allowStale: boolean;
}): Promise<void> {
  // 1) Repo reachable + permissions
  let repoInfo;
  try {
    const res = await opts.gh.repos.get({ owner: opts.owner, repo: opts.repo });
    repoInfo = res.data;
  } catch (err) {
    const status = (err as { status?: number }).status;
    throw new Error(
      `Cannot access ${opts.owner}/${opts.repo} (status ${status ?? "?"}). The PAT must have repo access and Administration:read/write.`,
    );
  }

  // 2) Admin scope (required for deleteIssue GraphQL)
  if (!repoInfo.permissions?.admin) {
    throw new Error(
      `PAT does not have admin permission on ${opts.owner}/${opts.repo}. Required for GraphQL deleteIssue at cleanup time.`,
    );
  }

  // 3) Stale debris check
  if (!opts.allowStale) {
    const hits = await opts.gh.search.issuesAndPullRequests({
      q: `repo:${opts.owner}/${opts.repo} state:open in:title "smoke-"`,
      per_page: 1,
    });
    if (hits.data.total_count > 0) {
      throw new Error(
        `${hits.data.total_count} open smoke artifact(s) found from previous runs. Run \`pnpm smoke -- cleanup\` or pass \`--allow-stale\`.`,
      );
    }
  }
}

export async function runAll(
  scenarios: Scenario[],
  opts: RunAllOpts,
): Promise<ScenarioResult[]> {
  const exec = (s: Scenario) =>
    runScenario(s, {
      gh: opts.gh,
      owner: opts.owner,
      repo: opts.repo,
      runTag: opts.runTag,
      appLogins: opts.appLogins,
      ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
    });

  if (opts.sequential) {
    const results: ScenarioResult[] = [];
    for (const s of scenarios) results.push(await exec(s));
    return results;
  }
  return Promise.all(scenarios.map(exec));
}

export function printSummary(results: ScenarioResult[]): boolean {
  console.log("");
  console.log(chalk.bold("SCENARIO            STATUS    TIME      NOTES"));
  let allOk = true;
  for (const r of results) {
    const duration = ((r.endedAt - r.startedAt) / 1000).toFixed(0);
    const mm = Math.floor(Number(duration) / 60);
    const ss = (Number(duration) % 60).toString().padStart(2, "0");
    const time = `${mm}m${ss}s`;
    const id = r.scenario.id.padEnd(19);
    let status: string;
    let notes = "";
    switch (r.outcome.kind) {
      case "pass":
        status = chalk.green("PASS    ");
        break;
      case "soft-pass":
        status = chalk.yellow("PASS*   ");
        notes = r.outcome.reason;
        break;
      case "fail":
        status = chalk.red("FAIL    ");
        notes = r.outcome.reason;
        allOk = false;
        break;
      case "timeout":
        status = chalk.red("TIMEOUT ");
        notes = r.outcome.reason;
        allOk = false;
        break;
    }
    console.log(`${id} ${status}  ${time.padEnd(9)} ${notes}`);
  }
  return allOk;
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/lib/run.ts
git commit -m "feat(smoke): add pre-flight gates, parallel/sequential orchestrator, summary table"
```

---

## Task 11: Scenario - Quick

**Files:**
- Create: `scripts/smoke/scenarios/quick.ts`

- [ ] **Step 1: Write the scenario**

Create `scripts/smoke/scenarios/quick.ts`:

```ts
import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 10 * 60_000;

const QUICK: Scenario = {
  id: "quick",
  name: "Quick path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: rename dashboard heading`,
      body: [
        "Change the visible heading on the dashboard page from its current",
        'text to "Dashboard Overview".',
        "",
        "Touch only `app/dashboard/page.tsx`. No new components, no state",
        "changes, no styling beyond the heading text.",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:quick", { timeoutMs: 5 * 60_000 });
    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 8 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:needs-review", {
      timeoutMs: 8 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:review-approved", {
      timeoutMs: 6 * 60_000,
    });
    await ctx.mergePr(implPr.number);
    await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });

    return { kind: "pass" };
  },
};

export default QUICK;
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/scenarios/quick.ts
git commit -m "feat(smoke): add quick path scenario"
```

---

## Task 12: Scenario - Medium

**Files:**
- Create: `scripts/smoke/scenarios/medium.ts`

- [ ] **Step 1: Write the scenario**

Create `scripts/smoke/scenarios/medium.ts`:

```ts
import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 20 * 60_000;

const MEDIUM: Scenario = {
  id: "medium",
  name: "Medium path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: status filter on tasks list`,
      body: [
        "Add a status filter to the tasks list in `app/page.tsx`. The filter",
        "lets the user select one of: All, To Do, In Progress, Done, and",
        "filters the visible tasks accordingly.",
        "",
        "Scope: UI + client-side filter state only. No persistence changes",
        "and no schema changes. Touch only `app/page.tsx` and create one new",
        "component file under `app/components/` if needed.",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:medium", { timeoutMs: 5 * 60_000 });
    await ctx.expectLabel(issue, "shopfloor:plan-in-review", {
      timeoutMs: 8 * 60_000,
    });
    const planPr = await ctx.expectPrOpenedFor(issue, "plan", {
      timeoutMs: 8 * 60_000,
    });
    await ctx.mergePr(planPr.number);

    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 10 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:review-approved", {
      timeoutMs: 12 * 60_000,
    });
    await ctx.mergePr(implPr.number);
    await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });

    return { kind: "pass" };
  },
};

export default MEDIUM;
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/scenarios/medium.ts
git commit -m "feat(smoke): add medium path scenario"
```

---

## Task 13: Scenario - Large

**Files:**
- Create: `scripts/smoke/scenarios/large.ts`

- [ ] **Step 1: Write the scenario**

Create `scripts/smoke/scenarios/large.ts`:

```ts
import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 40 * 60_000;

const LARGE: Scenario = {
  id: "large",
  name: "Large path",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: per-task subtasks with rollup`,
      body: [
        "Add support for subtasks under each task on the tasks list",
        "(`app/page.tsx`).",
        "",
        "Requirements:",
        "- New `subtasks` array on the Task type in `app/types.ts`.",
        "- IndexedDB migration to v2 in `app/db.ts` that backfills empty",
        "  arrays on existing rows.",
        "- A nested subtask tree under each task card with add / toggle /",
        "  delete.",
        "- A completion rollup: when all subtasks are done, the parent task",
        "  may be marked done; otherwise the parent is at most in-progress.",
        "",
        "Scope: multi-file, multi-component. Expect triage to classify large.",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:large", { timeoutMs: 5 * 60_000 });

    const specPr = await ctx.expectPrOpenedFor(issue, "spec", {
      timeoutMs: 10 * 60_000,
    });
    await ctx.mergePr(specPr.number);

    const planPr = await ctx.expectPrOpenedFor(issue, "plan", {
      timeoutMs: 10 * 60_000,
    });
    await ctx.mergePr(planPr.number);

    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 12 * 60_000,
    });
    await ctx.expectLabel(issue, "shopfloor:review-approved", {
      timeoutMs: 15 * 60_000,
    });
    await ctx.mergePr(implPr.number);
    await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });

    return { kind: "pass" };
  },
};

export default LARGE;
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/scenarios/large.ts
git commit -m "feat(smoke): add large path scenario"
```

---

## Task 14: Scenario - Awaiting info

**Files:**
- Create: `scripts/smoke/scenarios/awaiting-info.ts`

The triage clarification comment phrasing is inferred from `src/stages/triage/prompt.system.md` (the agent returns `clarifying_questions: string[]`, which `triage/apply.ts` posts as a comment). The regex below catches generic clarification phrasing — keep it loose to tolerate model phrasing variance.

- [ ] **Step 1: Write the scenario**

Create `scripts/smoke/scenarios/awaiting-info.ts`:

```ts
import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 10 * 60_000;

const AWAITING_INFO: Scenario = {
  id: "awaiting-info",
  name: "Awaiting info round-trip",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: make the dashboard better`,
      body: "We want the dashboard to be better. Improve it.",
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, "shopfloor:awaiting-info", {
      timeoutMs: 5 * 60_000,
    });
    await ctx.expectCommentByApp(
      issue,
      ctx.appLogins.primary,
      /clarif|please|which|what|could you|specify|unclear/i,
      { timeoutMs: 5 * 60_000 },
    );

    await ctx.commentOnIssue(
      issue,
      `${ctx.tag} clarification: add a "tasks completed today" counter on the dashboard hero. Pure UI, no persistence. Read from the existing IndexedDB tasks store and count entries with status=done updated within the last 24 hours.`,
    );

    await ctx.expectLabelMissing(issue, "shopfloor:awaiting-info", {
      timeoutMs: 5 * 60_000,
    });
    await ctx.expectLabel(issue, /^shopfloor:(quick|medium)$/, {
      timeoutMs: 5 * 60_000,
    });

    return { kind: "pass" };
  },
};

export default AWAITING_INFO;
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/scenarios/awaiting-info.ts
git commit -m "feat(smoke): add awaiting-info round-trip scenario"
```

---

## Task 15: Scenario - Review only

**Files:**
- Create: `scripts/smoke/scenarios/review-only.ts`

The review marker `<!-- shopfloor-review -->` is defined at `src/stages/review/aggregate.ts:36` and is emitted on every review body (clean or request-changes). The scenario asserts on it directly.

- [ ] **Step 1: Write the scenario**

Create `scripts/smoke/scenarios/review-only.ts`:

```ts
import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 12 * 60_000;
const REVIEW_MARKER = /<!-- shopfloor-review -->/;

const REVIEW_ONLY: Scenario = {
  id: "review-only",
  name: "Review-only flow",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const branchName = `${ctx.tag.replace(/\//g, "-")}/readme-tweak`;

    // Resolve the default branch SHA.
    const repoInfo = await ctx.gh.repos.get({ owner: ctx.owner, repo: ctx.repo });
    const defaultBranch = repoInfo.data.default_branch;
    const baseRef = await ctx.gh.git.getRef({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseSha = baseRef.data.object.sha;

    // Create a new branch.
    await ctx.gh.git.createRef({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    // Append one line to README.md on the new branch.
    const readme = await ctx.gh.repos.getContent({
      owner: ctx.owner,
      repo: ctx.repo,
      path: "README.md",
      ref: branchName,
    });
    if (Array.isArray(readme.data) || readme.data.type !== "file") {
      throw new Error("README.md not found or not a file on default branch");
    }
    const fileSha = readme.data.sha;
    const decoded = Buffer.from(readme.data.content, "base64").toString("utf-8");
    const next = decoded.replace(/\n*$/, `\n\n<!-- smoke ${ctx.tag} -->\n`);
    await ctx.gh.repos.createOrUpdateFileContents({
      owner: ctx.owner,
      repo: ctx.repo,
      path: "README.md",
      branch: branchName,
      message: `${ctx.tag}: smoke readme tweak`,
      content: Buffer.from(next, "utf-8").toString("base64"),
      sha: fileSha,
    });

    // Open the PR. Body deliberately omits Shopfloor-Stage marker.
    const pr = await ctx.gh.pulls.create({
      owner: ctx.owner,
      repo: ctx.repo,
      title: `${ctx.tag} review-only: README tweak`,
      head: branchName,
      base: defaultBranch,
      body: `Smoke test PR for review-only flow. Tag: ${ctx.tag}`,
    });
    ctx.log(`+ PR #${pr.data.number} opened on ${branchName}`);

    // Assert that the review app posts a review carrying the marker.
    await ctx.expectReviewByApp(
      pr.data.number,
      ctx.appLogins.review,
      REVIEW_MARKER,
      { timeoutMs: 10 * 60_000 },
    );

    // Close + delete the branch ourselves so cleanup doesn't need to find it.
    await ctx.closePr(pr.data.number);
    await ctx.deleteBranch(branchName);

    return { kind: "pass" };
  },
};

export default REVIEW_ONLY;
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/scenarios/review-only.ts
git commit -m "feat(smoke): add review-only scenario asserting on shopfloor-review marker"
```

---

## Task 16: Scenario - Revision loop

**Files:**
- Create: `scripts/smoke/scenarios/revision-loop.ts`

- [ ] **Step 1: Write the scenario**

Create `scripts/smoke/scenarios/revision-loop.ts`:

```ts
import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 20 * 60_000;

const REVISION_LOOP: Scenario = {
  id: "revision-loop",
  name: "Implement → review request-changes → revise → approve",
  flaky: true,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const { number: issue } = await ctx.createIssue({
      title: `${ctx.tag}: clear-completed button`,
      body: [
        "Add a 'Clear completed' button to the tasks list. The button should",
        "remove all tasks with status=done.",
        "",
        "CRITICAL: the button MUST be implemented as a Next.js server action",
        "that uses `revalidatePath`. Do NOT use client-side state mutation.",
        "Reject any approach that mutates `useState` directly.",
        "",
        "(Note: this constraint is intentionally hostile to the app's",
        "client-only IndexedDB architecture.)",
      ].join("\n"),
      labels: ["shopfloor:trigger"],
    });

    await ctx.expectLabel(issue, /^shopfloor:(quick|medium)$/, {
      timeoutMs: 5 * 60_000,
    });

    const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
      timeoutMs: 10 * 60_000,
    });
    const firstSha = implPr.headSha;

    // Race the two possible verdict labels.
    const requestChanges = ctx
      .expectLabel(issue, "shopfloor:review-requested-changes", {
        timeoutMs: 10 * 60_000,
      })
      .then(() => "request_changes" as const);
    const approved = ctx
      .expectLabel(issue, "shopfloor:review-approved", {
        timeoutMs: 10 * 60_000,
      })
      .then(() => "approved" as const);

    const firstVerdict = await Promise.race([requestChanges, approved]);

    if (firstVerdict === "approved") {
      return {
        kind: "soft-pass",
        reason: "Review approved on iteration 1; revision loop not exercised",
      };
    }

    // Wait for a new commit on the same PR.
    await ctx.expectNewCommitOn(implPr.number, firstSha, {
      timeoutMs: 10 * 60_000,
    });

    // Final verdict can be approved or stuck — both prove the loop advanced.
    await ctx.expectLabel(
      issue,
      /^shopfloor:(review-approved|review-stuck)$/,
      { timeoutMs: 15 * 60_000 },
    );

    return { kind: "pass" };
  },
};

export default REVISION_LOOP;
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/scenarios/revision-loop.ts
git commit -m "feat(smoke): add revision-loop scenario with soft-pass for first-shot approve"
```

---

## Task 17: Scenario - Skip-review + Revise

**Files:**
- Create: `scripts/smoke/scenarios/skip-review-and-revise.ts`

- [ ] **Step 1: Write the scenario**

Create `scripts/smoke/scenarios/skip-review-and-revise.ts`:

```ts
import type { Scenario, ScenarioOutcome, SmokeCtx } from "../lib/types.js";

const TIMEOUT_MS = 15 * 60_000;

async function runSkipReview(ctx: SmokeCtx): Promise<void> {
  const { number: issue } = await ctx.createIssue({
    title: `${ctx.tag}: skip-review readme date`,
    body: [
      "Append today's date to the bottom of `README.md` in the form",
      '`<!-- last-smoke: YYYY-MM-DD -->`.',
      "",
      "Trivial single-file change.",
    ].join("\n"),
    labels: ["shopfloor:trigger", "shopfloor:skip-review"],
  });

  const implPr = await ctx.expectPrOpenedFor(issue, "implement", {
    timeoutMs: 8 * 60_000,
  });
  await ctx.expectLabel(issue, "shopfloor:impl-in-review", {
    timeoutMs: 8 * 60_000,
  });
  await ctx.expectLabelMissing(issue, "shopfloor:needs-review", {
    timeoutMs: 2 * 60_000,
  });
  await ctx.mergePr(implPr.number);
  await ctx.expectLabel(issue, "shopfloor:done", { timeoutMs: 2 * 60_000 });
}

async function runRevise(ctx: SmokeCtx): Promise<void> {
  const { number: issue } = await ctx.createIssue({
    title: `${ctx.tag}: revise plan target`,
    body: [
      "Add a 'Today' quick-filter button to the tasks list that filters to",
      "tasks created in the last 24 hours. UI + client filter state, two or",
      "three files. Expect triage to classify as medium.",
    ].join("\n"),
    labels: ["shopfloor:trigger"],
  });

  await ctx.expectLabel(issue, "shopfloor:medium", { timeoutMs: 5 * 60_000 });
  await ctx.expectLabel(issue, "shopfloor:plan-in-review", {
    timeoutMs: 8 * 60_000,
  });
  const planPr = await ctx.expectPrOpenedFor(issue, "plan", {
    timeoutMs: 2 * 60_000,
  });
  const firstSha = planPr.headSha;

  await ctx.addLabel(issue, "shopfloor:revise");

  await ctx.expectNewCommitOn(planPr.number, firstSha, {
    timeoutMs: 10 * 60_000,
  });

  // Close the plan PR ourselves; cleanup will tidy the branch.
  await ctx.closePr(planPr.number);
}

const SKIP_REVIEW_AND_REVISE: Scenario = {
  id: "skip-review-and-revise",
  name: "skip-review + revise(plan)",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    await runSkipReview(ctx);
    await runRevise(ctx);
    return { kind: "pass" };
  },
};

export default SKIP_REVIEW_AND_REVISE;
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/scenarios/skip-review-and-revise.ts
git commit -m "feat(smoke): add skip-review and revise(plan) combined scenario"
```

---

## Task 18: CLI entry

**Files:**
- Create: `scripts/smoke/index.ts`

- [ ] **Step 1: Write the entry point**

Create `scripts/smoke/index.ts`:

```ts
import { parseArgs } from "node:util";
import chalk from "chalk";
import { loadAndResolveEnv } from "./lib/env.js";
import { makeGh } from "./lib/github.js";
import { newRunTag } from "./lib/tag.js";
import { preflight, runAll, printSummary } from "./lib/run.js";
import { cleanupByTitlePrefix } from "./lib/cleanup.js";
import type { Scenario } from "./lib/types.js";

import QUICK from "./scenarios/quick.js";
import MEDIUM from "./scenarios/medium.js";
import LARGE from "./scenarios/large.js";
import AWAITING_INFO from "./scenarios/awaiting-info.js";
import REVIEW_ONLY from "./scenarios/review-only.js";
import REVISION_LOOP from "./scenarios/revision-loop.js";
import SKIP_REVIEW_AND_REVISE from "./scenarios/skip-review-and-revise.js";

const OWNER = "niranjan94";
const REPO = "shopfloor-smoke";

const ALL_SCENARIOS: Scenario[] = [
  QUICK,
  MEDIUM,
  LARGE,
  AWAITING_INFO,
  REVIEW_ONLY,
  REVISION_LOOP,
  SKIP_REVIEW_AND_REVISE,
];

interface Args {
  positional: string[];
  only?: string;
  tag?: string;
  sequential: boolean;
  allowStale: boolean;
  pollMs?: number;
}

function parseCliArgs(argv: string[]): Args {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      only: { type: "string" },
      tag: { type: "string" },
      sequential: { type: "boolean", default: false },
      "allow-stale": { type: "boolean", default: false },
      "poll-ms": { type: "string" },
    },
  });
  return {
    positional: parsed.positionals,
    ...(parsed.values.only !== undefined ? { only: parsed.values.only } : {}),
    ...(parsed.values.tag !== undefined ? { tag: parsed.values.tag } : {}),
    sequential: parsed.values.sequential === true,
    allowStale: parsed.values["allow-stale"] === true,
    ...(parsed.values["poll-ms"] !== undefined
      ? { pollMs: Number(parsed.values["poll-ms"]) }
      : {}),
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const { token, appLogins } = loadAndResolveEnv();
  const gh = makeGh(token);

  if (args.positional[0] === "cleanup") {
    const prefix = args.tag ?? "smoke-";
    console.log(chalk.bold(`Cleaning up artifacts with prefix "${prefix}"...`));
    const report = await cleanupByTitlePrefix(gh, OWNER, REPO, prefix);
    console.log(
      `  PRs closed:        ${report.prsClosed}\n  Branches deleted:  ${report.branchesDeleted}\n  Issues deleted:    ${report.issuesDeleted}`,
    );
    if (report.errors.length > 0) {
      console.log(chalk.red(`  Errors (${report.errors.length}):`));
      for (const e of report.errors) console.log(`    - ${e.context}: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  await preflight({ gh, owner: OWNER, repo: REPO, allowStale: args.allowStale });

  const runTag = args.tag ?? newRunTag();
  console.log(chalk.bold(`Smoke run tag: ${runTag}`));

  const selected = args.only
    ? ALL_SCENARIOS.filter((s) => args.only!.split(",").includes(s.id))
    : ALL_SCENARIOS;

  if (selected.length === 0) {
    console.error(`No scenarios matched --only=${args.only}`);
    process.exit(2);
  }

  console.log(
    `Running ${selected.length} scenario(s) ${args.sequential ? "sequentially" : "in parallel"}: ${selected.map((s) => s.id).join(", ")}`,
  );

  const results = await runAll(selected, {
    gh,
    owner: OWNER,
    repo: REPO,
    runTag,
    appLogins,
    sequential: args.sequential,
    ...(args.pollMs !== undefined ? { pollMs: args.pollMs } : {}),
  });

  // Per-scenario cleanup on pass.
  for (const r of results) {
    if (r.outcome.kind === "pass" || r.outcome.kind === "soft-pass") {
      const tag = `${runTag}/${r.scenario.id}`;
      try {
        await cleanupByTitlePrefix(gh, OWNER, REPO, tag);
      } catch (err) {
        console.warn(
          chalk.yellow(`cleanup for ${tag} reported an error: ${(err as Error).message}`),
        );
      }
    }
  }

  const ok = printSummary(results);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(chalk.red(`smoke fatal: ${(err as Error).message}`));
  process.exit(2);
});
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Verify the CLI loads (no scenarios run)**

```bash
SHOPFLOOR_SMOKE_GH_TOKEN=dummy SHOPFLOOR_PRIMARY_APP_LOGIN=a SHOPFLOOR_REVIEW_APP_LOGIN=b pnpm smoke -- --only=__nope__ 2>&1 | head -5
```

Expected: process exits 2 with "No scenarios matched --only=__nope__" — confirming arg parsing and env loading work end-to-end without hitting GitHub. (The env validation happens before pre-flight, so this never reaches the network with a dummy token. If pre-flight runs first against the dummy token it will fail with a 401 — either outcome confirms the CLI is wired.)

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke/index.ts
git commit -m "feat(smoke): add CLI entry with cleanup subcommand and per-scenario cleanup on pass"
```

---

## Task 19: Operator README

**Files:**
- Create: `scripts/smoke/README.md`
- Modify: `README.md`

- [ ] **Step 1: Write scripts/smoke/README.md**

Create `scripts/smoke/README.md`:

````markdown
# Smoke runner

Local TypeScript runner that drives `niranjan94/shopfloor-smoke` through a fixed catalogue of end-to-end scenarios against the real `niranjan94/shopfloor@v2` action.

This is a developer tool. It is not invoked from CI by default. Each full run burns roughly 30–40 minutes of GitHub Actions time on the smoke repo and a non-trivial number of Anthropic API tokens.

## Setup

1. Mint a fine-grained personal access token scoped to `niranjan94/shopfloor-smoke`:
   - Issues: read / write
   - Pull requests: read / write
   - Contents: read / write
   - Administration: read / write (required for GraphQL `deleteIssue`)

2. Copy `.env.example` to `.env` and fill in the token plus the bot logins for the Shopfloor apps installed on `shopfloor-smoke`.

3. Make sure `niranjan94/shopfloor`'s `v2` ref points at the commit you want to test. The runner does NOT push this for you. From this repo:

   ```bash
   git push origin HEAD:refs/tags/v2 --force   # only if you really want v2 = current HEAD
   ```

## Running

```bash
pnpm smoke                            # all scenarios in parallel
pnpm smoke -- --only quick,medium     # subset
pnpm smoke -- --sequential            # one at a time (easier logs)
pnpm smoke -- --tag X                 # reuse a tag (debugging)
pnpm smoke -- --allow-stale           # skip the previous-run gate
pnpm smoke -- --poll-ms 15000         # override default poll interval (debugging the runner)
pnpm smoke -- cleanup                 # close PRs, delete branches, delete issues for any smoke-* artifact
pnpm smoke -- cleanup --tag X         # cleanup only artifacts tagged X
```

Exit code: 0 if every scenario is PASS or PASS*. Nonzero if any FAIL or TIMEOUT.

## Scenarios

| ID | Path | Timeout | Notes |
| -- | ---- | ------- | ----- |
| quick | triage(quick) → impl → review → merge → done | 10m | |
| medium | triage(medium) → plan → merge → impl → review → merge → done | 20m | |
| large | triage(large) → spec → merge → plan → merge → impl → review → merge → done | 40m | |
| awaiting-info | vague brief → triage clarifies → answer → triage classifies | 10m | |
| review-only | human-authored PR → shopfloor-review.yml posts review | 12m | Asserts on `<!-- shopfloor-review -->` marker |
| revision-loop | impl → request-changes → revise → approve | 20m | `flaky: true`. First-shot approve = PASS* |
| skip-review-and-revise | skip-review path + revise(plan) | 15m | Two micro-scenarios in one file |

## Cleanup model

Issues are deleted via GraphQL (`deleteIssue` mutation). PRs cannot be deleted via the GitHub API — the runner closes them and deletes their branches. PRs persist in the timeline as `closed · branch deleted` forever; this is a GitHub limitation, not a runner bug.

Cleanup on PASS is automatic per scenario. On FAIL or TIMEOUT, artifacts are left in place for inspection. Run `pnpm smoke -- cleanup` to purge everything matching `smoke-` (or pass `--tag X` to scope).

## Known flakiness

- **revision-loop** is flagged `flaky: true`. If the review approves the first impl iteration, the scenario returns `PASS*` rather than failing, because the loop wasn't exercised but nothing is actually broken. This is unavoidable without a deterministic way to force `REQUEST_CHANGES`.
- **Triage classification drift** between runs is possible — the same brief may be classified `quick` or `medium`. Scenarios that care use a regex (`/^shopfloor:(quick|medium)$/`) rather than pinning the exact label.

## Maintenance

If the PR footer format in `src/state/metadata.ts` changes, update the matching regex in `scripts/smoke/lib/footer.ts` and the test in `test/smoke/footer.test.ts`. If the review marker in `src/stages/review/aggregate.ts` changes, update `scripts/smoke/scenarios/review-only.ts`. These duplications are deliberate: the smoke runner intentionally does not import from `src/`.
````

- [ ] **Step 2: Add a one-line pointer to the project README**

Edit `README.md`. Find an appropriate location near the existing test / development section, and add:

```markdown
### Smoke testing

A developer-invoked end-to-end runner exercises the real action against `niranjan94/shopfloor-smoke`. See [`scripts/smoke/README.md`](scripts/smoke/README.md).
```

- [ ] **Step 3: Verify markdown lints (format check)**

```bash
pnpm format:check scripts/smoke/README.md README.md
```

Expected: PASS, no diffs.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke/README.md README.md
git commit -m "docs(smoke): add operator README and project README pointer"
```

---

## Task 20: Final verification

- [ ] **Step 1: Full typecheck**

```bash
pnpm typecheck
```

Expected: exits 0.

- [ ] **Step 2: Full unit test run**

```bash
pnpm test
```

Expected: all tests pass — including the four new smoke unit tests (tag, env, footer, expect, cleanup).

- [ ] **Step 3: Format check**

```bash
pnpm format:check
```

Expected: PASS, no diffs.

- [ ] **Step 4: CLI smoke (literal smoke)**

```bash
pnpm smoke -- --only quick --tag smoke-validation-0001 --allow-stale --poll-ms 2000
```

(This will actually run the quick scenario against the live repo. Skip this step if you do not want to spend the minutes — but it is the only true integration check.)

Expected: exits 0 with a PASS row, or non-zero with diagnostic output explaining what failed.

- [ ] **Step 5: No commit on this task**

This is the final integration check, not new code. Stop here.

---

## Self-Review (already performed by the plan author)

**Spec coverage.** Every spec section maps to one or more tasks:

| Spec section | Tasks |
| ------------ | ----- |
| Directory layout | T1, T2, T6, T7, T8, T9, T10, T18, T19 |
| Per-run tag, scenario tag | T3 |
| Auth model, env vars | T1, T4 |
| Pre-flight gates | T10 |
| Scenario engine, ctx, polling | T7, T9 |
| Reporting | T9, T10 |
| Quick / Medium / Large | T11, T12, T13 |
| Awaiting-info | T14 |
| Review-only | T15 (marker resolved via `src/stages/review/aggregate.ts:36`) |
| Revision loop (flaky) | T16 |
| Skip-review + Revise | T17 |
| Cleanup | T8, T18 |
| CLI surface | T18 |
| Concurrency | T10 |
| Error handling | T6 (retry), T9 (timeout), T18 (cleanup error swallow) |
| Documentation | T19 |
| Implementation outline (commit sequence) | T1–T19 conventional-commits match |
| Risks (LLM nondeterminism) | T14 loose regex, T16 flaky flag, T11–T13 large timeout buffer |

**Spec open implementation questions:**
- Review marker shape: resolved — `<!-- shopfloor-review -->` at `src/stages/review/aggregate.ts:36`. Encoded in T15.
- GraphQL admin scope: documented in `.env.example` (T1) and verified by pre-flight (T10).
- Awaiting-info regex: T14 uses a deliberately loose pattern; documented in the README maintenance note (T19).

**Placeholder scan.** No `TBD`, `TODO`, or "implement later" lines. Every step shows code or a command.

**Type consistency.** `Scenario`, `SmokeCtx`, `PrRef`, `ScenarioOutcome`, `ScenarioResult` are defined in T2 and referenced unchanged in T7, T9, T10, T11–T18. `cleanupByTitlePrefix`'s signature in T8 matches its callers in T18. `makeExpectClient`'s return type is `ExpectClient`; the `SmokeCtx.expect*` methods are exposed via the scenario wrapper in T9.

**Type quirks honored.** The tsconfig has `exactOptionalPropertyTypes: true`, so the plan uses conditional spread (`...(x !== undefined ? { x } : {})`) when forwarding optional fields, rather than passing `x: undefined`.
