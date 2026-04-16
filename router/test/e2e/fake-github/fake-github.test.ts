import { describe, expect, test } from "vitest";
import { newFakeState } from "./state";
import { FakeRequestError } from "./errors";
import { createCommitStatus } from "./handlers/repos";
import { FakeGitHub } from "./index";
import {
  addLabels,
  removeLabel,
  createComment,
  updateComment,
  createLabel,
  listLabelsForRepo,
  updateIssue,
  getIssue,
  listComments,
} from "./handlers/issues";
import {
  createPr,
  listPrs,
  updatePr,
  getPr,
  listFiles,
  createReview,
  listReviews,
  listReviewComments,
} from "./handlers/pulls";

describe("issues.addLabels", () => {
  test("rejects unknown label with 422", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: null,
      state: "open",
      labels: [],
      author: "alice",
      createdAt: "2026-04-15T00:00:00Z",
    });
    expect(() =>
      addLabels(state, { issue_number: 1, labels: ["never-bootstrapped"] }),
    ).toThrow(FakeRequestError);
    try {
      addLabels(state, { issue_number: 1, labels: ["never-bootstrapped"] });
    } catch (err) {
      expect((err as FakeRequestError).status).toBe(422);
    }
  });

  test("is idempotent -- adding the same label twice is a no-op", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:triaging", {
      name: "shopfloor:triaging",
      color: "ededed",
    });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: null,
      state: "open",
      labels: [],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    addLabels(state, { issue_number: 1, labels: ["shopfloor:triaging"] });
    addLabels(state, { issue_number: 1, labels: ["shopfloor:triaging"] });
    expect(state.issues.get(1)!.labels).toEqual(["shopfloor:triaging"]);
    expect(state.eventLog.filter((e) => e.kind === "addLabel")).toHaveLength(1);
  });
});

describe("issues.removeLabel", () => {
  test("throws 404 when label is not on the issue", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:foo", {
      name: "shopfloor:foo",
      color: "ededed",
    });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: null,
      state: "open",
      labels: [],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    expect(() =>
      removeLabel(state, { issue_number: 1, name: "shopfloor:foo" }),
    ).toThrow(FakeRequestError);
    try {
      removeLabel(state, { issue_number: 1, name: "shopfloor:foo" });
    } catch (err) {
      expect((err as FakeRequestError).status).toBe(404);
    }
  });
  test("removes the label when present", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:foo", {
      name: "shopfloor:foo",
      color: "ededed",
    });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: null,
      state: "open",
      labels: ["shopfloor:foo"],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    removeLabel(state, { issue_number: 1, name: "shopfloor:foo" });
    expect(state.issues.get(1)!.labels).toEqual([]);
  });
});

describe("issues.createComment", () => {
  test("allocates a fresh id and returns it", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: null,
      state: "open",
      labels: [],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    const a = createComment(state, { issue_number: 1, body: "hello" });
    const b = createComment(state, { issue_number: 1, body: "world" });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(state.comments.get(1)!.body).toBe("hello");
    expect(state.comments.get(2)!.body).toBe("world");
  });
});

describe("issues.updateComment", () => {
  test("404 if comment id unknown", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    expect(() => updateComment(state, { comment_id: 999, body: "x" })).toThrow(
      FakeRequestError,
    );
  });
  test("updates the body", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.comments.set(1, { id: 1, issueNumber: 1, body: "old", author: "x" });
    updateComment(state, { comment_id: 1, body: "new" });
    expect(state.comments.get(1)!.body).toBe("new");
  });
});

describe("issues.createLabel", () => {
  test("registers a new label", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    createLabel(state, { name: "shopfloor:foo", color: "ededed" });
    expect(state.labels.has("shopfloor:foo")).toBe(true);
  });
  test("throws 422 when label already exists", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    createLabel(state, { name: "shopfloor:foo", color: "ededed" });
    expect(() =>
      createLabel(state, { name: "shopfloor:foo", color: "ededed" }),
    ).toThrow(FakeRequestError);
  });
});

