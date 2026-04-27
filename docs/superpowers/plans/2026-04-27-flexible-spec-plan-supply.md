# Flexible Spec/Plan Supply at Triage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users file an issue with a pre-supplied spec or plan (inline body content under H2 markers, or a path to a `.md` file in the repo) and have triage either skip ahead via path-overrides in issue metadata or open a seed stage PR pre-populated with the supplied content.

**Architecture:** Extend `parseIssueMetadata` / `upsertIssueMetadata` with optional `Shopfloor-Spec-Path:` and `Shopfloor-Plan-Path:` keys. Route every consumer of canonical spec/plan paths through a new `resolveArtifactPaths` helper that respects overrides. Extend the triage prompt + output schema to detect supplied artifacts. Branch `apply-triage-decision` on the new schema fields: `path` cases persist the override and skip stages; `body` cases call a new `seed-stage-pr` helper that creates a branch + commits the file + opens the PR using GitHub's Git Data and Contents APIs.

**Tech Stack:** TypeScript, esbuild, vitest, `@octokit/rest` via `@actions/github`. Pre-existing pnpm monorepo (`router/`).

**Spec:** `docs/superpowers/specs/2026-04-27-flexible-spec-plan-supply-design.md`

**Conventions for this plan:**

- Each task ends with a Conventional Commits commit. Types used: `feat`, `refactor`, `test`, `chore`, `docs`. Scopes used: `router`, `prompts`, `workflow`.
- Test-driven where possible: write the failing test, run it red, implement, run green, commit. Pure functions and helpers all qualify; the seed-stage-pr helper has integration character but its behavior mocks cleanly.
- Type-check after every code change with `pnpm exec tsc --noEmit` from the repo root (per project-wide non-negotiable). Run vitest from the repo root with `pnpm test`.
- The `router/dist/index.cjs` bundle is committed at the end (one rebuild covers all router changes).
- Helper tests call the inner function (e.g. `applyTriageDecision`), not the `core.getInput`-shaped runner.

---

## File Structure

```
router/
  src/
    types.ts                              MODIFY  Extend OctokitLike with Git Data + Contents API
    github.ts                             MODIFY  Add adapter methods: getRefSha, createRef, getFileSha, putFileContents
    state.ts                              MODIFY  Extend IssueMetadata, parseIssueMetadata; route through resolveArtifactPaths
    helpers/
      resolve-artifact-paths.ts           NEW     Single source of truth for canonical-vs-override paths + validation
      seed-stage-pr.ts                    NEW     Branch + commit + open PR for body-supplied artifacts
      upsert-issue-metadata.ts            MODIFY  Render Shopfloor-Spec-Path / Shopfloor-Plan-Path
      apply-triage-decision.ts            MODIFY  Decision matrix branching on supplied artifacts
      build-revision-context.ts           MODIFY  Apply override after issue fetch
    index.ts                              UNCHANGED  (no new helper exposed via input switch)
  test/
    helpers/
      resolve-artifact-paths.test.ts      NEW     Pure-function tests for path resolution + validation
      seed-stage-pr.test.ts               NEW     Mock-adapter tests for the new helper
      upsert-issue-metadata.test.ts       MODIFY  Cover specPath / planPath round-trip
      apply-triage-decision.test.ts       MODIFY  Cover all rows of the decision matrix
      build-revision-context.test.ts      MODIFY  Cover override application
    state.test.ts                         MODIFY  Cover override resolution in computeStageFromLabels
    fixtures/events/
      issue-labeled-needs-plan-with-spec-path.json   NEW   Override fixture
  dist/index.cjs                          REBUILT
prompts/
  triage.md                               MODIFY  Add <artifact_detection> + extend output schema docs
docs/
  superpowers/specs/2026-04-27-flexible-spec-plan-supply-design.md   ALREADY COMMITTED
  superpowers/plans/2026-04-27-flexible-spec-plan-supply.md          THIS FILE
```

---

## Task 1: Extend `OctokitLike` and `GitHubAdapter` with Git Data + Contents API

**Why first:** The seed-stage-pr helper needs branch creation (Git Refs API) and file write (Repos Contents API) on the adapter. Every later task that touches the seed flow depends on these methods.

**Files:**

- Modify: `router/src/types.ts` (extend `OctokitLike.rest` with `git` and add to `repos`)
- Modify: `router/src/github.ts` (add four adapter methods)
- Modify: `router/test/helpers/_mock-adapter.ts` (mocks for the new endpoints)
- Test: `router/test/github.test.ts` (smoke tests for the new adapter methods)

- [ ] **Step 1.1: Read the existing `OctokitLike` shape**

Read `router/src/types.ts:125-302` to confirm the existing pattern (named-params object input, narrow result types). The new methods follow the same idiom.

- [ ] **Step 1.2: Write the failing adapter tests**

Append to `router/test/github.test.ts`. Read the file first to see how it stubs the octokit-like object today.

```ts
describe("GitHubAdapter Git Data + Contents API surface", () => {
  test("getRefSha returns the SHA for a heads ref", async () => {
    const octokit = {
      rest: {
        git: {
          getRef: vi.fn().mockResolvedValue({
            data: { object: { sha: "abc123" } },
          }),
        },
      },
    } as unknown as OctokitLike;
    const adapter = new GitHubAdapter(octokit, { owner: "o", repo: "r" });
    expect(await adapter.getRefSha("main")).toBe("abc123");
    expect(octokit.rest.git.getRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "heads/main",
    });
  });

  test("createRef creates a new branch ref", async () => {
    const create = vi.fn().mockResolvedValue({ data: {} });
    const adapter = new GitHubAdapter(
      { rest: { git: { createRef: create } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    await adapter.createRef("shopfloor/spec/42-foo", "abc123");
    expect(create).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: "refs/heads/shopfloor/spec/42-foo",
      sha: "abc123",
    });
  });

  test("createRef rethrows non-422 errors", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const adapter = new GitHubAdapter(
      { rest: { git: { createRef: create } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    await expect(adapter.createRef("b", "s")).rejects.toThrow("boom");
  });

  test("createRef swallows 422 (ref already exists) and returns false", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Reference already exists"), { status: 422 }),
      );
    const adapter = new GitHubAdapter(
      { rest: { git: { createRef: create } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    expect(await adapter.createRef("b", "s")).toBe(false);
  });

  test("getFileSha returns null on 404 and the blob sha when present", async () => {
    const get404 = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 404 }));
    const adapter404 = new GitHubAdapter(
      { rest: { repos: { getContent: get404 } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    expect(
      await adapter404.getFileSha("path/to/x.md", "shopfloor/spec/1-x"),
    ).toBeNull();

    const getOk = vi
      .fn()
      .mockResolvedValueOnce({ data: { sha: "blob123", type: "file" } });
    const adapterOk = new GitHubAdapter(
      { rest: { repos: { getContent: getOk } } } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    expect(
      await adapterOk.getFileSha("path/to/x.md", "shopfloor/spec/1-x"),
    ).toBe("blob123");
  });

  test("putFileContents creates a file (no sha) and updates one (with sha)", async () => {
    const put = vi.fn().mockResolvedValue({ data: {} });
    const adapter = new GitHubAdapter(
      {
        rest: { repos: { createOrUpdateFileContents: put } },
      } as unknown as OctokitLike,
      { owner: "o", repo: "r" },
    );
    await adapter.putFileContents({
      path: "docs/spec.md",
      branch: "shopfloor/spec/1-x",
      message: "docs(spec): seed",
      content: "hi",
    });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "o",
        repo: "r",
        path: "docs/spec.md",
        branch: "shopfloor/spec/1-x",
        message: "docs(spec): seed",
        content: Buffer.from("hi", "utf8").toString("base64"),
      }),
    );
    const callWithSha = put.mock.calls[0][0] as { sha?: string };
    expect(callWithSha.sha).toBeUndefined();

    await adapter.putFileContents({
      path: "docs/spec.md",
      branch: "shopfloor/spec/1-x",
      message: "docs(spec): update",
      content: "hi2",
      sha: "blob123",
    });
    const second = put.mock.calls[1][0] as { sha?: string };
    expect(second.sha).toBe("blob123");
  });
});
```

