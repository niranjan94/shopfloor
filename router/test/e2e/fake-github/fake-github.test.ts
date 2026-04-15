import { describe, expect, test } from "vitest";
import { newFakeState } from "./state";
import { FakeRequestError } from "./errors";
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

describe("issues.addLabels", () => {
  test("rejects unknown label with 422", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "alice", createdAt: "2026-04-15T00:00:00Z",
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
    state.labels.set("shopfloor:triaging", { name: "shopfloor:triaging", color: "ededed" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
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
    state.labels.set("shopfloor:foo", { name: "shopfloor:foo", color: "ededed" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    expect(() => removeLabel(state, { issue_number: 1, name: "shopfloor:foo" }))
      .toThrow(FakeRequestError);
    try {
      removeLabel(state, { issue_number: 1, name: "shopfloor:foo" });
    } catch (err) {
      expect((err as FakeRequestError).status).toBe(404);
    }
  });
  test("removes the label when present", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:foo", { name: "shopfloor:foo", color: "ededed" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: ["shopfloor:foo"],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    removeLabel(state, { issue_number: 1, name: "shopfloor:foo" });
    expect(state.issues.get(1)!.labels).toEqual([]);
  });
});

describe("issues.createComment", () => {
  test("allocates a fresh id and returns it", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
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
    expect(() => updateComment(state, { comment_id: 999, body: "x" }))
      .toThrow(FakeRequestError);
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
    expect(() => createLabel(state, { name: "shopfloor:foo", color: "ededed" }))
      .toThrow(FakeRequestError);
  });
});

describe("issues.listLabelsForRepo", () => {
  test("returns all labels", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("a", { name: "a", color: "ededed" });
    state.labels.set("b", { name: "b", color: "ededed" });
    expect(listLabelsForRepo(state, { per_page: 100 }).map((l) => l.name).sort())
      .toEqual(["a", "b"]);
  });
});

describe("issues.update", () => {
  test("closes an open issue and logs", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: "b", state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    updateIssue(state, { issue_number: 1, state: "closed" });
    expect(state.issues.get(1)!.state).toBe("closed");
    expect(state.eventLog.some((e) => e.kind === "closeIssue")).toBe(true);
  });
  test("updates the body without changing state", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.issues.set(1, {
      number: 1, title: "x", body: "old", state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    updateIssue(state, { issue_number: 1, body: "new" });
    expect(state.issues.get(1)!.body).toBe("new");
  });
});

describe("issues.get", () => {
  test("returns labels reshaped to [{name}]", () => {
    const state = newFakeState({ owner: "o", repo: "r" });
    state.labels.set("shopfloor:triaging", { name: "shopfloor:triaging", color: "ededed" });
    state.issues.set(1, {
      number: 1, title: "x", body: "b", state: "open", labels: ["shopfloor:triaging"],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
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
      number: 1, title: "x", body: null, state: "open", labels: [],
      author: "a", createdAt: "2026-04-15T00:00:00Z",
    });
    state.comments.set(1, { id: 1, issueNumber: 1, body: "hi", author: "alice" });
    state.comments.set(2, { id: 2, issueNumber: 99, body: "elsewhere", author: "bob" });
    const out = listComments(state, { issue_number: 1, per_page: 100, page: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("hi");
    expect(out[0].user).toEqual({ login: "alice" });
  });
});
