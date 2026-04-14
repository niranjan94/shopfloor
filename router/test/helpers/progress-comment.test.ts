import { describe, expect, test } from 'vitest';
import { createProgressComment } from '../../src/helpers/create-progress-comment';
import { finalizeProgressComment } from '../../src/helpers/finalize-progress-comment';
import { makeMockAdapter } from './_mock-adapter';

describe('progress comment helpers', () => {
  test('createProgressComment returns the comment id', async () => {
    const { adapter, mocks } = makeMockAdapter();
    mocks.createComment.mockResolvedValueOnce({ data: { id: 777 } });
    const id = await createProgressComment(adapter, 45);
    expect(id).toBe(777);
  });

  test('finalizeProgressComment replaces comment body', async () => {
    const { adapter, mocks } = makeMockAdapter();
    await finalizeProgressComment(adapter, 777, 'success', 'All tasks complete.');
    expect(mocks.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 777,
        body: expect.stringContaining('All tasks complete.')
      })
    );
  });
});