- [ ] **Step 1.3: Run the tests red**

```bash
pnpm test -- github.test
```

Expected: failures naming `getRefSha`, `createRef`, `getFileSha`, `putFileContents` as missing methods.

- [ ] **Step 1.4: Extend `OctokitLike`**

In `router/src/types.ts`, inside `OctokitLike.rest`:

```ts
git: {
  getRef(params: {
    owner: string;
    repo: string;
    ref: string; // e.g. "heads/main"
  }): Promise<{ data: { object: { sha: string } } }>;
  createRef(params: {
    owner: string;
    repo: string;
    ref: string; // e.g. "refs/heads/shopfloor/spec/42-foo"
    sha: string;
  }): Promise<unknown>;
};
```

Inside `OctokitLike.rest.repos`, add:

```ts
getContent(params: {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<{ data: { sha: string; type: string } | Array<unknown> }>;
createOrUpdateFileContents(params: {
  owner: string;
  repo: string;
  path: string;
  branch: string;
  message: string;
  content: string; // base64
  sha?: string;
}): Promise<unknown>;
```

- [ ] **Step 1.5: Implement adapter methods**

Append to `router/src/github.ts` inside the `GitHubAdapter` class:

```ts
async getRefSha(branchName: string): Promise<string> {
  const res = await this.octokit.rest.git.getRef({
    ...this.repo,
    ref: `heads/${branchName}`,
  });
  return res.data.object.sha;
}

// Returns true on create, false if the ref already exists (idempotent retry path).
// Any other failure rethrows.
async createRef(branchName: string, sha: string): Promise<boolean> {
  try {
    await this.octokit.rest.git.createRef({
      ...this.repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 422) return false;
    throw err;
  }
}

async getFileSha(path: string, branch: string): Promise<string | null> {
  try {
    const res = await this.octokit.rest.repos.getContent({
      ...this.repo,
      path,
      ref: branch,
    });
    if (Array.isArray(res.data)) return null; // path is a directory
    return res.data.sha;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return null;
    throw err;
  }
}

async putFileContents(input: {
  path: string;
  branch: string;
  message: string;
  content: string;
  sha?: string;
}): Promise<void> {
  await this.octokit.rest.repos.createOrUpdateFileContents({
    ...this.repo,
    path: input.path,
    branch: input.branch,
    message: input.message,
    content: Buffer.from(input.content, "utf8").toString("base64"),
    ...(input.sha ? { sha: input.sha } : {}),
  });
}
```

- [ ] **Step 1.6: Wire mocks in `_mock-adapter.ts`**

Add to `MockBundle.mocks`:

```ts
getRef: ReturnType<typeof vi.fn>;
createRef: ReturnType<typeof vi.fn>;
getContent: ReturnType<typeof vi.fn>;
createOrUpdateFileContents: ReturnType<typeof vi.fn>;
```

In `makeMockAdapter`, default them to `vi.fn().mockResolvedValue({ data: {} })` (or appropriate shapes — `getRef` returns `{ data: { object: { sha: "main-sha" } } }`, `getContent` rejects with `status: 404` by default so `getFileSha` returns null on the cold path).

Wire them into the `octokit.rest.git` and `octokit.rest.repos` blocks.

- [ ] **Step 1.7: Run the tests green**

```bash
pnpm test -- github.test
```

All four new test cases pass.

- [ ] **Step 1.8: Type-check**

```bash
pnpm exec tsc --noEmit
```

No errors.

- [ ] **Step 1.9: Commit**

```bash
git add router/src/types.ts router/src/github.ts router/test/github.test.ts router/test/helpers/_mock-adapter.ts
git commit -m "feat(router): add Git Data + Contents adapter methods"
```

---

## Task 2: Extend `IssueMetadata` parser with `specPath` / `planPath`

**Why second:** Parsers are a cheap, pure change with no I/O. Land them before any consumer reads or writes the new keys.

**Files:**

- Modify: `router/src/state.ts:143-160` (extend `IssueMetadata` interface and `parseIssueMetadata`)
- Test: `router/test/state.test.ts` (add a `parseIssueMetadata` describe block — search for existing coverage first; if no block exists, append one)

- [ ] **Step 2.1: Confirm where `parseIssueMetadata` is currently tested**

```bash
grep -n "parseIssueMetadata" router/test/**/*.test.ts
```

If a `describe("parseIssueMetadata")` block exists, append to it. Otherwise add a new block at the bottom of `router/test/state.test.ts`.

- [ ] **Step 2.2: Write the failing tests**

```ts
describe("parseIssueMetadata Shopfloor-Spec-Path / Shopfloor-Plan-Path", () => {
  test("returns specPath when present", () => {
    const body = [
      "Body.",
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: my-slug",
      "Shopfloor-Spec-Path: docs/specs/x.md",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "my-slug",
      specPath: "docs/specs/x.md",
    });
  });

  test("returns planPath when present", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: s",
      "Shopfloor-Plan-Path: docs/plans/x.md",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "s",
      planPath: "docs/plans/x.md",
    });
  });

  test("returns both when both are present", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: s",
      "Shopfloor-Spec-Path: docs/a.md",
      "Shopfloor-Plan-Path: docs/b.md",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({
      slug: "s",
      specPath: "docs/a.md",
      planPath: "docs/b.md",
    });
  });

  test("legacy block with only slug parses cleanly", () => {
    const body = "<!-- shopfloor:metadata\nShopfloor-Slug: s\n-->";
    expect(parseIssueMetadata(body)).toEqual({ slug: "s" });
  });

  test("ignores unknown keys inside the block", () => {
    const body = [
      "<!-- shopfloor:metadata",
      "Shopfloor-Slug: s",
      "Shopfloor-Future-Key: whatever",
      "-->",
    ].join("\n");
    expect(parseIssueMetadata(body)).toEqual({ slug: "s" });
  });
});
```

- [ ] **Step 2.3: Run the tests red**

```bash
pnpm test -- state.test
```

Expected: failures comparing the new keys.

- [ ] **Step 2.4: Extend the interface and parser**

In `router/src/state.ts:143-160`:

```ts
export interface IssueMetadata {
  slug?: string;
  specPath?: string;
  planPath?: string;
}

export function parseIssueMetadata(body: string | null): IssueMetadata | null {
  if (!body) return null;
  const blockMatch = body.match(/<!--\s*shopfloor:metadata\s*([\s\S]*?)-->/);
  if (!blockMatch) return null;
  const block = blockMatch[1];
  const metadata: IssueMetadata = {};
  const slugMatch = block.match(/^\s*Shopfloor-Slug:\s*(\S+)\s*$/m);
  if (slugMatch) metadata.slug = slugMatch[1];
  const specPathMatch = block.match(/^\s*Shopfloor-Spec-Path:\s*(\S+)\s*$/m);
  if (specPathMatch) metadata.specPath = specPathMatch[1];
  const planPathMatch = block.match(/^\s*Shopfloor-Plan-Path:\s*(\S+)\s*$/m);
  if (planPathMatch) metadata.planPath = planPathMatch[1];
  return metadata;
}
```

- [ ] **Step 2.5: Run tests green and type-check**

```bash
pnpm test -- state.test
pnpm exec tsc --noEmit
```

- [ ] **Step 2.6: Commit**

```bash
git add router/src/state.ts router/test/state.test.ts
git commit -m "feat(router): parse Shopfloor-Spec-Path and Shopfloor-Plan-Path metadata"
```

---

## Task 3: Extend `upsertIssueMetadata` to render the new keys

**Files:**

