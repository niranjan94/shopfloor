import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

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

export async function runFinalizeProgressComment(
  adapter: GitHubAdapter,
): Promise<void> {
  await finalizeProgressComment(
    adapter,
    Number(core.getInput("comment_id", { required: true })),
    core.getInput("terminal_state", { required: true }) as
      | "success"
      | "failure",
    core.getInput("final_body", { required: true }),
  );
}
