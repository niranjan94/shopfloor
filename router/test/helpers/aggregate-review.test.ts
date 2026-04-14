import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aggregateReview } from '../../src/helpers/aggregate-review';
import { makeMockAdapter } from './_mock-adapter';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(
    join(__dirname, '../fixtures/reviewer-outputs', `${name}.json`),
    'utf-8'
  );
}

function primeImplPr(bundle: ReturnType<typeof makeMockAdapter>, iteration = 0, sha = 'abc'): void {
  bundle.mocks.getPr.mockResolvedValueOnce({
    data: {
      state: 'open',
      draft: false,
      merged: false,
      labels: [],
      head: { sha },
      body: `Body\n---\nShopfloor-Issue: #42\nShopfloor-Stage: implement\nShopfloor-Review-Iteration: ${iteration}\n`
    }
  });
}

describe('aggregateReview', () => {
  test('all clean -> APPROVE review and success status', async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture('compliance-clean'),
        bugs: fixture('bugs-clean'),
        security: fixture('security-clean'),
        smells: fixture('smells-clean')
      }
    });
    expect(bundle.mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 45,
        event: 'APPROVE',
        comments: []
      })
    );
    expect(bundle.mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'success' })
    );
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['shopfloor:review-approved'] })
    );
  });

  test('issues found -> REQUEST_CHANGES with filtered+deduped comments', async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture('compliance-issues'),
        bugs: fixture('bugs-issues'),
        security: fixture('security-clean'),
        smells: fixture('smells-low-confidence')
      }
    });

    expect(bundle.mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'REQUEST_CHANGES' })
    );

    const reviewCall = bundle.mocks.createReview.mock.calls[0][0] as {
      comments: Array<{ path: string; body: string }>;
    };
    expect(reviewCall.comments.filter((c) => c.path === 'src/auth.ts').length).toBe(1);
    expect(reviewCall.comments.some((c) => c.body.includes('low-confidence'))).toBe(false);

    expect(bundle.mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failure' })
    );
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['shopfloor:review-requested-changes'] })
    );
  });

  test('iteration cap exceeded -> review-stuck, no REQUEST_CHANGES posted', async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle, 3);
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: fixture('compliance-issues'),
        bugs: fixture('bugs-clean'),
        security: fixture('security-clean'),
        smells: fixture('smells-clean')
      }
    });
    expect(bundle.mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['shopfloor:review-stuck'] })
    );
    expect(bundle.mocks.createReview).not.toHaveBeenCalled();
    const lastStatus = bundle.mocks.createCommitStatus.mock.calls.at(-1)?.[0] as {
      state: string;
      description: string;
    };
    expect(lastStatus.state).toBe('failure');
    expect(lastStatus.description).toMatch(/cap/);
  });

  test('matrix cell failed (empty output) -> treated as "no findings"', async () => {
    const bundle = makeMockAdapter();
    primeImplPr(bundle);
    await aggregateReview(bundle.adapter, {
      issueNumber: 42,
      prNumber: 45,
      confidenceThreshold: 80,
      maxIterations: 3,
      reviewerOutputs: {
        compliance: '',
        bugs: fixture('bugs-clean'),
        security: fixture('security-clean'),
        smells: fixture('smells-clean')
      }
    });
    expect(bundle.mocks.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' })
    );
  });
});