- Modify: `router/src/helpers/upsert-issue-metadata.ts`
- Modify: `router/test/helpers/upsert-issue-metadata.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Append to the existing `describe("upsertIssueMetadata")` block:

```ts
test("writes specPath when supplied alongside slug", () => {
  const next = upsertIssueMetadata(null, {
    slug: "s",
    specPath: "docs/specs/x.md",
  });
  expect(parseIssueMetadata(next)).toEqual({
    slug: "s",
    specPath: "docs/specs/x.md",
  });
});

test("writes planPath when supplied alongside slug", () => {
  const next = upsertIssueMetadata(null, {
    slug: "s",
    planPath: "docs/plans/x.md",
  });
  expect(parseIssueMetadata(next)).toEqual({
    slug: "s",
    planPath: "docs/plans/x.md",
  });
});

test("writes both paths in stable order: slug, specPath, planPath", () => {
  const next = upsertIssueMetadata(null, {
    slug: "s",
    specPath: "a.md",
    planPath: "b.md",
  });
  // Order matters for snapshot stability and readability.
  const block = next.match(/<!--\s*shopfloor:metadata([\s\S]*?)-->/)?.[1] ?? "";
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  expect(lines).toEqual([
    "Shopfloor-Slug: s",
    "Shopfloor-Spec-Path: a.md",
    "Shopfloor-Plan-Path: b.md",
  ]);
});

test("upsert is idempotent across spec/plan path writes", () => {
  const once = upsertIssueMetadata(null, {
    slug: "s",
    specPath: "a.md",
  });
  const twice = upsertIssueMetadata(once, { slug: "s", specPath: "a.md" });
  expect(twice).toBe(once);
});

test("upserting only the slug onto a body that already has paths preserves the paths", () => {
  // The current shape of the function takes the full record each call. This
  // test guards against a future change that drops fields when not passed.
  // For now, we explicitly require callers to pass the full intended state.
  const initial = upsertIssueMetadata(null, {
    slug: "s",
    specPath: "a.md",
  });
  const next = upsertIssueMetadata(initial, {
    slug: "s",
    specPath: "a.md",
    planPath: "b.md",
  });
  expect(parseIssueMetadata(next)).toEqual({
    slug: "s",
    specPath: "a.md",
    planPath: "b.md",
  });
});
```

- [ ] **Step 3.2: Run tests red**

```bash
pnpm test -- upsert-issue-metadata.test
```

- [ ] **Step 3.3: Update the writer**

In `router/src/helpers/upsert-issue-metadata.ts`:

```ts
function renderBlock(fields: Record<string, string>): string {
  const lines = [OPENER];
  if (fields.slug !== undefined) lines.push(`Shopfloor-Slug: ${fields.slug}`);
  if (fields.specPath !== undefined)
    lines.push(`Shopfloor-Spec-Path: ${fields.specPath}`);
  if (fields.planPath !== undefined)
    lines.push(`Shopfloor-Plan-Path: ${fields.planPath}`);
  lines.push(CLOSER);
  return lines.join("\n");
}
```

The function signature stays `Record<string, string>`; callers pass an object whose keys map directly onto the line names. Documented field set: `slug`, `specPath`, `planPath`.

- [ ] **Step 3.4: Run tests green and type-check**

```bash
pnpm test -- upsert-issue-metadata.test
pnpm exec tsc --noEmit
```

- [ ] **Step 3.5: Commit**

```bash
git add router/src/helpers/upsert-issue-metadata.ts router/test/helpers/upsert-issue-metadata.test.ts
git commit -m "feat(router): render spec/plan path overrides in issue metadata block"
```

---

## Task 4: New `resolveArtifactPaths` helper

**Why now:** The pure resolver is the single source of truth referenced by every later consumer. Build it now, with full validation coverage, before wiring it into call sites.

**Files:**

- Create: `router/src/helpers/resolve-artifact-paths.ts`
- Test: `router/test/helpers/resolve-artifact-paths.test.ts`

- [ ] **Step 4.1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import {
  resolveArtifactPaths,
  validateOverridePath,
} from "../../src/helpers/resolve-artifact-paths";

describe("resolveArtifactPaths", () => {
  test("no metadata yields canonical paths from issue number + slug", () => {
    expect(resolveArtifactPaths(42, "my-slug", null)).toEqual({
      specFilePath: "docs/shopfloor/specs/42-my-slug.md",
      planFilePath: "docs/shopfloor/plans/42-my-slug.md",
    });
  });

  test("metadata without paths yields canonical paths", () => {
    expect(resolveArtifactPaths(42, "s", { slug: "s" })).toEqual({
      specFilePath: "docs/shopfloor/specs/42-s.md",
      planFilePath: "docs/shopfloor/plans/42-s.md",
    });
  });

  test("specPath override returns the override for spec, canonical for plan", () => {
    expect(
      resolveArtifactPaths(42, "s", { slug: "s", specPath: "docs/x.md" }),
    ).toEqual({
      specFilePath: "docs/x.md",
      planFilePath: "docs/shopfloor/plans/42-s.md",
    });
  });

  test("planPath override returns canonical for spec, override for plan", () => {
    expect(
      resolveArtifactPaths(42, "s", { slug: "s", planPath: "docs/y.md" }),
    ).toEqual({
      specFilePath: "docs/shopfloor/specs/42-s.md",
      planFilePath: "docs/y.md",
    });
  });

  test("both overrides returned together", () => {
    expect(
      resolveArtifactPaths(42, "s", {
        slug: "s",
        specPath: "a.md",
        planPath: "b.md",
      }),
    ).toEqual({
      specFilePath: "a.md",
      planFilePath: "b.md",
    });
  });
});

describe("validateOverridePath", () => {
  test("accepts a clean relative .md path", () => {
    expect(() => validateOverridePath("docs/specs/x.md")).not.toThrow();
  });

  test("rejects a leading slash (absolute path)", () => {
    expect(() => validateOverridePath("/etc/passwd")).toThrow(
      /must be a relative path/,
    );
  });

  test("rejects a path containing ..", () => {
    expect(() => validateOverridePath("docs/../etc/x.md")).toThrow(
      /must not contain '\.\.'/,
    );
  });

  test("rejects a non-.md path", () => {
    expect(() => validateOverridePath("docs/specs/x.txt")).toThrow(
      /must end in '\.md'/,
    );
  });

  test("rejects an empty string", () => {
    expect(() => validateOverridePath("")).toThrow(/must not be empty/);
  });
});
```

- [ ] **Step 4.2: Run tests red**

```bash
pnpm test -- resolve-artifact-paths.test
```

- [ ] **Step 4.3: Implement the helper**

`router/src/helpers/resolve-artifact-paths.ts`:

```ts
import type { IssueMetadata } from "../state";

export interface ArtifactPaths {
  specFilePath: string;
  planFilePath: string;
}

const CANONICAL_SPEC_DIR = "docs/shopfloor/specs";
const CANONICAL_PLAN_DIR = "docs/shopfloor/plans";

export function resolveArtifactPaths(
  issueNumber: number,
  slug: string,
  metadata: IssueMetadata | null,
): ArtifactPaths {
  return {
    specFilePath:
      metadata?.specPath ?? `${CANONICAL_SPEC_DIR}/${issueNumber}-${slug}.md`,
    planFilePath:
      metadata?.planPath ?? `${CANONICAL_PLAN_DIR}/${issueNumber}-${slug}.md`,
  };
}

// Throws on the first violation, naming the violated rule. Caller catches and
// surfaces the message into a failure label / comment so the human can fix the
// metadata block.
export function validateOverridePath(path: string): void {
  if (path.length === 0) {
    throw new Error("override path must not be empty");
  }
  if (path.startsWith("/")) {
    throw new Error("override path must be a relative path (no leading '/')");
  }
  if (path.split("/").some((seg) => seg === "..")) {
    throw new Error("override path must not contain '..' segments");
  }
  if (!path.endsWith(".md")) {
    throw new Error("override path must end in '.md'");
  }
}
```

