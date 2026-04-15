import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export async function advanceState(
  adapter: GitHubAdapter,
  issueNumber: number,
  fromLabels: string[],
  toLabels: string[],
): Promise<void> {
  if (fromLabels.length > 0) {
    const issue = await adapter.getIssue(issueNumber);
    const current = new Set(issue.labels.map((l) => l.name));
    const missing = fromLabels.filter((l) => !current.has(l));
    if (missing.length === fromLabels.length) {
      throw new Error(
        `advance-state: none of the expected from_labels are present on issue #${issueNumber}: [${fromLabels.join(", ")}]. Refusing to apply stale transition.`,
      );
    }
    if (missing.length > 0) {
      core.warning(
        `advance-state: some from_labels not present on issue #${issueNumber}: [${missing.join(", ")}]`,
      );
    }
  }
  for (const l of fromLabels) await adapter.removeLabel(issueNumber, l);
  for (const l of toLabels) await adapter.addLabel(issueNumber, l);
}

export async function runAdvanceState(adapter: GitHubAdapter): Promise<void> {
  const issueNumber = Number(core.getInput("issue_number", { required: true }));
  const fromLabels = (core.getInput("from_labels") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const toLabels = (core.getInput("to_labels") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await advanceState(adapter, issueNumber, fromLabels, toLabels);
  core.info(`advance-state: ${fromLabels.join(",")} -> ${toLabels.join(",")}`);
}
