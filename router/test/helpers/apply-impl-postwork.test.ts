import { describe, expect, test } from 'vitest';
import { applyImplPostwork } from '../../src/helpers/apply-impl-postwork';
import { makeMockAdapter } from './_mock-adapter';

describe('applyImplPostwork', () => {
  test('normal impl PR -> needs-review, updates PR body + title', async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: 'open',
        draft: false,
        merged: false,
        labels: [],
        head: { sha: 'abc' },
        body: 'Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\n'
      }
    });
    bundle.mocks.listFiles.mockResolvedValueOnce({ data: [{ filename: 'src/auth.ts' }] });
    bundle.mocks.getIssue.mockResolvedValueOnce({ data: { labels: [], state: 'open' } });
    bundle.mocks.listReviews.mockResolvedValueOnce({ data: [] });

    const result = await applyImplPostwork(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      prTitle: 'feat: add GitHub OAuth login (#42)',
      prBody: 'Full implementation body'
    });
    expect(result.nextLabel).toBe('shopfloor:needs-review');
    expect(bundle.mocks.updatePr).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 45,
        title: 'feat: add GitHub OAuth login (#42)',
        body: 'Full implementation body'
      })
    );
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['shopfloor:needs-review'] })
    );
  });

  test('skip-review on PR -> impl-in-review', async () => {
    const bundle = makeMockAdapter();
    bundle.mocks.getPr.mockResolvedValueOnce({
      data: {
        state: 'open',
        draft: false,
        merged: false,
        labels: [{ name: 'shopfloor:skip-review' }],
        head: { sha: 'abc' },
        body: 'Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\n'
      }
    });
    bundle.mocks.listFiles.mockResolvedValueOnce({ data: [{ filename: 'src/auth.ts' }] });
    bundle.mocks.getIssue.mockResolvedValueOnce({ data: { labels: [], state: 'open' } });
    bundle.mocks.listReviews.mockResolvedValueOnce({ data: [] });

    const result = await applyImplPostwork(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      prTitle: 'title',
      prBody: 'body'
    });
    expect(result.nextLabel).toBe('shopfloor:impl-in-review');
  });
});