- [ ] **Step 4.4: Run tests green and type-check**

```bash
pnpm test -- resolve-artifact-paths.test
pnpm exec tsc --noEmit
```

- [ ] **Step 4.5: Commit**

```bash
git add router/src/helpers/resolve-artifact-paths.ts router/test/helpers/resolve-artifact-paths.test.ts
git commit -m "feat(router): add resolveArtifactPaths helper with override validation"
```

---

## Task 5: Wire `resolveArtifactPaths` into `computeStageFromLabels`

**Files:**

- Modify: `router/src/state.ts:175-215` (`computeStageFromLabels`)
- Modify: `router/test/state.test.ts` (cover override resolution)
- Create: `router/test/fixtures/events/issue-labeled-needs-plan-with-spec-path.json`

- [ ] **Step 5.1: Find an existing fixture to model the new one on**

Read `router/test/fixtures/events/issue-labeled-needs-plan-no-title.json` (or another `issue-labeled-*` event fixture). Copy its shape, and inject a metadata block with `Shopfloor-Spec-Path: docs/specs/external.md` into `issue.body`.

- [ ] **Step 5.2: Write the failing test**

In `router/test/state.test.ts`, near the existing `needs-plan` coverage:

```ts
test("computeStageFromLabels honors Shopfloor-Spec-Path override on a needs-plan event", () => {
  const decision = resolveStage(
    ctx("issues", "issue-labeled-needs-plan-with-spec-path"),
  );
  expect(decision.stage).toBe("plan");
  expect(decision.specFilePath).toBe("docs/specs/external.md");
  // Plan path remains canonical because no plan override was supplied.
  expect(decision.planFilePath).toMatch(/^docs\/shopfloor\/plans\/\d+-.+\.md$/);
});
```

- [ ] **Step 5.3: Run tests red**

```bash
pnpm test -- state.test
```

- [ ] **Step 5.4: Update `computeStageFromLabels`**

In `router/src/state.ts`, replace the canonical-path construction with calls to `resolveArtifactPaths`. Pseudocode of the change:

```ts
import { resolveArtifactPaths } from "./helpers/resolve-artifact-paths";

function computeStageFromLabels(
  labels: Set<string>,
  issue: { number: number; title: string; body: string | null },
): RouterDecision | null {
  const issueNumber = issue.number;
  const metadata = parseIssueMetadata(issue.body);
  const slug = metadata?.slug ?? branchSlug(issue.title);
  const { specFilePath, planFilePath } = resolveArtifactPaths(
    issueNumber,
    slug,
    metadata,
  );

  if (labels.has("shopfloor:needs-spec")) {
    return {
      stage: "spec",
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/spec/${issueNumber}-${slug}`,
      specFilePath,
    };
  }
  if (labels.has("shopfloor:needs-plan")) {
    return {
      stage: "plan",
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/plan/${issueNumber}-${slug}`,
      specFilePath,
      planFilePath,
    };
  }
  if (labels.has("shopfloor:needs-impl")) {
    return {
      stage: "implement",
      issueNumber,
      complexity: complexityOf(labels),
      branchName: `shopfloor/impl/${issueNumber}-${slug}`,
      specFilePath,
      planFilePath,
    };
  }
  return null;
}
```

NOTE: state.ts must still be I/O-free. `resolveArtifactPaths` is a pure function. Importing it from `./helpers/resolve-artifact-paths` is fine.

NOTE: `resolvePullRequestReviewEvent`'s impl-revision branch (state.ts:467-488) and spec/plan-revision branch (state.ts:497-519) still reconstruct paths from the branch ref. Per the spec, that override is applied later by `build-revision-context` (Task 7). Leave them unchanged in this task.

- [ ] **Step 5.5: Run tests green**

```bash
pnpm test -- state.test
pnpm exec tsc --noEmit
```

- [ ] **Step 5.6: Commit**

```bash
git add router/src/state.ts router/test/state.test.ts router/test/fixtures/events/issue-labeled-needs-plan-with-spec-path.json
git commit -m "refactor(router): route computeStageFromLabels through resolveArtifactPaths"
```

---

## Task 6: New `seed-stage-pr` helper

**Files:**

- Create: `router/src/helpers/seed-stage-pr.ts`
- Test: `router/test/helpers/seed-stage-pr.test.ts`

- [ ] **Step 6.1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { seedStagePr } from "../../src/helpers/seed-stage-pr";
import { makeMockAdapter } from "./_mock-adapter";

describe("seedStagePr", () => {
  test("happy path: get base sha, create branch, write file, open PR", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockResolvedValueOnce({ data: {} });
    bundle.mocks.getContent.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { status: 404 }),
    );
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
    bundle.mocks.createPr.mockResolvedValueOnce({
      data: { number: 7, html_url: "https://x/pr/7" },
    });

    const result = await seedStagePr(bundle.adapter, {
      issueNumber: 42,
      slug: "do-thing",
      stage: "spec",
      content: "# Spec\n\nbody",
      baseBranch: "main",
      prTitle: "Seed spec for #42: Do thing",
      prSummary: "Seeded from issue #42's body during triage.",
    });

    expect(result).toEqual({
      prNumber: 7,
      url: "https://x/pr/7",
      branchName: "shopfloor/spec/42-do-thing",
      filePath: "docs/shopfloor/specs/42-do-thing.md",
    });
    expect(bundle.mocks.createRef).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "refs/heads/shopfloor/spec/42-do-thing",
        sha: "main-sha",
      }),
    );
    expect(bundle.mocks.createOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "docs/shopfloor/specs/42-do-thing.md",
        branch: "shopfloor/spec/42-do-thing",
        content: Buffer.from("# Spec\n\nbody", "utf8").toString("base64"),
      }),
    );
    // No sha key when file did not exist.
    const putCall = bundle.mocks.createOrUpdateFileContents.mock
      .calls[0][0] as { sha?: string };
    expect(putCall.sha).toBeUndefined();
  });

  test("retry: ref-exists 422 + file already at path: passes existing blob sha", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockRejectedValueOnce(
      Object.assign(new Error("Reference already exists"), { status: 422 }),
    );
    bundle.mocks.getContent.mockResolvedValueOnce({
      data: { sha: "blob123", type: "file" },
    });
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
    bundle.mocks.createPr.mockResolvedValueOnce({
      data: { number: 7, html_url: "https://x/pr/7" },
    });

    await seedStagePr(bundle.adapter, {
      issueNumber: 42,
      slug: "do-thing",
      stage: "plan",
      content: "# Plan",
      baseBranch: "main",
      prTitle: "Seed plan for #42",
      prSummary: "summary",
    });

    const putCall = bundle.mocks.createOrUpdateFileContents.mock
      .calls[0][0] as { sha?: string };
    expect(putCall.sha).toBe("blob123");
  });

  test("idempotent: existing PR for the head branch is reused", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockRejectedValueOnce(
      Object.assign(new Error("exists"), { status: 422 }),
    );
    bundle.mocks.getContent.mockResolvedValueOnce({
      data: { sha: "blob", type: "file" },
    });
    bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
    bundle.mocks.listPrs.mockResolvedValueOnce({
      data: [
        {
          number: 99,
          html_url: "https://x/pr/99",
          head: { ref: "shopfloor/spec/42-x" },
        },
      ],
    });

    const result = await seedStagePr(bundle.adapter, {
      issueNumber: 42,
      slug: "x",
      stage: "spec",
      content: "x",
      baseBranch: "main",
      prTitle: "t",
      prSummary: "s",
    });
    expect(result.prNumber).toBe(99);
    expect(bundle.mocks.createPr).not.toHaveBeenCalled();
    // openStagePr refreshes title/body when an existing PR is reused
    // (preserveBodyIfExists is false for stage='spec').
    expect(bundle.mocks.updatePr).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 99 }),
    );
  });

  test("non-422 createRef error rethrows untouched", async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getRef.mockResolvedValueOnce({
      data: { object: { sha: "main-sha" } },
    });
    bundle.mocks.createRef.mockRejectedValueOnce(
      Object.assign(new Error("server error"), { status: 500 }),
    );
    await expect(
      seedStagePr(bundle.adapter, {
        issueNumber: 42,
        slug: "x",
        stage: "spec",
        content: "x",
        baseBranch: "main",
        prTitle: "t",
        prSummary: "s",
      }),
    ).rejects.toThrow("server error");
  });
});
```

- [ ] **Step 6.2: Run tests red**

```bash
pnpm test -- seed-stage-pr.test
```

- [ ] **Step 6.3: Implement the helper**

`router/src/helpers/seed-stage-pr.ts`:

```ts
import type { GitHubAdapter } from "../github";