describe("issues.listLabelsForRepo", () => {
  test("returns all labels", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("a", { name: "a", color: "ededed" });
    state.labels.set("b", { name: "b", color: "ededed" });
    expect(
      listLabelsForRepo(state, { per_page: 100 })
        .map((l) => l.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("issues.update", () => {
  test("closes an open issue and logs", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: "b",
      state: "open",
      labels: [],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    updateIssue(state, { issue_number: 1, state: "closed" });
    expect(state.issues.get(1)!.state).toBe("closed");
    expect(state.eventLog.some((e) => e.kind === "closeIssue")).toBe(true);
  });
  test("updates the body without changing state", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: "old",
      state: "open",
      labels: [],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    updateIssue(state, { issue_number: 1, body: "new" });
    expect(state.issues.get(1)!.body).toBe("new");
  });
});

describe("issues.get", () => {
  test("returns labels reshaped to [{name}]", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:triaging", {
      name: "shopfloor:triaging",
      color: "ededed",
    });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: "b",
      state: "open",
      labels: ["shopfloor:triaging"],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    const data = getIssue(state, { issue_number: 1 });
    expect(data.labels).toEqual([{ name: "shopfloor:triaging" }]);
    expect(data.title).toBe("x");
    expect(data.body).toBe("b");
    expect(data.state).toBe("open");
  });
});

describe("issues.listComments", () => {
  test("returns comments for the issue", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1,
      title: "x",
      body: null,
      state: "open",
      labels: [],
      author: "a",
      createdAt: "2026-04-15T00:00:00Z",
    });
    state.comments.set(1, {
      id: 1,
      issueNumber: 1,
      body: "hi",
      author: "alice",
    });
    state.comments.set(2, {
      id: 2,
      issueNumber: 99,
      body: "elsewhere",
      author: "bob",
    });
    const out = listComments(state, {
      issue_number: 1,
      per_page: 100,
      page: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("hi");
    expect(out[0].user).toEqual({ login: "alice" });
  });
});

describe("pulls.create", () => {
  test("rejects when the head branch does not exist", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    expect(() =>
      createPr(state, {
        base: "main",
        head: "shopfloor/42-foo",
        title: "T",
        body: "B",
        draft: false,
      }),
    ).toThrow(FakeRequestError);
  });

  test("open-PR-per-head uniqueness: second open PR for same head is rejected", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("shopfloor/42-foo", "sha-foo-0");
    createPr(state, {
      base: "main",
      head: "shopfloor/42-foo",
      title: "T",
      body: "B",
    });
    expect(() =>
      createPr(state, {
        base: "main",
        head: "shopfloor/42-foo",
        title: "T2",
        body: "B2",
      }),
    ).toThrow(/already exists/);
  });
});

describe("pulls.list", () => {
  test("filters by head with owner:branch format", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("shopfloor/42-foo", "sha-foo-0");
    state.branches.set("shopfloor/43-bar", "sha-bar-0");
    createPr(state, {
      base: "main",
      head: "shopfloor/42-foo",
      title: "A",
      body: "",
    });
    createPr(state, {
      base: "main",
      head: "shopfloor/43-bar",
      title: "B",
      body: "",
    });
    const result = listPrs(state, {
      head: "o:shopfloor/42-foo",
      state: "open",
    });
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(1);
  });
});

describe("pulls.update", () => {
  test("patches title and body", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "old", body: "old" });
    updatePr(state, { pull_number: 1, title: "new-t", body: "new-b" });
    expect(state.pulls.get(1)!.title).toBe("new-t");
    expect(state.pulls.get(1)!.body).toBe("new-b");
  });
});

describe("pulls.get", () => {
  test("returns full PR shape", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    const data = getPr(state, { pull_number: 1 });
    expect(data.head).toEqual(
      expect.objectContaining({ ref: "h", sha: "sha-h-0" }),
    );
    expect(data.state).toBe("open");
    expect(data.draft).toBe(false);
    expect(data.merged).toBe(false);
  });
});

