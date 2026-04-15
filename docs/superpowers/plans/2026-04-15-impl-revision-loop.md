# Implement-stage revision loop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the half-wired implement-stage revision loop so that a `pull_request_review.submitted` with `state: "changes_requested"` on an impl PR triggers a working second impl run that addresses the reviewer's feedback and pushes new commits to the existing branch.

**Architecture:** Four parts. (1) Extend `resolvePullRequestReviewEvent` to populate branch / PR / spec / plan paths from `pr.head.ref`, failing closed if the ref isn't in the canonical `shopfloor/impl/<N>-<slug>` shape. (2) Add three read-only `GitHubAdapter` methods (`listPrReviews`, `listPrReviewComments`, `listIssueComments`). (3) Carve the existing `<review_feedback>` and `<revision_handling>` sections out of `prompts/implement.md` into `prompts/implement-revision-fragment.md`, leaving a single `{{revision_block}}` slot in the parent prompt that collapses to nothing on first runs. (4) Add a new `build-revision-context` router helper that fetches the latest `REQUEST_CHANGES` review's inline comments via the adapter, renders the fragment, and writes a complete impl `context.json`. (5) Fork the workflow's `implement` job on `needs.route.outputs.revision_mode == 'true'` with new branch-checkout and context-build steps that run only on revision and old steps gated to first run.