export interface SeedStagePrParams {
  issueNumber: number;
  slug: string;
  stage: "spec" | "plan";
  content: string;
  baseBranch: string;
  prTitle: string;
  prSummary: string;
}

export interface SeedStagePrResult {
  prNumber: number;
  url: string;
  branchName: string;
  filePath: string;
}

const DIR_FOR_STAGE: Record<SeedStagePrParams["stage"], string> = {
  spec: "docs/shopfloor/specs",
  plan: "docs/shopfloor/plans",
};

export async function seedStagePr(
  adapter: GitHubAdapter,
  params: SeedStagePrParams,
): Promise<SeedStagePrResult> {
  const { issueNumber, slug, stage, content, baseBranch, prTitle, prSummary } =
    params;
  const branchName = `shopfloor/${stage}/${issueNumber}-${slug}`;
  const filePath = `${DIR_FOR_STAGE[stage]}/${issueNumber}-${slug}.md`;

  const baseSha = await adapter.getRefSha(baseBranch);
  const created = await adapter.createRef(branchName, baseSha);

  // If the branch already existed, the file may also already be there.
  // Look up the blob sha; if absent, getFileSha returns null and we omit sha.
  const existingSha = created
    ? null
    : await adapter.getFileSha(filePath, branchName);

  await adapter.putFileContents({
    path: filePath,
    branch: branchName,
    message: `docs(${stage}): seed ${stage} from issue #${issueNumber}`,
    content,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const pr = await adapter.openStagePr({
    base: baseBranch,
    head: branchName,
    title: prTitle,
    body: `${prSummary}\n\nCloses #${issueNumber}`,
    stage,
    issueNumber,
    preserveBodyIfExists: false,
  });

  return {
    prNumber: pr.number,
    url: pr.url,
    branchName,
    filePath,
  };
}
```

NOTE: `openStagePr` already appends the metadata footer (`Shopfloor-Issue:` / `Shopfloor-Stage:`) — see `router/src/github.ts:148-159`. Don't duplicate it in `prSummary`.

- [ ] **Step 6.4: Run tests green and type-check**

```bash
pnpm test -- seed-stage-pr.test
pnpm exec tsc --noEmit
```

- [ ] **Step 6.5: Commit**

```bash
git add router/src/helpers/seed-stage-pr.ts router/test/helpers/seed-stage-pr.test.ts
git commit -m "feat(router): add seed-stage-pr helper for body-supplied artifacts"
```

---

## Task 7: Apply override in `build-revision-context`

**Files:**

- Modify: `router/src/helpers/build-revision-context.ts`
- Modify: `router/test/helpers/build-revision-context.test.ts`

- [ ] **Step 7.1: Read the current revision-context test to find the right insertion points**

```bash
cat router/test/helpers/build-revision-context.test.ts | head -80
```

The existing test stubs `getIssue`, `getPr`, `listPrReviews`, `listPrReviewComments`, `listIssueComments`. The override-application test extends this set by setting an issue body that contains a `Shopfloor-Spec-Path:` metadata block.

- [ ] **Step 7.2: Write the failing test**

Append to `build-revision-context.test.ts`:

```ts
test("applies Shopfloor-Spec-Path override from issue metadata onto impl revision context", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValue({
    data: {
      number: 42,
      title: "issue",
      body: [
        "Body.",
        "<!-- shopfloor:metadata",
        "Shopfloor-Slug: foo",
        "Shopfloor-Spec-Path: docs/specs/external.md",
        "-->",
      ].join("\n"),
      labels: [],
      state: "open",
    },
  });
  bundle.mocks.getPr.mockResolvedValue({
    data: { number: 7, body: "Shopfloor-Review-Iteration: 1" },
  });
  bundle.mocks.listReviews.mockResolvedValue({
    data: [
      {
        id: 1,
        user: { login: "h" },
        body: "fix it",
        commit_id: "c",
        state: "changes_requested",
        submitted_at: "2025-01-01",
      },
    ],
  });
  bundle.mocks.listReviewComments.mockResolvedValue({ data: [] });
  bundle.mocks.listIssueComments.mockResolvedValue({ data: [] });

  // Capture the file write so we can assert path content.
  const tmpFile = `${process.env.RUNNER_TEMP ?? "/tmp"}/ctx-${Date.now()}.json`;
  await buildRevisionContext(bundle.adapter, {
    stage: "implement",
    issueNumber: 42,
    prNumber: 7,
    branchName: "shopfloor/impl/42-foo",
    specFilePath: "docs/shopfloor/specs/42-foo.md",
    planFilePath: "docs/shopfloor/plans/42-foo.md",
    progressCommentId: "1",
    bashAllowlist: "",
    repoOwner: "o",
    repoName: "r",
    outputPath: tmpFile,
    promptFragmentPath: "prompts/implement-revision-fragment.md",
  });

  const written = JSON.parse(readFileSync(tmpFile, "utf8")) as {
    spec_file_path: string;
    plan_file_path: string;
  };
  expect(written.spec_file_path).toBe("docs/specs/external.md");
  expect(written.plan_file_path).toBe("docs/shopfloor/plans/42-foo.md");
});
```

- [ ] **Step 7.3: Run tests red**

```bash
pnpm test -- build-revision-context.test
```

- [ ] **Step 7.4: Apply the override**

In `router/src/helpers/build-revision-context.ts`, immediately after the `const issue = await adapter.getIssue(...)` line, derive effective paths from the override (if any) without rebinding `params`:

```ts
import { parseIssueMetadata, branchSlug } from "../state";
import { resolveArtifactPaths } from "./resolve-artifact-paths";

// ...inside buildRevisionContext, right after fetching the issue:
const metadata = parseIssueMetadata(issue.body ?? null);
const slug = metadata?.slug ?? branchSlug(issue.title);
const resolved = resolveArtifactPaths(params.issueNumber, slug, metadata);
const effectiveSpecPath = metadata?.specPath
  ? resolved.specFilePath
  : params.specFilePath;
const effectivePlanPath = metadata?.planPath
  ? resolved.planFilePath
  : params.planFilePath;
```

Then substitute every existing reference to `params.specFilePath` and `params.planFilePath` inside the function body with `effectiveSpecPath` / `effectivePlanPath` (there are four sites: the `fragmentVars` block, and the `spec`/`plan`/`implement` cases inside the `switch`).

This keeps `params` immutable and makes the override decision explicit at the call site, rather than overwriting input shape state.

- [ ] **Step 7.5: Run tests green and type-check**

```bash
pnpm test -- build-revision-context.test
pnpm exec tsc --noEmit
```

- [ ] **Step 7.6: Commit**

```bash
git add router/src/helpers/build-revision-context.ts router/test/helpers/build-revision-context.test.ts
git commit -m "feat(router): apply spec/plan path override in build-revision-context"
```

---

## Task 8: Extend `apply-triage-decision` input schema (without behavior change)

**Why split this from the matrix work:** Schema parsing is a contained change. Land the parser changes first so the matrix work in Task 9 can focus on routing logic.

**Files:**

- Modify: `router/src/helpers/apply-triage-decision.ts:7-12, 119-138`
- Modify: `router/test/helpers/apply-triage-decision.test.ts`

- [ ] **Step 8.1: Write the failing test**

```ts
test("parses supplied_spec and supplied_plan from decision_json", async () => {
  // Smoke: same decision but with new optional fields. Expect existing
  // behavior unchanged (no seed PR yet — that is Task 9).
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  await applyTriageDecision(bundle.adapter, {
    issueNumber: 42,
    decision: {
      status: "classified",
      complexity: "large",
      rationale: "r",
      clarifying_questions: [],
      // New optional fields parse but Task 8 does not yet use them.
      supplied_spec: null,
      supplied_plan: null,
    } as never,
  });
  // Existing behavior holds.
  const labelCalls = bundle.mocks.addLabels.mock.calls.map(
    (c) => (c[0] as { labels: string[] }).labels,
  );
  expect(labelCalls.flat()).toContain("shopfloor:needs-spec");
});
```

- [ ] **Step 8.2: Run test red**

The above currently passes for the wrong reason — `as never` will accept anything. Change the test to assert the type by removing the cast and updating the `TriageOutput` interface in step 8.3 first; then the test compiles.

- [ ] **Step 8.3: Extend `TriageOutput`**

In `router/src/helpers/apply-triage-decision.ts`:

```ts
interface SuppliedArtifact {
  source: "body" | "path";
  path?: string;
  content?: string;
}

interface TriageOutput {
  status: "classified" | "needs_clarification";
  complexity: "quick" | "medium" | "large";
  rationale: string;
  clarifying_questions: string[];
  supplied_spec?: SuppliedArtifact | null;
  supplied_plan?: SuppliedArtifact | null;
}
```

In `runApplyTriageDecision` after the JSON parse, add validation:

```ts
function validateSupplied(
  label: string,
  supplied: unknown,
): SuppliedArtifact | null {
  if (supplied === undefined || supplied === null) return null;
  const s = supplied as Partial<SuppliedArtifact>;
  if (s.source !== "body" && s.source !== "path") {
    throw new Error(
      `apply-triage-decision: ${label}.source must be 'body' or 'path'`,
    );
  }
  if (s.source === "path" && !s.path) {
    throw new Error(
      `apply-triage-decision: ${label}.path is required when source='path'`,
    );
  }
  if (s.source === "body" && !s.content) {
    throw new Error(
      `apply-triage-decision: ${label}.content is required when source='body'`,
    );
  }
  return { source: s.source, path: s.path, content: s.content };
}

// In runApplyTriageDecision, after the JSON.parse:
decision.supplied_spec = validateSupplied(
  "supplied_spec",
  decision.supplied_spec,
);
decision.supplied_plan = validateSupplied(
  "supplied_plan",
  decision.supplied_plan,
);
```

- [ ] **Step 8.4: Run tests green**

```bash
pnpm test -- apply-triage-decision.test
pnpm exec tsc --noEmit
```

- [ ] **Step 8.5: Commit**

```bash
git add router/src/helpers/apply-triage-decision.ts router/test/helpers/apply-triage-decision.test.ts
git commit -m "feat(router): parse supplied_spec/supplied_plan in triage decision schema"
```

---

## Task 9: `apply-triage-decision` decision matrix

**Why now:** Schema is in place from Task 8, seed helper is ready from Task 6, metadata writer handles new keys from Task 3. This task wires them together.

**Files:**

- Modify: `router/src/helpers/apply-triage-decision.ts:39-114`
- Modify: `router/test/helpers/apply-triage-decision.test.ts`

- [ ] **Step 9.1: Write the failing tests — one per row of the decision matrix**

For each scenario below, write a test in `apply-triage-decision.test.ts`. Use the existing test fixtures as a template.

The matrix (per spec Section 3 of `2026-04-27-flexible-spec-plan-supply-design.md`):

| `supplied_spec` | `supplied_plan` | Expected adapter calls / labels                                                                 |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| null            | null            | Existing behavior. No `seedStagePr`, no path metadata. (Already covered.)                       |
| `path`          | null            | `Shopfloor-Spec-Path: <path>` written via `updateIssueBody`; label flip to `needs-plan`.        |
| null            | `path`          | `Shopfloor-Plan-Path: <path>` written; label flip to `needs-impl`.                              |
| `path` + `path` | (both)          | Both paths written; label flip to `needs-impl`.                                                 |
| `body`          | null            | `seedStagePr` called with stage=spec; label flip to `spec-in-review`.                           |
| null            | `body`          | `seedStagePr` called with stage=plan; label flip to `plan-in-review`.                           |
| `path`          | `body`          | Spec path written + `seedStagePr` for plan; label flip to `plan-in-review`.                     |
| Quick + spec    | (any path)      | Complexity label promoted to `medium`.                                                          |
| `body` + throws | n/a             | Label flip never runs (mock `seedStagePr` to throw; assert no `addLabels` call for state-flip). |

Example test for the spec-path row:

```ts
test("supplied_spec=path: writes spec path metadata, advances to needs-plan", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: [{ name: "shopfloor:triaging" }],
      state: "open",
      title: "Add OAuth",
      body: "Body. Spec at docs/specs/oauth.md.",
    },
  });
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });

  await applyTriageDecision(bundle.adapter, {
    issueNumber: 42,
    decision: {
      status: "classified",
      complexity: "large",
      rationale: "r",
      clarifying_questions: [],
      supplied_spec: { source: "path", path: "docs/specs/oauth.md" },
      supplied_plan: null,
    },
  });

  // Body update includes the spec path
  const updateCall = bundle.mocks.updateIssue.mock.calls[0][0] as {
    body: string;
  };
  expect(updateCall.body).toContain("Shopfloor-Spec-Path: docs/specs/oauth.md");

  // Label flip to needs-plan, not needs-spec
  const labelCalls = bundle.mocks.addLabels.mock.calls.map(
    (c) => (c[0] as { labels: string[] }).labels,
  );
  expect(labelCalls.flat()).toContain("shopfloor:needs-plan");
  expect(labelCalls.flat()).not.toContain("shopfloor:needs-spec");
});
```

Example test for the body-spec row (mocking `seedStagePr` is internal — so we mock the adapter calls it makes):

```ts
test("supplied_spec=body: opens seed spec PR, advances to spec-in-review", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: [{ name: "shopfloor:triaging" }],
      state: "open",
      title: "Add OAuth",
      body: "## Shopfloor Spec\nbody",
    },
  });
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  bundle.mocks.getRef.mockResolvedValueOnce({
    data: { object: { sha: "main-sha" } },
  });
  bundle.mocks.createRef.mockResolvedValueOnce({ data: {} });
  bundle.mocks.getContent.mockRejectedValueOnce(
    Object.assign(new Error("nope"), { status: 404 }),
  );
  bundle.mocks.createOrUpdateFileContents.mockResolvedValueOnce({ data: {} });
  bundle.mocks.listPrs.mockResolvedValueOnce({ data: [] });
  bundle.mocks.createPr.mockResolvedValueOnce({
    data: { number: 7, html_url: "https://x/pr/7" },
  });

  await applyTriageDecision(bundle.adapter, {
    issueNumber: 42,
    decision: {
      status: "classified",
      complexity: "large",
      rationale: "r",
      clarifying_questions: [],
      supplied_spec: { source: "body", content: "# Spec\n\nbody" },
      supplied_plan: null,
    },
  });

  expect(bundle.mocks.createRef).toHaveBeenCalled();
  expect(bundle.mocks.createPr).toHaveBeenCalled();
  const labelCalls = bundle.mocks.addLabels.mock.calls.map(
    (c) => (c[0] as { labels: string[] }).labels,
  );
  expect(labelCalls.flat()).toContain("shopfloor:spec-in-review");
});
```

Test for complexity promotion:

```ts
test("supplied artifact + quick complexity gets promoted to medium", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: [{ name: "shopfloor:triaging" }],
      state: "open",
      title: "x",
      body: "",
    },
  });
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: { labels: [{ name: "shopfloor:triaging" }], state: "open" },
  });
  await applyTriageDecision(bundle.adapter, {
    issueNumber: 42,
    decision: {
      status: "classified",
      complexity: "quick",
      rationale: "r",
      clarifying_questions: [],
      supplied_spec: { source: "path", path: "docs/specs/x.md" },
      supplied_plan: null,
    },
  });
  const labelCalls = bundle.mocks.addLabels.mock.calls.map(
    (c) => (c[0] as { labels: string[] }).labels,
  );
  expect(labelCalls.flat()).toContain("shopfloor:medium");
  expect(labelCalls.flat()).not.toContain("shopfloor:quick");
});
```

Test for failure path:

```ts
test("seedStagePr failure leaves no state-flip labels behind", async () => {
  const bundle = makeMockAdapter();
  bundle.mocks.getIssue.mockResolvedValueOnce({
    data: {
      labels: [{ name: "shopfloor:triaging" }],
      state: "open",
      title: "x",
      body: "",
    },
  });
  bundle.mocks.getRef.mockResolvedValueOnce({
    data: { object: { sha: "main-sha" } },
  });
  bundle.mocks.createRef.mockRejectedValueOnce(
    Object.assign(new Error("server error"), { status: 500 }),
  );

  await expect(
    applyTriageDecision(bundle.adapter, {
      issueNumber: 42,
      decision: {
        status: "classified",
        complexity: "large",
        rationale: "r",
        clarifying_questions: [],
        supplied_spec: { source: "body", content: "# Spec" },
        supplied_plan: null,
      },
    }),
  ).rejects.toThrow("server error");

  // No state-flip labels should have landed.
  const labelCalls = bundle.mocks.addLabels.mock.calls.map(
    (c) => (c[0] as { labels: string[] }).labels,
  );
  expect(labelCalls.flat()).not.toContain("shopfloor:spec-in-review");
});
```

Add tests for the remaining matrix rows (plan-path, both paths, body-plan, spec-path + body-plan) following the same shape.

- [ ] **Step 9.2: Run tests red**

```bash
pnpm test -- apply-triage-decision.test
```

- [ ] **Step 9.3: Implement the matrix**

Replace the routing block at the end of `applyTriageDecision` (currently `router/src/helpers/apply-triage-decision.ts:97-113`) with a decision-matrix implementation. Pseudocode:

```ts
// After UNEXPECTED_TRIAGE_LABELS guard, needs_clarification short-circuit, and slug write.

