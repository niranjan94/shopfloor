import { describe, expect, test } from 'vitest';
import { advanceState } from '../../src/helpers/advance-state';
import { makeMockAdapter } from './_mock-adapter';

describe('advanceState', () => {
  test('removes fromLabels and adds toLabels', async () => {
    const { adapter, mocks } = makeMockAdapter();
    await advanceState(adapter, 42, ['shopfloor:needs-spec'], ['shopfloor:spec-in-review']);
    expect(mocks.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shopfloor:needs-spec' })
    );
    expect(mocks.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['shopfloor:spec-in-review'] })
    );
  });
});
