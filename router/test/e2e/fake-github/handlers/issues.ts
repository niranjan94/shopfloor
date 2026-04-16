import { FakeRequestError } from "../errors";
import type { FakeState, Label } from "../state";

function nextTick(state: FakeState): number {
  return ++state.clock;
}

function requireIssue(state: FakeState, n: number) {
  const issue = state.issues.get(n);
  if (!issue) {
    throw new FakeRequestError(404, `Issue #${n} not found`);
  }
  return issue;
}

/**
 * GitHub treats every PR as also an Issue for the /issues/:n/comments
 * endpoint and related surfaces. The fake keeps issues and pulls in
 * separate maps, so comment-side handlers must accept either. This
 * returns true if the number resolves to a known PR.
 */
function isKnownPr(state: FakeState, n: number): boolean {
  return state.pulls.has(n);
}

export function addLabels(
  state: FakeState,
  params: { issue_number: number; labels: string[] },
): { id: number; name: string }[] {
  const issue = requireIssue(state, params.issue_number);
  for (const label of params.labels) {
    if (!state.labels.has(label)) {
      throw new FakeRequestError(422, `Label does not exist: ${label}`);
    }
    if (!issue.labels.includes(label)) {
      issue.labels.push(label);
      state.eventLog.push({
        kind: "addLabel",
        issue: issue.number,
        label,
        t: nextTick(state),
      });
    }
  }
  return issue.labels.map((name, idx) => ({ id: idx + 1, name }));
}

export function removeLabel(
  state: FakeState,
  params: { issue_number: number; name: string },
): void {
  const issue = requireIssue(state, params.issue_number);
  const idx = issue.labels.indexOf(params.name);
  if (idx === -1) {
    throw new FakeRequestError(
      404,
      `Label not found on issue #${params.issue_number}`,
    );
  }
  issue.labels.splice(idx, 1);
  state.eventLog.push({
    kind: "removeLabel",
    issue: issue.number,
    label: params.name,
    t: nextTick(state),
  });
}

export function createComment(
  state: FakeState,
  params: { issue_number: number; body: string },
): { id: number } {
  // Accept either a real Issue or a PR (which GitHub treats as an Issue
  // for the comments endpoint). Apply-impl-postwork creates progress
  // comments addressed to the impl PR number, and those must resolve.
  if (
    !state.issues.has(params.issue_number) &&
    !isKnownPr(state, params.issue_number)
  ) {
    throw new FakeRequestError(404, `Issue #${params.issue_number} not found`);
  }
  const id = state.nextCommentId++;
  state.comments.set(id, {
    id,
    issueNumber: params.issue_number,
    body: params.body,
    author: state.authIdentity,
  });
  state.eventLog.push({
    kind: "createComment",
    issue: params.issue_number,
    id,
    t: nextTick(state),
  });
  return { id };
}

export function updateComment(
  state: FakeState,
  params: { comment_id: number; body: string },
): void {
  const c = state.comments.get(params.comment_id);
  if (!c)
    throw new FakeRequestError(404, `Comment #${params.comment_id} not found`);
  c.body = params.body;
  state.eventLog.push({ kind: "updateComment", id: c.id, t: nextTick(state) });
}

export function createLabel(
  state: FakeState,
  params: { name: string; color: string; description?: string },
): void {
  if (state.labels.has(params.name)) {
    throw new FakeRequestError(422, `Label already exists: ${params.name}`);
  }
  state.labels.set(params.name, {
    name: params.name,
    color: params.color,
    description: params.description,
  });
  state.eventLog.push({
    kind: "createLabel",
    name: params.name,
    t: nextTick(state),
  });
}

export function listLabelsForRepo(
  state: FakeState,
  params: { per_page?: number; page?: number } = {},
): Label[] {
  const all = Array.from(state.labels.values());
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return all.slice((page - 1) * per, page * per);
}

export function updateIssue(
  state: FakeState,
  params: { issue_number: number; state?: "open" | "closed"; body?: string },
): void {
  const issue = requireIssue(state, params.issue_number);
  if (params.state !== undefined && params.state !== issue.state) {
    issue.state = params.state;
    state.eventLog.push({
      kind: params.state === "closed" ? "closeIssue" : "openIssue",
      issue: issue.number,
      t: nextTick(state),
    });
  }
  if (params.body !== undefined) {
    issue.body = params.body;
    state.eventLog.push({
      kind: "updateIssueBody",
      issue: issue.number,
      t: nextTick(state),
    });
  }
}

export function getIssue(
  state: FakeState,
  params: { issue_number: number },
): {
  labels: Array<{ name: string }>;
  state: "open" | "closed";
  title: string;
  body: string | null;
} {
  const issue = requireIssue(state, params.issue_number);
  return {
    labels: issue.labels.map((name) => ({ name })),
    state: issue.state,
    title: issue.title,
    body: issue.body,
  };
}

export function listComments(
  state: FakeState,
  params: { issue_number: number; per_page?: number; page?: number },
): Array<{ user: { login: string }; created_at: string; body: string }> {
  const all = Array.from(state.comments.values())
    .filter((c) => c.issueNumber === params.issue_number)
    .map((c) => ({
      user: { login: c.author },
      // The fake does not distinguish per-comment created_at; surface a
      // deterministic ISO timestamp derived from the comment id so tests
      // that round-trip on this field stay stable.
      created_at: `2026-04-15T00:00:${String(c.id).padStart(2, "0")}Z`,
      body: c.body,
    }));
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return all.slice((page - 1) * per, page * per);
}
