import { describe, expect, test } from 'vitest';
import { openStagePr } from '../../src/helpers/open-stage-pr';
import { makeMockAdapter } from './_mock-adapter';

describe('openStagePr', () => {
  test('opens a PR with metadata block and returns number', async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.createPr.mockResolvedValueOnce({ data: { number: 43, html_url: 'https://x/43' } });
    const result = await openStagePr(adapter, {
      issueNumber: 42,
      stage: 'spec',
      branchName: 'shopfloor/spec/42-foo',
      baseBranch: 'main',
      title: 'Spec for #42',
      body: 'Body.'
    });
    expect(result.prNumber).toBe(43);
    expect(result.url).toBe('https://x/43');
    const call = mocks.createPr.mock.calls[0][0] as { body: string };
    expect(call.body).toMatch(/Shopfloor-Issue: #42/);
    expect(call.body).toMatch(/Shopfloor-Stage: spec/);
  });
});
