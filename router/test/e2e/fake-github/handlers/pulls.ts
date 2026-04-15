import { FakeRequestError } from "../errors";
import type { FakeState, Pull } from "../state";

function nextTick(state: FakeState): number {
  return ++state.clock;
}

function requirePr(state: FakeState, n: number): Pull {
  const pr = state.pulls.get(n);
  if (!pr) throw new FakeRequestError(404, `Pull #${n} not found`);
  return pr;
}

export function createPr(
  state: FakeState,
  params: {
    base: string;
    head: string;
    title: string;
    body: string;
    draft?: boolean;
  },
): { number: number; html_url: string } {
  if (!state.branches.has(params.head)) {
    throw new FakeRequestError(
      422,
      `Head branch ${params.head} does not exist on ${state.repo.owner}/${state.repo.repo}`,
    );
  }
  const headSha = state.branches.get(params.head)!;
  const baseSha = state.branches.get(params.base) ?? "sha-base-0";
  // Open-PR-per-head uniqueness
  for (const existing of state.pulls.values()) {
    if (
      existing.head.ref === params.head &&
      existing.state === "open" &&
      !existing.merged
    ) {
      throw new FakeRequestError(
        422,
        `A pull request already exists for ${state.repo.owner}:${params.head}`,
      );
    }
  }
  const n = state.nextNumber++;
  const pr: Pull = {
    number: n,
    title: params.title,
    body: params.body,
    state: "open",
    draft: params.draft ?? false,
    merged: false,
    base: { ref: params.base, sha: baseSha },
    head: { ref: params.head, sha: headSha },
    labels: [],
    author: state.authIdentity,
    files: [],
    createdAt: `2026-04-15T00:00:${String(n).padStart(2, "0")}Z`,
  };
  state.pulls.set(n, pr);
  state.eventLog.push({
    kind: "createPr",
    pr: n,
    head: params.head,
    base: params.base,
    t: nextTick(state),
  });
  return {
    number: n,
    html_url: `https://github.com/${state.repo.owner}/${state.repo.repo}/pull/${n}`,
  };
}

export function listPrs(
  state: FakeState,
  params: {
    head?: string;
    state?: "open" | "closed" | "all";
    per_page?: number;
  },
): Array<{ number: number; html_url: string }> {
  const stateFilter = params.state ?? "open";
  let result = Array.from(state.pulls.values());
  if (stateFilter !== "all") {
    result = result.filter((p) => p.state === stateFilter);
  }
  if (params.head) {
    // GitHub format: "owner:branch"
    const [, headRef] = params.head.split(":");
    result = result.filter((p) => p.head.ref === headRef);
  }
  const per = params.per_page ?? 30;
  return result.slice(0, per).map((p) => ({
    number: p.number,
    html_url: `https://github.com/${state.repo.owner}/${state.repo.repo}/pull/${p.number}`,
  }));
}

export function updatePr(
  state: FakeState,
  params: { pull_number: number; title?: string; body?: string },
): void {
  const pr = requirePr(state, params.pull_number);
  const fields: string[] = [];
  if (params.title !== undefined) {
    pr.title = params.title;
    fields.push("title");
  }
  if (params.body !== undefined) {
    pr.body = params.body;
    fields.push("body");
  }
  state.eventLog.push({
    kind: "updatePr",
    pr: pr.number,
    fields,
    t: nextTick(state),
  });
}

export function getPr(
  state: FakeState,
  params: { pull_number: number },
): {
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  labels: Array<{ name: string }>;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  body: string | null;
} {
  const pr = requirePr(state, params.pull_number);
  return {
    state: pr.state,
    draft: pr.draft,
    merged: pr.merged,
    labels: pr.labels.map((name) => ({ name })),
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
    body: pr.body,
  };
}

export function listFiles(
  state: FakeState,
  params: { pull_number: number; per_page?: number; page?: number },
): Array<{ filename: string }> {
  const pr = requirePr(state, params.pull_number);
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return pr.files
    .slice((page - 1) * per, page * per)
    .map((filename) => ({ filename }));
}

// LOWERCASE on purpose -- see the comment on the Review type in state.ts.
const EVENT_TO_STATE: Record<
  "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "approved" | "changes_requested" | "commented"
> = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes_requested",
  COMMENT: "commented",
};

export interface CreateReviewParams {
  pull_number: number;
  commit_id: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: Array<{
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
    body: string;
  }>;
  /** Identity (login) of whoever is making this call. The shim sets this. */
  actor: string;
}

export function createReview(state: FakeState, params: CreateReviewParams): void {
  const pr = requirePr(state, params.pull_number);
  if (params.event !== "COMMENT" && params.actor === pr.author) {
    throw new FakeRequestError(
      422,
      "Can not approve your own pull request",
    );
  }
  const id = state.nextReviewId++;
  state.reviews.set(id, {
    id,
    prNumber: pr.number,
    commitId: params.commit_id,
    event: params.event,
    state: EVENT_TO_STATE[params.event],
    body: params.body,
    user: { login: params.actor },
    submittedAt: `2026-04-15T00:00:${String(state.clock + 1).padStart(2, "0")}Z`,
  });
  state.eventLog.push({
    kind: "createReview",
    pr: pr.number,
    id,
    event: params.event,
    user: params.actor,
    t: nextTick(state),
  });
  for (const c of params.comments) {
    const cid = state.nextReviewCommentId++;
    state.reviewComments.set(cid, {
      id: cid,
      prNumber: pr.number,
      reviewId: id,
      path: c.path,
      line: c.line,
      side: c.side,
      startLine: c.start_line,
      startSide: c.start_side,
      body: c.body,
      user: { login: params.actor },
    });
    state.eventLog.push({
      kind: "createReviewComment",
      id: cid,
      reviewId: id,
      t: nextTick(state),
    });
  }
}

export function listReviews(
  state: FakeState,
  params: { pull_number: number; per_page?: number },
): Array<{
  id: number;
  user: { login: string } | null;
  body: string;
  commit_id: string;
  state: string;
  submitted_at: string;
}> {
  const all = Array.from(state.reviews.values()).filter(
    (r) => r.prNumber === params.pull_number,
  );
  return all.map((r) => ({
    id: r.id,
    user: r.user,
    body: r.body,
    commit_id: r.commitId,
    state: r.state,
    submitted_at: r.submittedAt,
  }));
}

export function listReviewComments(
  state: FakeState,
  params: { pull_number: number; per_page?: number; page?: number },
): Array<{
  id: number;
  pull_request_review_id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line: number | null;
  start_side: "LEFT" | "RIGHT" | null;
  body: string;
}> {
  const all = Array.from(state.reviewComments.values())
    .filter((c) => c.prNumber === params.pull_number)
    .map((c) => ({
      id: c.id,
      pull_request_review_id: c.reviewId,
      path: c.path,
      line: c.line,
      side: c.side,
      start_line: c.startLine ?? null,
      start_side: c.startSide ?? null,
      body: c.body,
    }));
  const per = params.per_page ?? 30;
  const page = params.page ?? 1;
  return all.slice((page - 1) * per, page * per);
}
