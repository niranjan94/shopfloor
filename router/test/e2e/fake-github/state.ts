export interface Label {
  name: string;
  color: string;
  description?: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  author: string;
  createdAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  labels: string[];
  author: string;
  files: string[];
  createdAt: string;
  mergedAt?: string;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  author: string;
}

export interface Review {
  id: number;
  prNumber: number;
  commitId: string;
  // `event` is the input verb the createReview API takes; `state` is what
  // listReviews returns. Real GitHub returns LOWERCASE state strings, and
  // both build-revision-context.ts and state.ts filter on the lowercase
  // value. The fake MUST emit lowercase or impl-review-retry-loop crashes
  // inside build-revision-context with "PR has no REQUEST_CHANGES review".
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  state: "approved" | "changes_requested" | "commented";
  body: string;
  user: { login: string };
  submittedAt: string;
}

export interface ReviewComment {
  id: number;
  prNumber: number;
  reviewId: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
  user: { login: string };
}

export interface Status {
  sha: string;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  description: string;
  targetUrl?: string;
  updatedAt: string;
}

export type WriteEvent =
  | { kind: "addLabel"; issue: number; label: string; t: number }
  | { kind: "removeLabel"; issue: number; label: string; t: number }
  | { kind: "createLabel"; name: string; t: number }
  | { kind: "createComment"; issue: number; id: number; t: number }
  | { kind: "updateComment"; id: number; t: number }
  | { kind: "updateIssueBody"; issue: number; t: number }
  | { kind: "closeIssue"; issue: number; t: number }
  | { kind: "openIssue"; issue: number; t: number }
  | { kind: "createPr"; pr: number; head: string; base: string; t: number }
  | { kind: "updatePr"; pr: number; fields: string[]; t: number }
  | { kind: "mergePr"; pr: number; sha: string; t: number }
  | {
      kind: "createReview";
      pr: number;
      id: number;
      event: Review["event"];
      user: string;
      t: number;
    }
  | { kind: "createReviewComment"; id: number; reviewId: number; t: number }
  | { kind: "setStatus"; sha: string; context: string; t: number };

export interface FakeState {
  repo: { owner: string; repo: string };
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment>;
  reviews: Map<number, Review>;
  reviewComments: Map<number, ReviewComment>;
  statuses: Map<string, Map<string, Status>>;
  branches: Map<string, string>; // branch -> head sha
  nextNumber: number; // shared issue/PR pool, matches GitHub
  nextCommentId: number;
  nextReviewId: number;
  nextReviewCommentId: number;
  authIdentity: string;
  reviewAuthIdentity?: string;
  eventLog: WriteEvent[];
  clock: number; // monotonically incrementing tick for tests
}

export function newFakeState(opts: {
  owner: string;
  repo: string;
  authIdentity?: string;
  reviewAuthIdentity?: string;
}): FakeState {
  return {
    repo: { owner: opts.owner, repo: opts.repo },
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    reviews: new Map(),
    reviewComments: new Map(),
    statuses: new Map(),
    branches: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    nextReviewId: 1,
    nextReviewCommentId: 1,
    authIdentity: opts.authIdentity ?? "shopfloor[bot]",
    reviewAuthIdentity: opts.reviewAuthIdentity,
    eventLog: [],
    clock: 0,
  };
}
