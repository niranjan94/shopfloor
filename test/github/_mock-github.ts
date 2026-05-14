import { vi } from "vitest";
import type { GitHubAdapter } from "../../src/github/adapter.js";

// A vitest-fn-shaped stand-in for GitHubAdapter. Each method is `vi.fn()` so
// tests can assert on calls and reconfigure return values per case. Cast to
// GitHubAdapter at the use site -- structural overlap is enough for the
// methods stages actually touch.
export function makeMockGithub() {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    replaceLabels: vi.fn().mockResolvedValue(undefined),
    postIssueComment: vi.fn().mockResolvedValue(1),
    updateComment: vi.fn().mockResolvedValue(undefined),
    findOpenPrByHead: vi.fn().mockResolvedValue(null),
    findOpenImplPrForIssue: vi.fn().mockResolvedValue(null),
    openStagePr: vi.fn().mockResolvedValue({
      number: 100,
      url: "https://x/pr/100",
    }),
    updatePrBody: vi.fn().mockResolvedValue(undefined),
    updatePr: vi.fn().mockResolvedValue(undefined),
    postReview: vi.fn().mockResolvedValue(undefined),
    setReviewStatus: vi.fn().mockResolvedValue(undefined),
    listRepoLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
    closeIssue: vi.fn().mockResolvedValue(undefined),
    getPr: vi.fn(),
    listChangedFiles: vi.fn().mockResolvedValue([]),
    listChangedFilePatches: vi.fn().mockResolvedValue([]),
    getIssue: vi
      .fn()
      .mockResolvedValue({ labels: [], state: "open", title: "t", body: null }),
    updateIssueBody: vi.fn().mockResolvedValue(undefined),
    upsertIssueMetadata: vi.fn().mockResolvedValue(undefined),
    getPrReviewsAtSha: vi.fn().mockResolvedValue([]),
    listPrReviews: vi.fn().mockResolvedValue([]),
    listPrReviewComments: vi.fn().mockResolvedValue([]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    getRefSha: vi.fn().mockResolvedValue("base-sha"),
    createRef: vi.fn().mockResolvedValue(true),
    getFileSha: vi.fn().mockResolvedValue(null),
    putFileContents: vi.fn().mockResolvedValue(undefined),
    markPullRequestReadyForReview: vi.fn().mockResolvedValue(undefined),
  };
}

export type MockGithub = ReturnType<typeof makeMockGithub>;

export function asAdapter(mg: MockGithub): GitHubAdapter {
  return mg as unknown as GitHubAdapter;
}
