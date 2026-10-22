import { z } from "zod";

export const LensName = z.enum(["compliance", "bugs", "security", "smells"]);
export type LensName = z.infer<typeof LensName>;

export const Category = z.enum(["compliance", "bug", "security", "smell"]);
export type Category = z.infer<typeof Category>;

// Mirrors v1's ReviewerOutput shape so the v1 lens prompts can be ported
// verbatim. The aggregator does dedupe, confidence filtering, and diff
// partitioning -- the schema does not enforce blockers/severity buckets.
export const ReviewComment = z.object({
  path: z.string().min(1),
  line: z.number().int().nonnegative(),
  side: z.enum(["LEFT", "RIGHT"]),
  start_line: z.number().int().nonnegative().optional(),
  start_side: z.enum(["LEFT", "RIGHT"]).optional(),
  body: z.string().min(1),
  confidence: z.number().int().min(0).max(100),
  category: Category,
});
export type ReviewComment = z.infer<typeof ReviewComment>;

// `blocked` is distinct from `clean`: it means the lens could not inspect the
// diff at all (e.g. the read-only git/Read commands failed in the sandbox), so
// its silence is not evidence of correctness. The aggregator never approves on
// a blocked lens. `clean` asserts the lens looked and found nothing.
export const LensDecision = z.object({
  verdict: z.enum(["clean", "issues_found", "blocked"]),
  summary: z.string().min(1),
  comments: z.array(ReviewComment).default([]),
});
export type LensDecision = z.infer<typeof LensDecision>;