**Tech Stack:** TypeScript / Node 24, Octokit, `@actions/core`, `@actions/github`, esbuild, Vitest, GitHub Actions YAML, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-04-15-impl-revision-loop-design.md` is the source of truth for design decisions. This plan implements that spec; if the two disagree, the spec wins and this plan should be amended.

**Out of scope (deliberately not in this plan):**

- `aggregate-review` changes
- `apply-impl-postwork` changes
- iteration cap or `review-stuck` behavior changes
- quick-complexity revision support
- review thread resolution (GitHub GraphQL `resolveReviewThread`)
- multi-review history accumulation

---

## File map

**Modified:**

- `router/src/state.ts` — add `parseImplBranchRef` helper, wire into `resolvePullRequestReviewEvent`
- `router/src/types.ts` — extend `OctokitLike` with `pulls.listReviewComments` and `issues.listComments`; add `listReviews` fields the spec needs (`state`, `submitted_at`)
- `router/src/github.ts` — add `listPrReviews`, `listPrReviewComments`, `listIssueComments` methods
- `router/src/index.ts` — register the new helper case
- `router/action.yml` — declare new helper inputs
- `router/test/state.test.ts` — extend the existing revision-mode test, add the unparseable-ref test
- `router/test/helpers/_mock-adapter.ts` — add mocks for the three new endpoints
- `router/test/github.test.ts` — adapter-level tests for the three new methods
- `prompts/implement.md` — remove `<review_feedback>` block, remove `<revision_handling>` section, remove the `Review iteration` line from `<context>`, add a single `{{revision_block}}` slot
- `.github/workflows/shopfloor.yml` — fork the `implement` job on `revision_mode`
- `router/dist/index.cjs` (regenerated) — committed esbuild output

**Created:**

- `router/test/fixtures/events/pr-review-submitted-changes-requested-unparseable-ref.json` — fixture for the fail-closed test
- `prompts/implement-revision-fragment.md` — the explicit revision language the helper renders into the parent context
- `router/src/helpers/build-revision-context.ts` — new helper
- `router/test/helpers/build-revision-context.test.ts` — vitest coverage for the new helper

---

## Conventional Commits sequence

The plan groups work into commits. Each task ends with one commit; tasks land in this order:

1. `feat(state): populate branch and pr metadata for impl revision decision` (Task 1)
2. `feat(github): add listPrReviews, listPrReviewComments, listIssueComments to adapter` (Task 2)
3. `feat(prompts): split impl revision context into fragment file` (Task 3)
4. `feat(router): add build-revision-context helper` (Task 4)
5. `feat(workflow): branch implement job on revision_mode` (Task 5)
6. `chore(router): rebuild dist` (Task 6)

Tests live in the same commit as the code they cover (matches the existing repo convention; see commit `4fd8fe0` which lands feat + tests together).

---

## Task 1: State machine populates revision metadata

**Goal:** `resolvePullRequestReviewEvent` returns `branchName`, `implPrNumber`, `specFilePath`, `planFilePath` for the impl revision decision, and fails closed when `pr.head.ref` doesn't match the canonical pattern.

**Files:**

- Modify: `router/src/state.ts` (function `resolvePullRequestReviewEvent`, near line 386)
- Modify: `router/test/state.test.ts` (extend test at line 73, add new fail-closed test)
- Create: `router/test/fixtures/events/pr-review-submitted-changes-requested-unparseable-ref.json`

**Background reading before starting this task:**

- `router/src/state.ts:386` — current implementation of `resolvePullRequestReviewEvent`
- `router/src/state.ts:97` — existing `branchSlug` function for slug derivation pattern
- `router/test/state.test.ts:73` — the existing terse revision-mode test we're extending
- `router/test/fixtures/events/pr-review-submitted-changes-requested.json` — the existing happy-path fixture (already has `head.ref: "shopfloor/impl/42-github-oauth-login"`)

- [ ] **Step 1.1: Extend the existing happy-path test to assert the new fields**

  Open `router/test/state.test.ts` at line 73. Replace the existing two-line body of `test("changes_requested review on impl PR -> implement (revision mode)")` with:

  ```ts
  test("changes_requested review on impl PR -> implement (revision mode)", () => {
    const decision = resolveStage(
      ctx("pull_request_review", "pr-review-submitted-changes-requested"),
    );
    expect(decision.stage).toBe("implement");
    expect(decision.revisionMode).toBe(true);
    expect(decision.issueNumber).toBe(42);
    expect(decision.implPrNumber).toBe(45);
    expect(decision.branchName).toBe("shopfloor/impl/42-github-oauth-login");
    expect(decision.specFilePath).toBe(
      "docs/shopfloor/specs/42-github-oauth-login.md",
    );
    expect(decision.planFilePath).toBe(
      "docs/shopfloor/plans/42-github-oauth-login.md",
    );
    expect(decision.reason).toBe("human_requested_changes");
  });
  ```

  The existing fixture has `review.user.login: "reviewer-human"` and no `shopfloorBotLogin` is passed in `ctx`, so the reason resolves to `human_requested_changes`. That stays correct.

- [ ] **Step 1.2: Run the test and confirm it fails**

  ```bash
  pnpm --filter @shopfloor/router test -- state.test.ts -t "changes_requested review on impl PR"
  ```

  Expected: FAIL. The current implementation only sets `stage`, `issueNumber`, `revisionMode`, `reviewIteration`, `reason`. The new assertions for `implPrNumber`, `branchName`, `specFilePath`, `planFilePath` will all fail with `undefined`.

- [ ] **Step 1.3: Create the fail-closed fixture**

  Create `router/test/fixtures/events/pr-review-submitted-changes-requested-unparseable-ref.json` with this content (it's a copy of the happy-path fixture with `head.ref` swapped for a manually-renamed branch):

  ```json
  {
    "action": "submitted",
    "review": {
      "state": "changes_requested",
      "body": "Needs changes.",
      "user": { "login": "reviewer-human" }
    },
    "pull_request": {
      "number": 45,
      "body": "Implementation for #42.\n\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: 0\n",
      "state": "open",
      "draft": false,
      "merged": false,
      "head": {
        "ref": "feature/manual-rename",
        "sha": "abcdef0000000000000000000000000000000000"
      },
      "base": {
        "ref": "main",
        "sha": "1234567890abcdef1234567890abcdef12345678"
      },
      "labels": [{ "name": "shopfloor:needs-review" }]
    },
    "repository": {
      "owner": { "login": "niranjan94" },
      "name": "shopfloor"
    }
  }
  ```

- [ ] **Step 1.4: Add the fail-closed test**

  Add immediately after the extended happy-path test in `router/test/state.test.ts`:

  ```ts
  test("changes_requested review on impl PR with unparseable head ref -> none (fail closed)", () => {
    const decision = resolveStage(
      ctx(
        "pull_request_review",
        "pr-review-submitted-changes-requested-unparseable-ref",
      ),
    );
    expect(decision.stage).toBe("none");
    expect(decision.reason).toBe("impl_revision_unparseable_branch_ref");
  });
  ```

- [ ] **Step 1.5: Run the test and confirm it fails**

  ```bash
  pnpm --filter @shopfloor/router test -- state.test.ts -t "unparseable head ref"
  ```

  Expected: FAIL. The current implementation returns `stage: "implement"` regardless of the head ref shape.

- [ ] **Step 1.6: Implement `parseImplBranchRef` in `router/src/state.ts`**

  Add this exported helper near the top of `router/src/state.ts`, just below `branchSlug` (around line 109):

  ```ts
  export interface ParsedImplBranchRef {
    issueNumber: number;
    slug: string;
  }

  // The canonical impl branch shape is `shopfloor/impl/<issueNumber>-<slug>`.
  // The slug is whatever branchSlug() produced at triage time. Returns null if
  // the ref doesn't match the canonical shape, so revision-mode callers can
  // fail closed instead of dispatching a broken impl job.
  export function parseImplBranchRef(ref: string): ParsedImplBranchRef | null {
    const match = ref.match(/^shopfloor\/impl\/(\d+)-(.+)$/);
    if (!match) return null;
    const issueNumber = Number(match[1]);
    const slug = match[2];
    if (!Number.isFinite(issueNumber) || slug.length === 0) return null;
    return { issueNumber, slug };
  }
  ```

  Slug capture is greedy (`(.+)`) intentionally so a slug that contains a literal `-` survives intact. The `^` and `$` anchors prevent partial matches.

- [ ] **Step 1.7: Wire `parseImplBranchRef` into `resolvePullRequestReviewEvent`**

  In `router/src/state.ts`, replace the implement-stage branch of `resolvePullRequestReviewEvent` (around line 409) with:

  ```ts
  if (meta.stage === "implement") {
    const parsed = parseImplBranchRef(pr.head.ref);
    if (!parsed) {
      return {
        stage: "none",
        issueNumber: meta.issueNumber,
        reason: "impl_revision_unparseable_branch_ref",
      };
    }
    return {
      stage: "implement",
      issueNumber: meta.issueNumber,
      revisionMode: true,
      reviewIteration: meta.reviewIteration,
      branchName: pr.head.ref,
      implPrNumber: pr.number,
      specFilePath: `docs/shopfloor/specs/${parsed.issueNumber}-${parsed.slug}.md`,
      planFilePath: `docs/shopfloor/plans/${parsed.issueNumber}-${parsed.slug}.md`,
      reason: isShopfloorReview
        ? "agent_requested_changes"
        : "human_requested_changes",
    };
  }
  ```

  Note that `parsed.issueNumber` is used in the file paths (not `meta.issueNumber`) as a self-consistency check — they should always match because both come from the same PR, but if a future bug introduces drift, this catches it via test failures rather than producing inconsistent paths.

- [ ] **Step 1.8: Run all state tests and confirm they pass**

  ```bash
  pnpm --filter @shopfloor/router test -- state.test.ts
  ```

  Expected: PASS, including the existing 20+ tests and the two new/extended ones.

- [ ] **Step 1.9: Run the full router test suite to catch unintended regressions**

  ```bash
  pnpm --filter @shopfloor/router test
  ```

  Expected: PASS. If any helper test depending on `resolvePullRequestReviewEvent` (e.g. via fixtures) breaks, fix the fixture or test before continuing.

- [ ] **Step 1.10: Type-check**

  ```bash
  pnpm exec tsc --noEmit
  ```

  Expected: No errors. The `RouterDecision` type already has all the fields we're populating.

- [ ] **Step 1.11: Commit**

  ```bash
  git add router/src/state.ts router/test/state.test.ts router/test/fixtures/events/pr-review-submitted-changes-requested-unparseable-ref.json
  git commit -m "$(cat <<'EOF'
  feat(state): populate branch and pr metadata for impl revision decision

  Parse pr.head.ref as shopfloor/impl/<N>-<slug> and populate branchName,
  implPrNumber, specFilePath, planFilePath on the implement-stage revision
  decision. Fail closed with stage=none on an unparseable head ref so the
  workflow does not crash at git checkout -b "".
  EOF
  )"
  ```

---

## Task 2: GitHubAdapter additions for review-comment fetching

**Goal:** Three new read-only adapter methods (`listPrReviews`, `listPrReviewComments`, `listIssueComments`) that return enough information for `build-revision-context` to find the latest `REQUEST_CHANGES` review and its inline comments.

**Files:**

- Modify: `router/src/types.ts` (`OctokitLike` interface)
- Modify: `router/src/github.ts` (`GitHubAdapter` class)
- Modify: `router/test/helpers/_mock-adapter.ts` (extend mock bundle)
- Modify: `router/test/github.test.ts` (new test cases)

**Background reading:**

- `router/src/github.ts:283` — existing `getPrReviewsAtSha` uses `listReviews` already; pattern reference
- `router/src/types.ts:182` — `OctokitLike.pulls` interface
- `router/test/github.test.ts` — adapter test conventions

- [ ] **Step 2.1: Extend the `OctokitLike` interface in `router/src/types.ts`**

  In `router/src/types.ts`, find the `pulls.listReviews` declaration (around line 229). Update it to include the additional fields and add the two new endpoints:

  ```ts
  listReviews(params: {
    owner: string;
    repo: string;
    pull_number: number;
    per_page?: number;
  }): Promise<{
    data: Array<{
      id: number;
      user: unknown;
      body: string | null;
      commit_id: string;
      state: string;
      submitted_at: string | null;
    }>;
  }>;
  listReviewComments(params: {
    owner: string;
    repo: string;
    pull_number: number;
    per_page?: number;
    page?: number;
  }): Promise<{
    data: Array<{
      id: number;
      pull_request_review_id: number | null;
      path: string;
      line: number | null;
      side: "LEFT" | "RIGHT" | null;
      start_line: number | null;
      start_side: "LEFT" | "RIGHT" | null;
      body: string;
    }>;
  }>;
  ```

  Then in the `issues` block of `OctokitLike` (around line 125), add:

  ```ts
  listComments(params: {
    owner: string;
    repo: string;
    issue_number: number;
    per_page?: number;
    page?: number;
  }): Promise<{
    data: Array<{
      user: unknown;
      created_at: string;
      body: string | null;
    }>;
  }>;
  ```

- [ ] **Step 2.2: Extend `_mock-adapter.ts` with the three new endpoints**

  In `router/test/helpers/_mock-adapter.ts`, add to `MockBundle["mocks"]`:

  ```ts
  listReviewComments: ReturnType<typeof vi.fn>;
  listIssueComments: ReturnType<typeof vi.fn>;
  ```

  Add to the `mocks` object inside `makeMockAdapter`:

  ```ts
  listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
  listIssueComments: vi.fn().mockResolvedValue({ data: [] }),
  ```

  Wire them into the `octokit` shape:

  ```ts
  // inside rest.pulls
  listReviewComments: mocks.listReviewComments,
  // inside rest.issues
  listComments: mocks.listIssueComments,
  ```

  Also extend the existing `listReviews` mock's default return to include the new fields the adapter may read:

  ```ts
  listReviews: vi.fn().mockResolvedValue({ data: [] }),
  ```

  (The default empty-array case is already correct; tests that need real data set their own per-call return.)

- [ ] **Step 2.3: Write failing adapter tests**

  In `router/test/github.test.ts`, add three new test cases. Match the file's existing pattern (which I have not seen yet — read the file first if needed before writing). Reasonable shape:

  ```ts
  describe("listPrReviews", () => {
    test("returns reviews with state and submitted_at", async () => {
      const { adapter, mocks } = makeMockAdapter();
      mocks.listReviews.mockResolvedValueOnce({
        data: [
          {
            id: 100,
            user: { login: "reviewer-bot" },
            body: "looks good",
            commit_id: "sha1",
            state: "approved",
            submitted_at: "2026-04-15T10:00:00Z",
          },
          {
            id: 101,
            user: { login: "reviewer-bot" },
            body: "needs changes",
            commit_id: "sha2",
            state: "changes_requested",
            submitted_at: "2026-04-15T11:00:00Z",
          },
        ],
      });
      const reviews = await adapter.listPrReviews(45);
      expect(reviews).toHaveLength(2);
      expect(reviews[1].state).toBe("changes_requested");
      expect(reviews[1].submitted_at).toBe("2026-04-15T11:00:00Z");
      expect(mocks.listReviews).toHaveBeenCalledWith({
        owner: "o",
        repo: "r",
        pull_number: 45,
        per_page: 100,
      });
    });
  });

  describe("listPrReviewComments", () => {
    test("returns review comments with pull_request_review_id", async () => {
      const { adapter, mocks } = makeMockAdapter();
      mocks.listReviewComments.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            pull_request_review_id: 101,
            path: "src/foo.ts",
            line: 42,
            side: "RIGHT",
            start_line: null,
            start_side: null,
            body: "this is wrong",
          },
        ],
      });
      const comments = await adapter.listPrReviewComments(45);
      expect(comments).toHaveLength(1);
      expect(comments[0].pull_request_review_id).toBe(101);
    });
  });

  describe("listIssueComments", () => {
    test("returns issue comments with author and body", async () => {
      const { adapter, mocks } = makeMockAdapter();
      mocks.listIssueComments.mockResolvedValueOnce({
        data: [
          {
            user: { login: "alice" },
            created_at: "2026-04-15T09:00:00Z",
            body: "hello",
          },
        ],
      });
      const comments = await adapter.listIssueComments(42);
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toBe("hello");
    });
  });
  ```

- [ ] **Step 2.4: Run the new tests and confirm they fail**

  ```bash
  pnpm --filter @shopfloor/router test -- github.test.ts -t "listPrReviews"
  pnpm --filter @shopfloor/router test -- github.test.ts -t "listPrReviewComments"
  pnpm --filter @shopfloor/router test -- github.test.ts -t "listIssueComments"
  ```

  Expected: FAIL with "adapter.listPrReviews is not a function" (and similar for the other two).

- [ ] **Step 2.5: Implement the three adapter methods**

  In `router/src/github.ts`, add these methods to the `GitHubAdapter` class (place after `getPrReviewsAtSha` near line 283 to keep review-related methods grouped):

  ```ts
  async listPrReviews(prNumber: number): Promise<
    Array<{
      id: number;
      user: { login: string } | null;
      body: string;
      commit_id: string;
      state: string;
      submitted_at: string | null;
    }>
  > {
    const res = await this.octokit.rest.pulls.listReviews({
      ...this.repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return res.data.map((r) => ({
      id: r.id,
      user: r.user as { login: string } | null,
      body: r.body ?? "",
      commit_id: r.commit_id,
      state: r.state,
      submitted_at: r.submitted_at,
    }));
  }

  async listPrReviewComments(prNumber: number): Promise<
    Array<{
      id: number;
      pull_request_review_id: number | null;
      path: string;
      line: number | null;
      side: "LEFT" | "RIGHT" | null;
      start_line: number | null;
      start_side: "LEFT" | "RIGHT" | null;
      body: string;
    }>
  > {
    const all: Array<{
      id: number;
      pull_request_review_id: number | null;
      path: string;
      line: number | null;
      side: "LEFT" | "RIGHT" | null;
      start_line: number | null;
      start_side: "LEFT" | "RIGHT" | null;
      body: string;
    }> = [];
    let page = 1;
    for (;;) {
      const res = await this.octokit.rest.pulls.listReviewComments({
        ...this.repo,
        pull_number: prNumber,
        per_page: 100,
        page,
      });
      all.push(
        ...res.data.map((c) => ({
          id: c.id,
          pull_request_review_id: c.pull_request_review_id,
          path: c.path,
          line: c.line,
          side: c.side,
          start_line: c.start_line,
          start_side: c.start_side,
          body: c.body,
        })),
      );
      if (res.data.length < 100) break;
      page++;
    }
    return all;
  }

  async listIssueComments(issueNumber: number): Promise<
    Array<{
      user: { login: string } | null;
      created_at: string;
      body: string | null;
    }>
  > {
    const all: Array<{
      user: { login: string } | null;
      created_at: string;
      body: string | null;
    }> = [];
    let page = 1;
    for (;;) {
      const res = await this.octokit.rest.issues.listComments({
        ...this.repo,
        issue_number: issueNumber,
        per_page: 100,
        page,
      });
      all.push(
        ...res.data.map((c) => ({
          user: c.user as { login: string } | null,
          created_at: c.created_at,
          body: c.body,
        })),
      );
      if (res.data.length < 100) break;
      page++;
    }
    return all;
  }
  ```

- [ ] **Step 2.6: Run the new adapter tests and confirm they pass**

  ```bash
  pnpm --filter @shopfloor/router test -- github.test.ts
  ```

  Expected: PASS for all three new tests plus all existing adapter tests.

- [ ] **Step 2.7: Run the full router test suite**

  ```bash
  pnpm --filter @shopfloor/router test
  ```

  Expected: PASS. The OctokitLike type extension may surface compile errors in unrelated test files if they instantiate `OctokitLike` directly without the new fields; resolve by widening the cast or adding the missing fields to the in-test mock objects.

- [ ] **Step 2.8: Type-check**

  ```bash
  pnpm exec tsc --noEmit
  ```

  Expected: No errors.

- [ ] **Step 2.9: Commit**

  ```bash
  git add router/src/types.ts router/src/github.ts router/test/helpers/_mock-adapter.ts router/test/github.test.ts
  git commit -m "$(cat <<'EOF'
  feat(github): add listPrReviews, listPrReviewComments, listIssueComments to adapter

  Three read-only methods used by build-revision-context to find the latest
  REQUEST_CHANGES review on an impl PR and pull its inline comments. All
  three paginate via the existing octokit pattern. No new App permissions
  required.
  EOF
  )"
  ```

---

## Task 3: Restructure the impl prompt

**Goal:** Remove conditional language from `prompts/implement.md` so the agent never reads "if non-empty then this is a revision". The first-run prompt has zero revision wording. The revision fragment is a separate file with explicit, unconditional language.

**Files:**

- Modify: `prompts/implement.md`
- Create: `prompts/implement-revision-fragment.md`

**Background reading:**

- `prompts/implement.md` — entire file (95 lines)

- [ ] **Step 3.1: Edit `prompts/implement.md`**

  Make four changes:
  1. In the `<context>` block, delete the line `Review iteration: {{iteration_count}}`.
  2. In the `<context>` block, delete the entire `<review_feedback>` sub-block:
     ```
     <review_feedback>
     {{review_comments_json}}
     </review_feedback>
     ```
  3. Delete the entire `<revision_handling>` section (the section that begins `If <review_feedback> is non-empty, this is a revision run...`).
  4. Add a single line at the very end of the `<context>` block, immediately before its closing `</context>` tag:
     ```
     {{revision_block}}
     ```

  After these edits, the `<context>` block ends with `{{revision_block}}` on its own line. On first runs, `revision_block` is the empty string and the line collapses; on revision runs, `revision_block` carries the rendered fragment from Task 4.

- [ ] **Step 3.2: Create `prompts/implement-revision-fragment.md`**

  ```markdown
  <revision_run>
  THIS IS A REVISION RUN. You are iterating on an existing impl PR that the
  Shopfloor review system flagged. This is iteration {{iteration_count}} of
  the review loop. Your job is to address the review comments below by adding
  new commits on top of the existing branch. Do NOT squash, amend, or rebase.
  Each fix gets its own Conventional Commits commit. The commit message MUST
  reference the comment it resolves (path:line and a short verbatim excerpt
  of the comment body). Commit the fix, update the progress checklist, then
  move on to the next comment. Process every comment in order; do not stop
  early.
  </revision_run>

  <review_feedback>
  {{review_comments_json}}
  </review_feedback>
  ```

  No conditionals, no "if non-empty" language. The fragment is rendered only on revision runs and unconditionally tells the agent what to do.

- [ ] **Step 3.3: Sanity-check the prompt template syntax**

  ```bash
  grep -n "{{" prompts/implement.md
  grep -n "{{" prompts/implement-revision-fragment.md
  ```

  Expected output for `implement.md`: every `{{key}}` matches a context field that the workflow's existing first-run context builder produces (`branch_name`, `progress_comment_id`, `issue_body`, `spec_source`, `plan_file_contents`, `repo_owner`, `repo_name`, `bash_allowlist`, `revision_block`, etc.). The line-by-line reading is to make sure no `{{review_comments_json}}` or `{{iteration_count}}` survives in the parent prompt — both should now live only in the fragment.

  Expected output for the fragment: `{{iteration_count}}` and `{{review_comments_json}}` only.

- [ ] **Step 3.4: Run prompt-render tests to make sure no snapshots regress**

  ```bash
  pnpm --filter @shopfloor/router test -- prompt-render.test.ts
  ```

  Expected: PASS. If a snapshot exists for the implement prompt, this step may surface a snapshot mismatch — update the snapshot in place after manually verifying the new rendering matches expectations.

- [ ] **Step 3.5: Commit**

  ```bash
  git add prompts/implement.md prompts/implement-revision-fragment.md
  git commit -m "$(cat <<'EOF'
  feat(prompts): split impl revision context into fragment file

  The implement prompt previously asked the agent to interpret 'if
  review_feedback is non-empty, this is a revision run'. Replace that
  conditional with a clean split: implement.md drops the review_feedback
  block entirely and adds a {{revision_block}} slot that is empty on first
  runs. implement-revision-fragment.md is rendered by build-revision-context
  on revision runs and contains explicit, unconditional revision language.
  EOF
  )"
  ```

---

## Task 4: build-revision-context helper

**Goal:** A new router helper that fetches the issue, reviews, and review comments for an impl PR in revision mode, renders the prompt fragment, and writes a complete impl `context.json` to a temp path.

**Files:**

- Create: `router/src/helpers/build-revision-context.ts`
- Create: `router/test/helpers/build-revision-context.test.ts`
- Modify: `router/src/index.ts` (register the helper case)
- Modify: `router/action.yml` (declare new inputs)

**Background reading:**

- `router/src/helpers/render-prompt.ts` — uses `renderPrompt` and `resolvePromptFile`; the new helper imports both
- `router/src/prompt-render.ts` — the `renderPrompt(filePath, context)` function we'll reuse
- `router/src/helpers/aggregate-review.ts:84` — `parseIterationFromBody` is a pure function we can copy verbatim (or import if we lift it to a shared module; copy for simplicity in this task)
- `router/src/helpers/apply-impl-postwork.ts:19` — same `parseIterationFromBody` lives here too; keeping this third copy for the new helper is acceptable (4 lines of code, no real duplication cost)
- `router/test/helpers/_mock-adapter.ts` — mock adapter pattern for the new tests
- `.github/workflows/shopfloor.yml:803` — the existing first-run context builder's jq invocation; the helper produces the same JSON shape plus a `revision_block` field

- [ ] **Step 4.1: Write failing test scaffold for the helper**

  Create `router/test/helpers/build-revision-context.test.ts`:

  ```ts
  import { describe, expect, test, beforeEach, afterEach } from "vitest";
  import {
    mkdtempSync,
    rmSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
  } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { makeMockAdapter } from "./_mock-adapter";
  import { buildRevisionContext } from "../../src/helpers/build-revision-context";

  describe("buildRevisionContext", () => {
    let tempDir: string;
    let outputPath: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "build-rev-ctx-"));
      outputPath = join(tempDir, "context.json");
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    test("happy path: writes context with filtered comments and rendered fragment", async () => {
      const { adapter, mocks } = makeMockAdapter();
      mocks.getIssue.mockResolvedValueOnce({
        data: {
          labels: [],
          state: "open",
          title: "Add OAuth login",
          body: "We need OAuth.",
        },
      });
      mocks.getPr.mockResolvedValueOnce({
        data: {
          state: "open",
          draft: false,
          merged: false,
          labels: [],
          head: { sha: "headsha" },
          body: "PR body\n\nShopfloor-Review-Iteration: 2",
        },
      });
      mocks.listReviews.mockResolvedValueOnce({
        data: [
          {
            id: 100,
            user: { login: "reviewer-bot" },
            body: "first",
            commit_id: "sha1",
            state: "commented",
            submitted_at: "2026-04-15T10:00:00Z",
          },
          {
            id: 101,
            user: { login: "reviewer-bot" },
            body: "needs changes",
            commit_id: "sha2",
            state: "changes_requested",
            submitted_at: "2026-04-15T11:00:00Z",
          },
        ],
      });
      mocks.listReviewComments.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            pull_request_review_id: 99, // older review, must be filtered out
            path: "src/old.ts",
            line: 1,
            side: "RIGHT",
            start_line: null,
            start_side: null,
            body: "stale",
          },
          {
            id: 2,
            pull_request_review_id: 101,
            path: "src/foo.ts",
            line: 42,
            side: "RIGHT",
            start_line: null,
            start_side: null,
            body: "fix this",
          },
          {
            id: 3,
            pull_request_review_id: 101,
            path: "src/bar.ts",
            line: 10,
            side: "RIGHT",
            start_line: null,
            start_side: null,
            body: "and this",
          },
        ],
      });
      mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

      await buildRevisionContext(adapter, {
        issueNumber: 42,
        prNumber: 45,
        branchName: "shopfloor/impl/42-add-oauth",
        specFilePath: "docs/shopfloor/specs/42-add-oauth.md",
        planFilePath: "docs/shopfloor/plans/42-add-oauth.md",
        progressCommentId: "999",
        bashAllowlist: "pnpm test",
        repoOwner: "o",
        repoName: "r",
        outputPath,
        promptFragmentPath: "prompts/implement-revision-fragment.md",
      });

      const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
        string,
        string
      >;
      expect(written.issue_number).toBe("42");
      expect(written.issue_title).toBe("Add OAuth login");
      expect(written.issue_body).toBe("We need OAuth.");
      expect(written.branch_name).toBe("shopfloor/impl/42-add-oauth");
      expect(written.iteration_count).toBe("2");

      const reviewComments = JSON.parse(written.review_comments_json) as Array<{
        path: string;
      }>;
      expect(reviewComments).toHaveLength(2);
      expect(reviewComments.map((c) => c.path).sort()).toEqual([
        "src/bar.ts",
        "src/foo.ts",
      ]);

      // The rendered fragment should contain the literal "REVISION RUN"
      // marker and the iteration count substituted in.
      expect(written.revision_block).toContain("THIS IS A REVISION RUN");
      expect(written.revision_block).toContain("iteration 2");
      expect(written.revision_block).toContain("src/foo.ts");
    });

    test("throws when no REQUEST_CHANGES review is found", async () => {
      const { adapter, mocks } = makeMockAdapter();
      mocks.getIssue.mockResolvedValueOnce({
        data: { labels: [], state: "open", title: "t", body: "b" },
      });
      mocks.getPr.mockResolvedValueOnce({
        data: {
          state: "open",
          draft: false,
          merged: false,
          labels: [],
          head: { sha: "x" },
          body: "Shopfloor-Review-Iteration: 1",
        },
      });
      mocks.listReviews.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            user: { login: "x" },
            body: "",
            commit_id: "x",
            state: "approved",
            submitted_at: null,
          },
        ],
      });

      await expect(
        buildRevisionContext(adapter, {
          issueNumber: 42,
          prNumber: 45,
          branchName: "shopfloor/impl/42-x",
          specFilePath: "docs/shopfloor/specs/42-x.md",
          planFilePath: "docs/shopfloor/plans/42-x.md",
          progressCommentId: "0",
          bashAllowlist: "",
          repoOwner: "o",
          repoName: "r",
          outputPath,
          promptFragmentPath: "prompts/implement-revision-fragment.md",
        }),
      ).rejects.toThrow(/no REQUEST_CHANGES review/);
    });

    test("composes spec_source from filesystem when spec file exists", async () => {
      const { adapter, mocks } = makeMockAdapter();
      const specDir = join(tempDir, "docs/shopfloor/specs");
      mkdirSync(specDir, { recursive: true });
      const specPath = join(specDir, "42-add-oauth.md");
      writeFileSync(specPath, "# Spec content");

      mocks.getIssue.mockResolvedValueOnce({
        data: { labels: [], state: "open", title: "t", body: "b" },
      });
      mocks.getPr.mockResolvedValueOnce({
        data: {
          state: "open",
          draft: false,
          merged: false,
          labels: [],
          head: { sha: "x" },
          body: "Shopfloor-Review-Iteration: 1",
        },
      });
      mocks.listReviews.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            user: { login: "x" },
            body: "",
            commit_id: "x",
            state: "changes_requested",
            submitted_at: null,
          },
        ],
      });
      mocks.listReviewComments.mockResolvedValueOnce({ data: [] });
      mocks.listIssueComments.mockResolvedValueOnce({ data: [] });

      await buildRevisionContext(adapter, {
        issueNumber: 42,
        prNumber: 45,
        branchName: "shopfloor/impl/42-add-oauth",
        specFilePath: specPath,
        planFilePath: join(tempDir, "no-plan.md"),
        progressCommentId: "0",
        bashAllowlist: "",
        repoOwner: "o",
        repoName: "r",
        outputPath,
        promptFragmentPath: "prompts/implement-revision-fragment.md",
      });

      const written = JSON.parse(readFileSync(outputPath, "utf-8")) as Record<
        string,
        string
      >;
      expect(written.spec_source).toContain("<spec_file_contents>");
      expect(written.spec_source).toContain("# Spec content");
      expect(written.plan_file_contents).toBe("");
    });
  });
  ```

- [ ] **Step 4.2: Run the tests and confirm they fail**

  ```bash
  pnpm --filter @shopfloor/router test -- build-revision-context.test.ts
  ```

  Expected: FAIL with module-not-found for `../../src/helpers/build-revision-context`.

- [ ] **Step 4.3: Create the helper `router/src/helpers/build-revision-context.ts`**

  ```ts
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  import * as core from "@actions/core";
  import type { GitHubAdapter } from "../github";
  import { renderPrompt } from "../prompt-render";
  import { resolvePromptFile } from "./render-prompt";

  export interface BuildRevisionContextParams {
    issueNumber: number;
    prNumber: number;
    branchName: string;
    specFilePath: string;
    planFilePath: string;
    progressCommentId: string;
    bashAllowlist: string;
    repoOwner: string;
    repoName: string;
    outputPath: string;
    promptFragmentPath: string;
  }

  function parseIterationFromBody(body: string | null): number {
    if (!body) return 0;
    const m = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  function composeSpecSource(specFilePath: string): string {
    if (existsSync(specFilePath)) {
      const contents = readFileSync(specFilePath, "utf-8");
      return `<spec_file_contents>\n${contents}\n</spec_file_contents>`;
    }
    return `<spec_source>\nThere is no spec for this issue. This is the medium-complexity flow, which skips the spec stage by design. The <plan_file_contents> below is your sole source of truth for the design.\n</spec_source>`;
  }

  function readPlanContents(planFilePath: string): string {
    if (!existsSync(planFilePath)) return "";
    return readFileSync(planFilePath, "utf-8");
  }

  function formatIssueComments(
    comments: Array<{
      user: { login: string } | null;
      created_at: string;
      body: string | null;
    }>,
  ): string {
    if (comments.length === 0) return "";
    return comments
      .map(
        (c) =>
          `**@${c.user?.login ?? "unknown"}** (${c.created_at}):\n${c.body ?? ""}`,
      )
      .join("\n\n---\n\n");
  }

  export async function buildRevisionContext(
    adapter: GitHubAdapter,
    params: BuildRevisionContextParams,
  ): Promise<void> {
    const issue = await adapter.getIssue(params.issueNumber);
    const pr = await adapter.getPr(params.prNumber);
    const reviews = await adapter.listPrReviews(params.prNumber);

    const requestChangesReviews = reviews
      .filter((r) => r.state === "changes_requested")
      .sort((a, b) => {
        const aTime = a.submitted_at ?? "";
        const bTime = b.submitted_at ?? "";
        return bTime.localeCompare(aTime);
      });

    if (requestChangesReviews.length === 0) {
      throw new Error(
        `build-revision-context: PR #${params.prNumber} has no REQUEST_CHANGES review. The router decided this was a revision run but the review system has nothing for the agent to address. This indicates a wiring bug between aggregate-review and the impl job.`,
      );
    }

    const latest = requestChangesReviews[0];

    const allReviewComments = await adapter.listPrReviewComments(
      params.prNumber,
    );
    const filtered = allReviewComments
      .filter((c) => c.pull_request_review_id === latest.id)
      .map((c) => ({
        path: c.path,
        line: c.line,
        side: c.side,
        start_line: c.start_line,
        start_side: c.start_side,
        body: c.body,
      }));

    let issueComments = "";
    try {
      const fetched = await adapter.listIssueComments(params.issueNumber);
      issueComments = formatIssueComments(fetched);
    } catch (err) {
      core.warning(
        `build-revision-context: failed to fetch issue comments for #${params.issueNumber}, falling back to empty: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const iterationCount = parseIterationFromBody(pr.body);
    const reviewCommentsJson = JSON.stringify(filtered);

    const fragmentPath = resolvePromptFile(params.promptFragmentPath);
    const revisionBlock = renderPrompt(fragmentPath, {
      iteration_count: String(iterationCount),
      review_comments_json: reviewCommentsJson,
    });

    const specSource = composeSpecSource(params.specFilePath);
    const planFileContents = readPlanContents(params.planFilePath);

    const context: Record<string, string> = {
      issue_number: String(params.issueNumber),
      issue_title: issue.title,
      issue_body: issue.body ?? "",
      issue_comments: issueComments,
      spec_source: specSource,
      plan_file_contents: planFileContents,
      branch_name: params.branchName,
      progress_comment_id: params.progressCommentId,
      review_comments_json: reviewCommentsJson,
      iteration_count: String(iterationCount),
      bash_allowlist: params.bashAllowlist,
      repo_owner: params.repoOwner,
      repo_name: params.repoName,
      revision_block: revisionBlock,
    };

    writeFileSync(params.outputPath, JSON.stringify(context));
    core.setOutput("path", params.outputPath);
  }

  export async function runBuildRevisionContext(
    adapter: GitHubAdapter,
  ): Promise<void> {
    await buildRevisionContext(adapter, {
      issueNumber: Number(core.getInput("issue_number", { required: true })),
      prNumber: Number(core.getInput("pr_number", { required: true })),
      branchName: core.getInput("branch_name", { required: true }),
      specFilePath: core.getInput("spec_file_path", { required: true }),
      planFilePath: core.getInput("plan_file_path", { required: true }),
      progressCommentId: core.getInput("progress_comment_id") || "",
      bashAllowlist: core.getInput("bash_allowlist") || "",
      repoOwner: core.getInput("repo_owner", { required: true }),
      repoName: core.getInput("repo_name", { required: true }),
      outputPath: core.getInput("output_path", { required: true }),
      promptFragmentPath:
        core.getInput("prompt_fragment_path") ||
        "prompts/implement-revision-fragment.md",
    });
  }
  ```

  Notes:
  - The fragment path defaults to `prompts/implement-revision-fragment.md`. The workflow can override via input but normally won't.
  - `review_comments_json` is duplicated into both the top-level context AND the rendered fragment. The top-level copy is harmless (it's not referenced in the parent prompt anymore) but kept for backward compatibility with any test fixtures or scripts that read context.json directly. Remove the top-level copy in a future cleanup if it bothers you.
  - Issue comments fetch failure is soft (warning + empty), matching the existing inline jq behavior in the workflow.

- [ ] **Step 4.4: Run the tests and iterate until they pass**

  ```bash
  pnpm --filter @shopfloor/router test -- build-revision-context.test.ts
  ```

  Expected: PASS for all three tests. The "spec from filesystem" test passes a real path under `tempDir`; the helper reads it via `existsSync` + `readFileSync`. The fragment path test references the real `prompts/implement-revision-fragment.md` from the repo root, so this test must be run with the repo root as cwd (vitest default).

- [ ] **Step 4.5: Register the helper in `router/src/index.ts`**

  Add the import alongside the others:

  ```ts
  import { runBuildRevisionContext } from "./helpers/build-revision-context";
  ```

  Add the case in the `switch (helper)` block:

  ```ts
  case "build-revision-context":
    return runBuildRevisionContext(adapter);
  ```

- [ ] **Step 4.6: Declare the new inputs in `router/action.yml`**

  Update the `helper` description to include `build-revision-context` in its allowed-values list.

  Add the new inputs in the appropriate section (group with `# render-prompt inputs` is fine, or add a new comment block):

  ```yaml
  # build-revision-context inputs
  spec_file_path:
    description: "For build-revision-context: spec file path to compose into spec_source"
    required: false
  plan_file_path:
    description: "For build-revision-context: plan file path to read into plan_file_contents"
    required: false
  progress_comment_id:
    description: "For build-revision-context: progress comment id to thread through to the agent"
    required: false
  bash_allowlist:
    description: "For build-revision-context: bash allowlist to pass to the agent"
    required: false
  repo_owner:
    description: "For build-revision-context: repository owner login"
    required: false
  repo_name:
    description: "For build-revision-context: repository name"
    required: false
  output_path:
    description: "For build-revision-context: absolute path to write the resulting context.json"
    required: false
  prompt_fragment_path:
    description: "For build-revision-context: path to the prompt fragment template (defaults to prompts/implement-revision-fragment.md)"
    required: false
  ```

- [ ] **Step 4.7: Run the full router test suite**

  ```bash
  pnpm --filter @shopfloor/router test
  ```

  Expected: PASS.

- [ ] **Step 4.8: Type-check**

  ```bash
  pnpm exec tsc --noEmit
  ```

  Expected: No errors.

- [ ] **Step 4.9: Commit**

  ```bash
  git add router/src/helpers/build-revision-context.ts router/test/helpers/build-revision-context.test.ts router/src/index.ts router/action.yml
  git commit -m "$(cat <<'EOF'
  feat(router): add build-revision-context helper

  New helper composes the impl context.json for revision runs by fetching
  the issue, the latest REQUEST_CHANGES review, and that review's inline
  comments via GitHubAdapter, then renders the implement-revision-fragment
  prompt and stuffs the rendered text into the parent context as
  revision_block. Throws when no REQUEST_CHANGES review is found, signalling
  a wiring bug worth surfacing loudly.
  EOF
  )"
  ```

---

## Task 5: Workflow forks the implement job on revision_mode

**Goal:** The `implement` job in `.github/workflows/shopfloor.yml` runs different branch-checkout, PR-resolution, and context-build steps depending on `needs.route.outputs.revision_mode`. All shared steps (token mints, precheck, mark-implementing, MCP config, render-prompt, agent call, post-agent token, push, finalize-progress, apply-impl-postwork, report-failure) run unchanged.

**Files:**

- Modify: `.github/workflows/shopfloor.yml` (impl job, lines ~645-970)

**Background reading:**

- `.github/workflows/shopfloor.yml:645` — start of impl job
- `.github/workflows/shopfloor.yml:710` — current `Create impl branch` step (the one that crashes)
- `.github/workflows/shopfloor.yml:727` — `open_pr` step
- `.github/workflows/shopfloor.yml:787` — current inline jq context builder
- `.github/workflows/shopfloor.yml:912` — `Push impl commits`
- `.github/workflows/shopfloor.yml:924` — `Mark impl PR ready for review`

**Key constraint:** GitHub Actions disallows two steps with the same `id` in the same job. The current `Open draft impl PR` step has `id: open_pr` and many downstream steps reference `steps.open_pr.outputs.pr_number`. The fork below resolves this by leaving the existing step's id intact, gating it on `revision_mode != 'true'`, and adding a small "Resolve impl PR number" step that runs only on revision and re-emits the route output as a step output with id `open_pr_revision`. Downstream consumers reference `steps.open_pr.outputs.pr_number || steps.open_pr_revision.outputs.pr_number` via a small env var indirection — see step 5.5 for the exact pattern.

- [ ] **Step 5.1: Gate the existing `Create impl branch` step on first-run only**

  At the existing step (around line 710), add the revision-mode condition:

  ```yaml
  - name: Create impl branch
    if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true'
    run: |
      ...existing body...
  ```

  Do not change the body. The body is correct for first runs.

- [ ] **Step 5.2: Add a new `Checkout existing impl branch` step for revision runs**

  Insert this step immediately after the gated `Create impl branch` step:

  ```yaml
  - name: Checkout existing impl branch
    if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode == 'true'
    env:
      BRANCH_NAME: ${{ needs.route.outputs.branch_name }}
    run: |
      git config user.name "github-actions[bot]"
      git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
      git fetch origin "${BRANCH_NAME}":"${BRANCH_NAME}"
      git checkout "${BRANCH_NAME}"
  ```

  Notes:
  - No `git checkout -b`. The branch already exists on the remote.
  - `git fetch origin <name>:<name>` creates the local ref pointing at the remote tip.
  - The `actions/checkout` step at the top of the impl job is shallow by default, but `git fetch` here pulls the impl branch tip without needing full history. If a future change needs full history on the impl branch (e.g. for `git log` walking), set `fetch-depth: 0` on the top-level checkout step. Not needed for v0.1.

- [ ] **Step 5.3: Gate the existing `open_pr` step on first-run only**

  At the existing step (around line 727), add the revision-mode condition:

  ```yaml
  - id: open_pr
    if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true'
    uses: ./router
    with:
      helper: open-stage-pr
      ...
  ```

  Do not change anything else.

- [ ] **Step 5.4: Add a `Resolve existing impl PR number` step for revision runs**

  Insert this step immediately after the gated `open_pr` step:

  ```yaml
  - name: Resolve existing impl PR number
    id: open_pr_revision
    if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode == 'true'
    env:
      PR_NUMBER: ${{ needs.route.outputs.impl_pr_number }}
    run: |
      echo "pr_number=${PR_NUMBER}" >> "$GITHUB_OUTPUT"
  ```

  This produces a step output `steps.open_pr_revision.outputs.pr_number` that mirrors the route output, so downstream steps can reference one of two ids depending on path.

- [ ] **Step 5.5: Add a unified PR number resolver step**

  Some downstream steps (`create-progress-comment`, `Mark impl PR ready for review`, `apply-impl-postwork`, the MCP config writer, `report-failure`) need a single canonical `pr_number` regardless of which id provided it. Add a tiny aggregator step right after `Resolve existing impl PR number`:

  ```yaml
  - name: Resolve unified impl PR number
    id: pr
    if: steps.precheck.outputs.skip != 'true'
    env:
      FROM_FIRST_RUN: ${{ steps.open_pr.outputs.pr_number }}
      FROM_REVISION: ${{ steps.open_pr_revision.outputs.pr_number }}
    run: |
      if [ -n "$FROM_FIRST_RUN" ]; then
        echo "pr_number=$FROM_FIRST_RUN" >> "$GITHUB_OUTPUT"
      else
        echo "pr_number=$FROM_REVISION" >> "$GITHUB_OUTPUT"
      fi
  ```

  Then replace EVERY downstream `${{ steps.open_pr.outputs.pr_number }}` reference in the impl job with `${{ steps.pr.outputs.pr_number }}`. Specifically:
  - `create-progress-comment` step (around line 752)
  - The MCP config writer's `SHOPFLOOR_COMMENT_ID` interpolation (uses progress, not pr; leave alone)
  - `Mark impl PR ready for review` step's `PR_NUMBER` env (around line 928)
  - `apply-impl-postwork` step's `pr_number` input (around line 947)
  - `report-failure` step's `target_pr_number` (around line 970)
  - The job-level `outputs.pr_number` mapping (line 660): change to `${{ steps.pr.outputs.pr_number }}`

  Use search-and-replace with care; only the impl job's references should change. Other jobs (spec, plan) have their own `open_pr` references that must stay as-is.

- [ ] **Step 5.6: Gate the existing `Build implement context` step on first-run only**

  At the existing step (around line 787), add the revision-mode condition:

  ```yaml
  - name: Build implement context
    if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true'
    id: ctx
    ...existing body...
  ```

- [ ] **Step 5.7: Add a `Build revision context` step for revision runs**

  Insert this step immediately after the gated `Build implement context` step. It uses `id: ctx` as well, but only one of the two will run (mutually exclusive `if:` gates), so GitHub Actions accepts the duplicate-only-by-name id at runtime — wait, no. **GitHub Actions does NOT allow duplicate step ids in the same job, even if their `if:` gates are mutually exclusive.** Use a different id and a follow-up resolver, same pattern as step 5.5:

  ```yaml
  - name: Build revision context
    id: ctx_revision
    if: steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode == 'true'
    uses: ./router
    with:
      helper: build-revision-context
      github_token: ${{ steps.app_token_pre.outputs.token || secrets.GITHUB_TOKEN }}
      issue_number: ${{ needs.route.outputs.issue_number }}
      pr_number: ${{ needs.route.outputs.impl_pr_number }}
      branch_name: ${{ needs.route.outputs.branch_name }}
      spec_file_path: ${{ needs.route.outputs.spec_file_path }}
      plan_file_path: ${{ needs.route.outputs.plan_file_path }}
      progress_comment_id: ${{ steps.progress.outputs.comment_id }}
      bash_allowlist: ${{ inputs.impl_bash_allowlist }}
      repo_owner: ${{ github.repository_owner }}
      repo_name: ${{ github.event.repository.name }}
      output_path: ${{ runner.temp }}/context.json
  ```

  Then add an aggregator step right after, mirroring step 5.5:

  ```yaml
  - name: Resolve unified context path
    id: ctx_path
    if: steps.precheck.outputs.skip != 'true'
    env:
      FROM_FIRST_RUN: ${{ steps.ctx.outputs.path }}
      FROM_REVISION: ${{ steps.ctx_revision.outputs.path }}
    run: |
      if [ -n "$FROM_FIRST_RUN" ]; then
        echo "path=$FROM_FIRST_RUN" >> "$GITHUB_OUTPUT"
      else
        echo "path=$FROM_REVISION" >> "$GITHUB_OUTPUT"
      fi
  ```

  Then update the `Render implement prompt` step's `context_file` input from `${{ steps.ctx.outputs.path }}` to `${{ steps.ctx_path.outputs.path }}` (around line 867).

  **Reality check on `build-revision-context`'s output:** the helper writes `output_path` to `core.setOutput("path", params.outputPath)` (see helper code in Task 4 step 4.3). So `steps.ctx_revision.outputs.path` will be the same string as the `output_path` input. The aggregator above is technically a noop in revision mode, but keeping it parallel to the first-run path makes the YAML symmetric and easier to read.

- [ ] **Step 5.8: The progress comment step gets a fresh comment per impl run for both paths**

  No change needed. The existing `create-progress-comment` step (`id: progress`) at line 746 runs for both first runs and revisions; both get a fresh comment. Verify the step has no `revision_mode` gate — it should not.

  Also verify the step references `steps.pr.outputs.pr_number` after step 5.5's search-and-replace.

- [ ] **Step 5.9: Gate the `Mark impl PR ready for review` step on first-run only**

  At the existing step (around line 924), add the revision-mode condition:

  ```yaml
  - name: Mark impl PR ready for review
    if: ${{ success() && steps.app_token_post.outputs.token != '' && steps.precheck.outputs.skip != 'true' && needs.route.outputs.revision_mode != 'true' }}
    env:
      GH_TOKEN: ${{ steps.app_token_post.outputs.token }}
      PR_NUMBER: ${{ steps.pr.outputs.pr_number }}
      REPO_SLUG: ${{ github.repository }}
    run: gh pr ready "$PR_NUMBER" --repo "$REPO_SLUG"
  ```

  Note `PR_NUMBER` now references the unified `steps.pr.outputs.pr_number`.

- [ ] **Step 5.10: Verify push step needs no force flag for either path**

  The existing `Push impl commits` step (around line 912) is `git push origin "${{ needs.route.outputs.branch_name }}"`, no force flag. This is correct for both paths:
  - First run: the `Create impl branch` step did `git push -u origin <name> --force` already (its empty bootstrap commit). Subsequent push from this step adds the agent's commits on top, no force needed.
  - Revision run: the local branch was fetched fresh from origin, so the push is a fast-forward by definition.

  No edit needed. Just verify the step has no revision_mode gate.

- [ ] **Step 5.11: Run `actionlint` (or local YAML parse) to catch syntax errors**

  ```bash
  # If actionlint is installed:
  actionlint .github/workflows/shopfloor.yml
  # Otherwise, a basic YAML syntax check via the system Python:
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml'))"
  ```

  Expected: no errors. If actionlint is not installed, the YAML parse at minimum confirms the file is structurally valid.

- [ ] **Step 5.12: Manual diff review**

  ```bash
  git diff .github/workflows/shopfloor.yml
  ```

  Walk the diff and confirm:
  - All references to `steps.open_pr.outputs.pr_number` inside the impl job became `steps.pr.outputs.pr_number`. References inside `spec` and `plan` jobs are unchanged.
  - The two new revision-only steps (`Checkout existing impl branch`, `Resolve existing impl PR number`, `Build revision context`) all carry `if: ... && needs.route.outputs.revision_mode == 'true'`.
  - The two gated existing steps (`Create impl branch`, `open_pr`, `Build implement context`) all carry `if: ... && needs.route.outputs.revision_mode != 'true'`.
  - `Mark impl PR ready for review` carries the `revision_mode != 'true'` gate.
  - The aggregator steps (`Resolve unified impl PR number`, `Resolve unified context path`) run unconditionally beyond `precheck.outputs.skip != 'true'`.

- [ ] **Step 5.13: Commit**

  ```bash
  git add .github/workflows/shopfloor.yml
  git commit -m "$(cat <<'EOF'
  feat(workflow): branch implement job on revision_mode

  Add a revision-mode fork to the implement job. First runs continue to
  create the branch, push an empty bootstrap commit, open a draft PR, and
  build the context inline via jq. Revision runs fetch the existing impl
  branch, reuse the route output's impl_pr_number, build the context via
  the new build-revision-context helper, and skip the gh pr ready step.
  Shared steps (token mints, precheck, MCP config, agent invocation, push,
  finalize-progress, apply-impl-postwork, report-failure) run unchanged.
  Downstream references to the PR number flow through a unified resolver
  step so both paths feed the same value.
  EOF
  )"
  ```

---

## Task 6: Rebuild router dist

**Goal:** Regenerate `router/dist/index.cjs` from the updated TypeScript sources so the JS Action ships the new helper.

**Files:**

- Modify: `router/dist/index.cjs` (and its sourcemap)

- [ ] **Step 6.1: Build**

  ```bash
  pnpm --filter @shopfloor/router build
  ```

  Expected: esbuild writes `router/dist/index.cjs` and `router/dist/index.cjs.map`. No errors.

- [ ] **Step 6.2: Verify the new helper landed in the bundle**

  ```bash
  grep -c "build-revision-context" router/dist/index.cjs
  ```

  Expected: at least 2 (the helper case in the dispatcher plus the helper's own code).

- [ ] **Step 6.3: Run the full test suite one more time**

  ```bash
  pnpm test
  ```

  Expected: PASS.

- [ ] **Step 6.4: Type-check the whole repo**

  ```bash
  pnpm -r typecheck
  ```

  Expected: No errors.

- [ ] **Step 6.5: Format check**

  ```bash
  pnpm format:check
  ```

  Expected: PASS. If it fails, run `pnpm format` and re-stage.

- [ ] **Step 6.6: Commit**

  ```bash
  git add router/dist/index.cjs router/dist/index.cjs.map
  git commit -m "chore(router): rebuild dist"
  ```

---

## Verification before declaring done

After commit 6, verify the full feature end-to-end. Use the `superpowers:verification-before-completion` skill if available.

- [ ] **V1: All tests green.**

  ```bash
  pnpm test
  ```

- [ ] **V2: Type-check green.**

  ```bash
  pnpm -r typecheck
  ```

- [ ] **V3: Format clean.**

  ```bash
  pnpm format:check
  ```

- [ ] **V4: Workflow YAML valid.**

  ```bash
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/shopfloor.yml'))"
  ```

- [ ] **V5: The state machine populates the four new fields.** Read the diff of `router/src/state.ts` against main and visually confirm the implement-stage branch returns `branchName`, `implPrNumber`, `specFilePath`, `planFilePath`, plus the failed-parse path.

- [ ] **V6: The fragment file exists and renders.**

  ```bash
  cat prompts/implement-revision-fragment.md
  ```

  Confirm it contains the literal string `THIS IS A REVISION RUN`.

- [ ] **V7: The workflow has both forks.**

  ```bash
  grep -n "revision_mode" .github/workflows/shopfloor.yml
  ```

  Expected: at least 8 matches (the route output declaration plus the gates added in Task 5).

- [ ] **V8: Manual end-to-end on a real impl PR.** Push the branch, dispatch a Shopfloor issue end-to-end through the impl stage. Wait for the review matrix to post `REQUEST_CHANGES`. Watch the second impl run dispatch via the Actions UI. Confirm:
  - The impl job's `Create impl branch` step is skipped.
  - The new `Checkout existing impl branch` step succeeds.
  - The agent's progress comment shows the rendered revision fragment language.
  - The agent commits new work without rebasing or force-pushing.
  - `apply-impl-postwork` removes `shopfloor:review-requested-changes` and adds `shopfloor:needs-review`.
  - The push at the end of the impl run triggers another review matrix run that either approves the PR or posts another `REQUEST_CHANGES`.
  - After three iterations with no convergence (if you can engineer it), `aggregate-review` adds `shopfloor:review-stuck` and bails.

  V8 is the only step that depends on real GitHub events. V1-V7 are local. V8 should be the last gate before merging.

---

## Things that can go wrong (and what to do)

- **`build-revision-context.test.ts` "spec from filesystem" test fails because the prompts fragment doesn't exist at the test's resolved path.** The helper's `resolvePromptFile` walks `cwd`, then `$GITHUB_ACTION_PATH/..`, then `$GITHUB_ACTION_PATH`. Vitest runs from the repo root, so `prompts/implement-revision-fragment.md` should resolve. If the test fails on this, hardcode the path in the test setup using `join(__dirname, "../../../prompts/implement-revision-fragment.md")` instead of relying on resolver semantics.

- **TypeScript complains that `OctokitLike.pulls.listReviews` returns differently typed data after the extension.** The fix is to add `state: string` and `submitted_at: string | null` to existing test fixtures that mock `listReviews`. Search for `listReviews.mockResolvedValueOnce` and fill in the new fields with reasonable values.

- **The workflow YAML reaches a point where two steps need the same id.** GitHub Actions disallows it. Use distinct ids and a small aggregator step (the pattern is already shown in steps 5.5 and 5.7).

- **`git fetch origin <name>:<name>` fails with "refusing to fetch into current branch"** if the runner's checkout step somehow ended up on the impl branch already. Diagnostic: add `git status` before the fetch and check the current branch. The top-level `actions/checkout` step on the impl job checks out the workflow's `GITHUB_REF`, which for a `pull_request_review` event is `refs/pull/<N>/merge`. This is a detached HEAD ref, not the impl branch, so the fetch should succeed cleanly. If a regression breaks this assumption, swap the fetch for `git fetch origin <name>` followed by `git checkout -B <name> origin/<name>`.

- **The agent crashes complaining that `mcp__shopfloor__update_progress` cannot find the comment.** Verify `progress_comment_id` made it into the context and the MCP config. Both first-run and revision paths use the same `steps.progress.outputs.comment_id`, so this should not regress, but worth checking on the manual end-to-end.

- **`apply-impl-postwork` throws "shopfloor:implementing marker is not present"** on the revision run. This means the `Mark implement as running` step did not run. Check that step's `if:` gate — it should be `steps.precheck.outputs.skip != 'true'` only, with no revision_mode gate. The mutex applies to both paths.

---

## Skill-driven execution

This plan is structured for the `superpowers:subagent-driven-development` skill. Each task is independent enough to be dispatched to a fresh subagent with a clean context. The recommended dispatch order is the task order (1 -> 2 -> 3 -> 4 -> 5 -> 6) because tasks 4 and 5 depend on Task 1's state machine changes and Task 2's adapter additions, and Task 5 depends on Task 4's helper existing.

After each task, run the spec-compliance review described in the subagent-driven-development skill against the spec at `docs/superpowers/specs/2026-04-15-impl-revision-loop-design.md`.
