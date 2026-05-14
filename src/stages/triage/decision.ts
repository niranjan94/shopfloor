import { z } from "zod";

const SuppliedArtifact = z
  .object({
    source: z.enum(["body", "path"]),
    path: z.string().optional(),
    content: z.string().optional(),
  })
  .refine(
    (v) => (v.source === "path" ? typeof v.path === "string" && v.path.length > 0 : true),
    { message: "path is required when source='path'" },
  )
  .refine(
    (v) =>
      v.source === "body" ? typeof v.content === "string" && v.content.length > 0 : true,
    { message: "content is required when source='body'" },
  );

export const TriageDecision = z.object({
  status: z.enum(["classified", "needs_clarification"]),
  complexity: z.enum(["quick", "medium", "large"]),
  rationale: z.string().min(1),
  clarifying_questions: z.array(z.string()).default([]),
  supplied_spec: SuppliedArtifact.nullable().default(null),
  supplied_plan: SuppliedArtifact.nullable().default(null),
});
export type TriageDecision = z.infer<typeof TriageDecision>;
export type SuppliedArtifact = z.infer<typeof SuppliedArtifact>;
