import { vi } from 'vitest';
import { GitHubAdapter } from '../../src/github';
import type { OctokitLike } from '../../src/types';

export interface MockBundle {
  adapter: GitHubAdapter;
  mocks: {
    addLabels: ReturnType<typeof vi.fn>;
    removeLabel: ReturnType<typeof vi.fn>;
    createComment: ReturnType<typeof vi.fn>;
    updateComment: ReturnType<typeof vi.fn>;
    createLabel: ReturnType<typeof vi.fn>;
    listLabelsForRepo: ReturnType<typeof vi.fn>;
    updateIssue: ReturnType<typeof vi.fn>;
    getIssue: ReturnType<typeof vi.fn>;
    createPr: ReturnType<typeof vi.fn>;
    updatePr: ReturnType<typeof vi.fn>;
    getPr: ReturnType<typeof vi.fn>;
    listFiles: ReturnType<typeof vi.fn>;
    createReview: ReturnType<typeof vi.fn>;
    listReviews: ReturnType<typeof vi.fn>;
    createCommitStatus: ReturnType<typeof vi.fn>;
  };
}

export function makeMockAdapter(repo = { owner: 'o', repo: 'r' }): MockBundle {
  const mocks: MockBundle['mocks'] = {
    addLabels: vi.fn().mockResolvedValue({ data: [] }),
    removeLabel: vi.fn().mockResolvedValue({ data: [] }),
    createComment: vi.fn().mockResolvedValue({ data: { id: 1 } }),
    updateComment: vi.fn().mockResolvedValue({ data: {} }),
    createLabel: vi.fn().mockResolvedValue({ data: {} }),
    listLabelsForRepo: vi.fn().mockResolvedValue({ data: [] }),
    updateIssue: vi.fn().mockResolvedValue({ data: {} }),
    getIssue: vi.fn().mockResolvedValue({ data: { labels: [], state: 'open' } }),
    createPr: vi.fn().mockResolvedValue({ data: { number: 100, html_url: 'https://x/pr/100' } }),
    updatePr: vi.fn().mockResolvedValue({ data: {} }),
    getPr: vi.fn().mockResolvedValue({ data: {} }),
    listFiles: vi.fn().mockResolvedValue({ data: [] }),
    createReview: vi.fn().mockResolvedValue({ data: {} }),
    listReviews: vi.fn().mockResolvedValue({ data: [] }),
    createCommitStatus: vi.fn().mockResolvedValue({ data: {} })
  };
  const octokit = {
    rest: {
      issues: {
        addLabels: mocks.addLabels,
        removeLabel: mocks.removeLabel,
        createComment: mocks.createComment,
        updateComment: mocks.updateComment,
        createLabel: mocks.createLabel,
        listLabelsForRepo: mocks.listLabelsForRepo,
        update: mocks.updateIssue,
        get: mocks.getIssue
      },
      pulls: {
        create: mocks.createPr,
        update: mocks.updatePr,
        get: mocks.getPr,
        listFiles: mocks.listFiles,
        createReview: mocks.createReview,
        listReviews: mocks.listReviews
      },
      repos: {
        createCommitStatus: mocks.createCommitStatus
      }
    }
  } as unknown as OctokitLike;
  const adapter = new GitHubAdapter(octokit, repo);
  return { adapter, mocks };
}
