import { z } from "zod";

const SuppliedArtifactObject = z.object({
  source: z.enum(["body", "path"]),
  path: z.string().optional(),
  content: z.string().optional(),
});

// An artifact is only usable when it carries the field its source requires: a
// `path` source needs a non-empty `path`, a `body` source needs non-empty
// `content`. The agent occasionally emits a `source` without the matching
// field. Rather than fail the entire triage decision (which forces a manual
// label-removal retry), degrade the unusable artifact to `null` so triage
// completes and the stage runs normally. The downstream apply step already
// no-ops on a missing `path`/`content`, so nothing is lost.
const SuppliedArtifact = SuppliedArtifactObject.transform((v) => {
  if (v.source === "path") {
    return typeof v.path === "string" && v.path.length > 0 ? v : null;
  }
  return typeof v.content === "string" && v.content.length > 0 ? v : null;
});

export const TriageDecision = z.object({
  status: z.enum(["classified", "needs_clarification"]),
  complexity: z.enum(["quick", "medium", "large"]),
  rationale: z.string().min(1),
  clarifying_questions: z.array(z.string()).default([]),
  supplied_spec: SuppliedArtifact.nullable().default(null),
  supplied_plan: SuppliedArtifact.nullable().default(null),
});
export type TriageDecision = z.infer<typeof TriageDecision>;
export type SuppliedArtifact = z.infer<typeof SuppliedArtifactObject>;
