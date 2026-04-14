import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";

const LABEL_DEFS: Array<{ name: string; color: string; description: string }> =
  [
    {
      name: "shopfloor:triaging",
      color: "fbca04",
      description: "Shopfloor triage agent is evaluating this issue.",
    },
    {
      name: "shopfloor:awaiting-info",
      color: "d93f0b",
      description:
        "Shopfloor is waiting for the issue author to answer clarifying questions.",
    },
    {
      name: "shopfloor:quick",
      color: "0e8a16",
      description: "Classified as a quick fix (straight to implementation).",
    },
    {
      name: "shopfloor:medium",
      color: "1d76db",
      description: "Classified as medium (skip spec, go to plan).",
    },
    {
      name: "shopfloor:large",
      color: "5319e7",
      description: "Classified as large (full spec, plan, impl flow).",
    },
    {
      name: "shopfloor:needs-spec",
      color: "a2eeef",
      description: "Ready for the spec agent.",
    },
    {
      name: "shopfloor:spec-in-review",
      color: "a2eeef",
      description: "Spec PR awaiting human review.",
    },
    {
      name: "shopfloor:needs-plan",
      color: "a2eeef",
      description: "Ready for the plan agent.",
    },
    {
      name: "shopfloor:plan-in-review",
      color: "a2eeef",
      description: "Plan PR awaiting human review.",
    },
    {
      name: "shopfloor:needs-impl",
      color: "a2eeef",
      description: "Ready for the implementation agent.",
    },
    {
      name: "shopfloor:needs-review",
      color: "a2eeef",
      description: "Implementation complete, agent review queued.",
    },
    {
      name: "shopfloor:review-requested-changes",
      color: "e99695",
      description: "Agent review requested changes; impl will re-run.",
    },
    {
      name: "shopfloor:review-approved",
      color: "0e8a16",
      description: "Agent review passed; ready for human merge.",
    },
    {
      name: "shopfloor:review-stuck",
      color: "b60205",
      description: "Review loop exceeded iteration cap; needs human.",
    },
    {
      name: "shopfloor:impl-in-review",
      color: "a2eeef",
      description: "Impl PR awaiting human review (skip-review case).",
    },
    {
      name: "shopfloor:skip-review",
      color: "ededed",
      description: "Bypass the agent review stage for this ticket.",
    },
    {
      name: "shopfloor:done",
      color: "0e8a16",
      description: "Implementation merged. Pipeline complete.",
    },
    {
      name: "shopfloor:revise",
      color: "ededed",
      description: "Manual trigger to re-run the current stage.",
    },
    {
      name: "shopfloor:failed:triage",
      color: "b60205",
      description: "Triage stage failed.",
    },
    {
      name: "shopfloor:failed:spec",
      color: "b60205",
      description: "Spec stage failed.",
    },
    {
      name: "shopfloor:failed:plan",
      color: "b60205",
      description: "Plan stage failed.",
    },
    {
      name: "shopfloor:failed:implement",
      color: "b60205",
      description: "Implementation stage failed.",
    },
    {
      name: "shopfloor:failed:review",
      color: "b60205",
      description: "Review stage failed.",
    },
  ];

export async function bootstrapLabels(
  adapter: GitHubAdapter,
): Promise<string[]> {
  const existing = new Set(await adapter.listRepoLabels());
  const created: string[] = [];
  for (const def of LABEL_DEFS) {
    if (existing.has(def.name)) continue;
    await adapter.createLabel(def.name, def.color, def.description);
    created.push(def.name);
  }
  return created;
}

export async function runBootstrapLabels(
  adapter: GitHubAdapter,
): Promise<void> {
  const created = await bootstrapLabels(adapter);
  core.info(`Shopfloor bootstrap: created ${created.length} missing labels`);
  core.setOutput("created_labels", JSON.stringify(created));
}