// Promote quick to medium if any artifact was supplied. implement-quick.md
// does not expect a spec or plan file to exist; the plan-aware implement
// prompt is the right surface for plan-supplied flows.
let effectiveComplexity = decision.complexity;
const anySupplied = decision.supplied_spec || decision.supplied_plan;
if (anySupplied && effectiveComplexity === "quick") {
  effectiveComplexity = "medium";
}

// Persist any supplied paths into the metadata block.
const updates: Record<string, string> = { slug };
if (decision.supplied_spec?.source === "path" && decision.supplied_spec.path) {
  validateOverridePath(decision.supplied_spec.path);
  updates.specPath = decision.supplied_spec.path;
}
if (decision.supplied_plan?.source === "path" && decision.supplied_plan.path) {
  validateOverridePath(decision.supplied_plan.path);
  updates.planPath = decision.supplied_plan.path;
}
const newBody = upsertIssueMetadata(issue.body, updates);
if (newBody !== issue.body) {
  await adapter.updateIssueBody(issueNumber, newBody);
}

// Open seed PR(s) for body content.
let seededStage: "spec" | "plan" | null = null;
if (
  decision.supplied_spec?.source === "body" &&
  decision.supplied_spec.content
) {
  await seedStagePr(adapter, {
    issueNumber,
    slug,
    stage: "spec",
    content: decision.supplied_spec.content,
    baseBranch: "main",
    prTitle: `Seed spec for #${issueNumber}: ${issue.title}`,
    prSummary: `Seeded from issue #${issueNumber}'s body during triage.`,
  });
  seededStage = "spec";
}
if (
  decision.supplied_plan?.source === "body" &&
  decision.supplied_plan.content
) {
  await seedStagePr(adapter, {
    issueNumber,
    slug,
    stage: "plan",
    content: decision.supplied_plan.content,
    baseBranch: "main",
    prTitle: `Seed plan for #${issueNumber}: ${issue.title}`,
    prSummary: `Seeded from issue #${issueNumber}'s body during triage.`,
  });
  seededStage = "plan";
}

