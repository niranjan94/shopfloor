import type { GitHubAdapter } from "../../github/adapter.js";

// Open the pinned implementation-progress comment before the agent runs. The
// comment id is passed to the agent so it can call mcp__shopfloor__update_progress
// to flip checkboxes as it finishes plan tasks.
export async function createProgressComment(
  adapter: GitHubAdapter,
  prNumber: number,
): Promise<number> {
  return adapter.postIssueComment(
    prNumber,
    "**Shopfloor implementation in progress.**\n\nI will update this comment with progress as I work. Stand by.",
  );
}

export async function finalizeProgressComment(
  adapter: GitHubAdapter,
  commentId: number,
  terminalState: "success" | "failure",
  finalBody: string,
): Promise<void> {
  const header =
    terminalState === "success"
      ? "**Shopfloor implementation complete.**"
      : "**Shopfloor implementation ended with errors.**";
  await adapter.updateComment(commentId, `${header}\n\n${finalBody}`);
}
