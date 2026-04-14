import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

export async function advanceState(
  adapter: GitHubAdapter,
  issueNumber: number,
  fromLabels: string[],
  toLabels: string[],
): Promise<void> {
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
