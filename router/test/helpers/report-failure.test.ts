import { describe, expect, test } from 'vitest';
import { reportFailure } from '../../src/helpers/report-failure';
import { makeMockAdapter } from './_mock-adapter';

describe('reportFailure', () => {
  test('posts diagnostic comment and applies failed label', async () => {
    const { adapter, mocks } = makeMockAdapter();
    await reportFailure(adapter, { issueNumber: 42, stage: 'spec', runUrl: 'https://x/run/1' });
    expect(mocks.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('spec') })
    );
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['shopfloor:failed:spec'] })
    );
  });
});