// Decide the next state label.
let nextStateLabel: string;
if (seededStage === "spec") {
  nextStateLabel = "shopfloor:spec-in-review";
} else if (seededStage === "plan") {
  nextStateLabel = "shopfloor:plan-in-review";
} else if (
  decision.supplied_plan?.source === "path" ||
  (decision.supplied_spec?.source === "path" &&
    decision.supplied_plan === null) /* and no plan body */
) {
  // Path-only flows: spec-path + plan-path -> needs-impl;
  // plan-path-only -> needs-impl; spec-path-only -> needs-plan.
  if (decision.supplied_plan?.source === "path") {
    nextStateLabel = "shopfloor:needs-impl";
  } else {
    nextStateLabel = "shopfloor:needs-plan";
  }
} else {
  // Default existing flow.
  nextStateLabel = NEXT_STAGE_LABEL[effectiveComplexity];
}

// Comment + advance-state. Comment text reflects what triage chose.
const commentBody = buildClassificationComment({
  complexity: effectiveComplexity,
  promotedFrom: anySupplied && decision.complexity === "quick" ? "quick" : null,
  rationale: decision.rationale,
  suppliedSpec: decision.supplied_spec ?? null,
  suppliedPlan: decision.supplied_plan ?? null,
  nextStateLabel,
});
await adapter.postIssueComment(issueNumber, commentBody);

const fromLabels = ["shopfloor:triaging", "shopfloor:awaiting-info"].filter(
  (l) => current.has(l),
);
await advanceState(adapter, issueNumber, fromLabels, [
  `shopfloor:${effectiveComplexity}`,
  nextStateLabel,
]);
```

Add a small `buildClassificationComment` helper inside the file. The exact wording can match the examples in the spec ("found a spec at X; skipping the spec stage and going straight to plan", etc.).

NOTE: `validateOverridePath` from Task 4 must be imported. Path validation runs at metadata-write time (cheap and explicit). The "exists on main" check is enforced later when the consuming stage tries to read the file.

NOTE: The disallowed-combination cases (spec-body + plan-path; spec-body + plan-body) are caught by the triage agent itself, which emits `needs_clarification`. `apply-triage-decision` does NOT need to re-validate these combinations — if the agent emits both at once, the helper still works correctly: spec body wins because the matrix evaluates spec before plan in the seed-PR section, but this never happens in practice because the agent prompt prevents it.

- [ ] **Step 9.4: Run tests green**

```bash
pnpm test -- apply-triage-decision.test
pnpm exec tsc --noEmit
```

- [ ] **Step 9.5: Commit**

```bash
git add router/src/helpers/apply-triage-decision.ts router/test/helpers/apply-triage-decision.test.ts
git commit -m "feat(router): branch apply-triage-decision on supplied spec/plan artifacts"
```

---

## Task 10: Triage prompt update

**Why last among code-tasks:** The prompt drives the agent; the agent's output drives the helper. Wiring the agent before the helper would crash the pipeline mid-issue.

**Files:**

- Modify: `prompts/triage.md`

- [ ] **Step 10.1: Add the `<artifact_detection>` section**

Insert immediately after the `</classification_rubric>` closing tag:

```
<artifact_detection>
The issue body may already contain or reference a design spec or implementation plan. Detect this so the router can skip stages that have already been done by hand.

