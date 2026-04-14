import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export async function createProgressComment(
  adapter: GitHubAdapter,
  prNumber: number,
): Promise<number> {
  return adapter.postIssueComment(
    prNumber,
    "**Shopfloor implementation in progress.**\n\nI will update this comment with progress as I work. Stand by.",
  );
}

export async function runCreateProgressComment(
  adapter: GitHubAdapter,
): Promise<void> {
  const id = await createProgressComment(
    adapter,
    Number(core.getInput("pr_number", { required: true })),
  );
  core.setOutput("comment_id", String(id));
}
