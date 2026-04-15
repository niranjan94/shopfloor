import type { OctokitLike } from "../../../src/types";
import type { FakeState } from "./state";
import * as issues from "./handlers/issues";
import * as pulls from "./handlers/pulls";
import * as repos from "./handlers/repos";

export interface ShimOptions {
  state: FakeState;
  /** The login of whichever GitHub App is making this call. */
  actor: string;
}

function envelope<T>(data: T): { data: T } {
  return { data };
}

export function buildOctokitShim(opts: ShimOptions): OctokitLike {
  const { state, actor } = opts;
  return {
    rest: {
      issues: {
        async addLabels(p) {
          return envelope(issues.addLabels(state, p));
        },
        async removeLabel(p) {
          issues.removeLabel(state, p);
          return envelope([]);
        },
        async createComment(p) {
          return envelope(issues.createComment(state, p));
        },
        async updateComment(p) {
          issues.updateComment(state, p);
          return envelope({});
        },
        async createLabel(p) {
          issues.createLabel(state, p);
          return envelope({});
        },
        async listLabelsForRepo(p) {
          return envelope(issues.listLabelsForRepo(state, p));
        },
        async update(p) {
          issues.updateIssue(state, p);
          return envelope({});
        },
        async get(p) {
          const data = issues.getIssue(state, p);
          return { data: { ...data, labels: data.labels } } as never;
        },
        async listComments(p) {
          return envelope(issues.listComments(state, p));
        },
      },
      pulls: {
        async create(p) {
          return envelope(pulls.createPr(state, p));
        },
        async list(p) {
          return envelope(pulls.listPrs(state, p));
        },
        async update(p) {
          pulls.updatePr(state, p);
          return envelope({});
        },
        async get(p) {
          return envelope(pulls.getPr(state, p)) as never;
        },
        async listFiles(p) {
          return envelope(pulls.listFiles(state, p));
        },
        async createReview(p) {
          pulls.createReview(state, { ...p, actor, comments: (p.comments ?? []) as never });
          return envelope({});
        },
        async listReviews(p) {
          return envelope(pulls.listReviews(state, p));
        },
        async listReviewComments(p) {
          return envelope(pulls.listReviewComments(state, p));
        },
      },
      repos: {
        async createCommitStatus(p) {
          repos.createCommitStatus(state, p);
          return envelope({});
        },
      },
    },
  } satisfies OctokitLike;
}