Detect a SPEC if any of the following hold (in priority order):

1. The body contains an `## Shopfloor Spec` H2 section. Extract everything under it until the next H2 or end-of-body. (Explicit marker — wins over judgment.)
2. The body contains a line `Shopfloor-Spec-Path: <path>`. Read `<path>` from the repository working tree to confirm it exists and looks like a spec. (Explicit marker.)
3. The body either is, or contains, prose that reads like a design spec — problem statement, goals/non-goals, design decisions, alternatives. Use judgment.
4. The body mentions a path (e.g. `docs/specs/foo.md` in prose or backticks) and that file looks like a spec when you read it.

Apply the same logic to PLAN, with `## Shopfloor Plan` and `Shopfloor-Plan-Path:` markers. A plan looks like phases/tasks/verification steps with concrete commit messages.

Resolution rules:

- Explicit markers (H2 sections, Shopfloor-*-Path:) override judgment.
- If you found a path but the file does not exist on the working tree, return `status: "needs_clarification"` with a single question naming the missing path. Do not also report inline content from the body in that case.
- If both `## Shopfloor Spec` and `## Shopfloor Plan` are inline in the same body, return `status: "needs_clarification"` asking the user to pick one (we do not yet support staged seed PRs across both stages).
- If both an H2 marker AND a path marker are present for the same stage, return `status: "needs_clarification"` asking the user which one to honor.
- If both `Shopfloor-Spec-Path:` and `Shopfloor-Plan-Path:` are present, that is allowed and routes the issue directly to implementation.
- Be conservative: if the body discusses a spec without containing one ("we need a spec for X"), do NOT report a spec.
</artifact_detection>
```

- [ ] **Step 10.2: Extend the output schema documentation**

In the `<output_format>` section, replace the schema block with:

```
{
  "status": "classified" | "needs_clarification",
  "complexity": "quick" | "medium" | "large",
  "rationale": "string — 1-3 sentences explaining the classification and what the next stage should focus on",
  "clarifying_questions": ["string"],
  "supplied_spec": {
    "source": "body" | "path",
    "path": "string — only when source=path; absolute repo-relative path",
    "content": "string — only when source=body; full extracted spec content"
  } | null,
  "supplied_plan": {
    "source": "body" | "path",
    "path": "string — only when source=path",
    "content": "string — only when source=body"
  } | null
}
```

Add a rule under "Rules:":

> - `supplied_spec` and `supplied_plan` default to `null`. Set them only when you detect a supplied artifact per `<artifact_detection>`. When `source` is `path`, omit `content`; when `source` is `body`, omit `path`.

- [ ] **Step 10.3: Add an example covering supplied-spec-path**

Add inside `<examples>`:

```
<example>
<scenario>Issue: "Add OAuth login. The design is at `docs/specs/oauth.md`."</scenario>
<expected_output>
{
  "status": "classified",
  "complexity": "large",
  "rationale": "Large feature with an existing spec at the referenced path. Skip the spec stage and proceed to planning.",
  "clarifying_questions": [],
  "supplied_spec": { "source": "path", "path": "docs/specs/oauth.md" },
  "supplied_plan": null
}
</expected_output>
</example>
```

- [ ] **Step 10.4: Add an example covering supplied-spec-body**

```
<example>
<scenario>Issue body contains an `## Shopfloor Spec` H2 with the full design inline.</scenario>
<expected_output>
{
  "status": "classified",
  "complexity": "large",
  "rationale": "Large feature with the spec authored inline in the issue. The router will open a seed spec PR for review before planning.",
  "clarifying_questions": [],
  "supplied_spec": { "source": "body", "content": "# Auth Spec\n\n## Goals\n..." },
  "supplied_plan": null
}
</expected_output>
</example>
```

- [ ] **Step 10.5: Commit**

```bash
git add prompts/triage.md
git commit -m "feat(prompts): teach triage to detect supplied spec/plan artifacts"
```

---

## Task 11: Build the router dist bundle

**Files:**

- Modify: `router/dist/index.cjs`

- [ ] **Step 11.1: Type-check the whole repo**

```bash
pnpm -r typecheck
```

No errors.

- [ ] **Step 11.2: Run the full test suite**

```bash
pnpm test
```

Everything green.

- [ ] **Step 11.3: Format**

```bash
pnpm format
```

- [ ] **Step 11.4: Build**

```bash
pnpm --filter @shopfloor/router build
```

- [ ] **Step 11.5: Verify the dist actually changed**

```bash
git diff --stat router/dist/index.cjs
```

If the diff is empty, something didn't get wired up. Re-run earlier steps.

- [ ] **Step 11.6: Commit**

```bash
git add router/dist/index.cjs
git commit -m "chore(router): rebuild dist for flexible spec/plan supply"
```

---

## Task 12: End-to-end sanity walkthrough

This task is verification, not implementation. No code changes — read-only.

- [ ] **Step 12.1: Trace one path-supplied flow on paper**

Pick a hypothetical issue: title "Add OAuth", body referencing `docs/specs/oauth.md`. Walk through:

1. Workflow fires triage with `shopfloor:trigger` label.
2. Triage agent reads `docs/specs/oauth.md`, returns `supplied_spec: { source: "path", path: "docs/specs/oauth.md" }`, complexity `large`.
3. `apply-triage-decision` writes `Shopfloor-Spec-Path: docs/specs/oauth.md` to issue metadata, posts a comment, advances labels to `shopfloor:large` + `shopfloor:needs-plan`.
4. Workflow re-fires (labeled `needs-plan`). Router emits stage=plan, `spec_file_path=docs/specs/oauth.md`, `plan_file_path=docs/shopfloor/plans/<N>-<slug>.md`.
5. Plan agent runs, reads the override-path spec, writes the canonical plan file, opens plan PR. Standard flow from here.

Confirm each step lines up with the implementation. If any step looks broken, file a follow-up issue and surface it before declaring the plan complete.

- [ ] **Step 12.2: Trace one body-supplied flow on paper**

Issue with `## Shopfloor Spec` H2.

1. Triage runs, returns `supplied_spec: { source: "body", content: "..." }`.
2. `apply-triage-decision` calls `seedStagePr({ stage: "spec", ... })`. Branch `shopfloor/spec/<N>-<slug>` is created from main; canonical spec file is committed; spec PR is opened with the metadata footer.
3. Issue label flips to `shopfloor:spec-in-review`.
4. Human merges spec PR. `handle-merge` advances issue to `shopfloor:needs-plan`. Standard flow from here.

Confirm: `parsePrMetadata` reads the seed PR's footer correctly (no override-specific code in the PR-event path).

- [ ] **Step 12.3: No commit for this task** — verification only.

---

## Risks and rollback

- **Adapter surface expansion** (Task 1): if any of the new methods diverge from the actual `@octokit/rest` shape at runtime, the seed flow will fail in production with a runtime error and the workflow's `report-failure` step will land `shopfloor:failed:triage`. Recovery: human removes the failed label after fixing the adapter; triage retries against the fresh issue body.
- **Path validation false-rejects** (Task 4): if `validateOverridePath` is too strict (e.g. rejects symlinked-but-valid paths), users see a `failed:triage` label and have to relax their path. Acceptable v1 risk — relaxation is one regex change.
- **Override drift between triage-time and stage-time** (Section 7 of spec): user deletes the override file between triage and plan. Caught by stage-time read; `failed:plan` lands. Documented behavior.
- **Rollback:** every commit in this plan is a single concern. Reverting in reverse order is safe; the dist commit (Task 11) can be reverted alongside the source commits to keep the action functional.
