import type { GitHubAdapter } from '../github';

export async function runCheckReviewSkip(_adapter: GitHubAdapter): Promise<void> {
  throw new Error('Not implemented');
}