describe("pulls.listFiles", () => {
  test("returns the seeded file list", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    state.pulls.get(1)!.files = ["src/a.ts", "src/b.ts"];
    const data = listFiles(state, { pull_number: 1 });
    expect(data.map((d) => d.filename)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("pulls.createReview", () => {
  test("rejects REQUEST_CHANGES when reviewer matches PR author", () => {
    const state = newFakeState({
      owner: "o",
      repo: "r",
      authIdentity: "shopfloor[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    expect(() =>
      createReview(state, {
        pull_number: 1,
        commit_id: "sha-h-0",
        event: "REQUEST_CHANGES",
        body: "no",
        comments: [],
        actor: "shopfloor[bot]",
      }),
    ).toThrow(/Can not approve your own pull request/);
  });

  test("allows REQUEST_CHANGES from a distinct identity", () => {
    const state = newFakeState({
      owner: "o",
      repo: "r",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1,
      commit_id: "sha-h-0",
      event: "REQUEST_CHANGES",
      body: "fix this",
      comments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "rename" }],
      actor: "shopfloor-review[bot]",
    });
    expect(state.reviews.size).toBe(1);
    expect(state.reviewComments.size).toBe(1);
    const review = Array.from(state.reviews.values())[0];
    expect(review.state).toBe("changes_requested");
    expect(review.user.login).toBe("shopfloor-review[bot]");
  });

  test("allows COMMENT review even from PR author", () => {
    const state = newFakeState({
      owner: "o",
      repo: "r",
      authIdentity: "shopfloor[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1,
      commit_id: "sha-h-0",
      event: "COMMENT",
      body: "fyi",
      comments: [],
      actor: "shopfloor[bot]",
    });
    expect(state.reviews.size).toBe(1);
  });
});

describe("pulls.listReviews", () => {
  test("returns rows with commit_id, state, and submitted_at", () => {
    const state = newFakeState({
      owner: "o",
      repo: "r",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1,
      commit_id: "sha-1",
      event: "REQUEST_CHANGES",
      body: "fix",
      comments: [],
      actor: "shopfloor-review[bot]",
    });
    const rows = listReviews(state, { pull_number: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        commit_id: "sha-1",
        state: "changes_requested",
        submitted_at: expect.any(String),
        user: { login: "shopfloor-review[bot]" },
        body: "fix",
      }),
    );
  });
});

describe("pulls.listReviewComments", () => {
  test("returns inline comments with pull_request_review_id and path/line/side/body", () => {
    const state = newFakeState({
      owner: "o",
      repo: "r",
      authIdentity: "shopfloor[bot]",
      reviewAuthIdentity: "shopfloor-review[bot]",
    });
    state.branches.set("main", "sha-main-0");
    state.branches.set("h", "sha-h-0");
    createPr(state, { base: "main", head: "h", title: "T", body: "B" });
    createReview(state, {
      pull_number: 1,
      commit_id: "sha-1",
      event: "REQUEST_CHANGES",
      body: "fix",
      comments: [{ path: "src/a.ts", line: 5, side: "RIGHT", body: "rename" }],
      actor: "shopfloor-review[bot]",
    });
    const out = listReviewComments(state, {
      pull_number: 1,
      per_page: 100,
      page: 1,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(
      expect.objectContaining({
        path: "src/a.ts",
        line: 5,
        side: "RIGHT",
        body: "rename",
        pull_request_review_id: 1,
      }),
    );
  });
});

describe("repos.createCommitStatus", () => {
  test("truncates description to 140 chars", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    const long = "x".repeat(200);
    createCommitStatus(state, {
      sha: "abc",
      state: "pending",
      context: "shopfloor/review",
      description: long,
    });
    const ctxMap = state.statuses.get("abc")!;
    expect(ctxMap.get("shopfloor/review")!.description).toHaveLength(140);
  });
  test("latest-wins per (sha, context)", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    createCommitStatus(state, {
      sha: "abc",
      state: "pending",
      context: "shopfloor/review",
      description: "first",
    });
    createCommitStatus(state, {
      sha: "abc",
      state: "success",
      context: "shopfloor/review",
      description: "second",
    });
    expect(state.statuses.get("abc")!.get("shopfloor/review")!.state).toBe(
      "success",
    );
    expect(
      state.statuses.get("abc")!.get("shopfloor/review")!.description,
    ).toBe("second");
  });
});

describe("FakeGitHub.asOctokit", () => {
  test("addLabels through the shim mutates the underlying state", async () => {
    const fake = new FakeGitHub({ owner: "o", repo: "r" });
    fake.seedLabels([{ name: "shopfloor:trigger", color: "ededed" }]);
    fake.seedIssue({ number: 1, title: "x", body: null, author: "a" });
    const oct = fake.asOctokit("shopfloor[bot]");
    await oct.rest.issues.addLabels({
      owner: "o",
      repo: "r",
      issue_number: 1,
      labels: ["shopfloor:trigger"],
    });
    expect(fake.labelsOn(1)).toEqual(["shopfloor:trigger"]);
  });
  test("snapshot omits internal counters and event log", () => {
    const fake = new FakeGitHub({ owner: "o", repo: "r" });
    fake.seedLabels([{ name: "shopfloor:trigger", color: "ededed" }]);
    fake.seedIssue({ number: 1, title: "x", body: null, author: "a" });
    const snap = fake.snapshot() as Record<string, unknown>;
    expect(snap).toHaveProperty("issues");
    expect(snap).not.toHaveProperty("nextNumber");
    expect(snap).not.toHaveProperty("eventLog");
  });
});
