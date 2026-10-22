import { z } from "zod";

// Mirrors v1's TriageOutput shape for the implement agent. CC validation
// is permissive: only require a recognized prefix; allow optional scope and
// trailing issue-reference parens.
const CC_PREFIX_RE =
  /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?:\s+.+/i;

export const ImplementDecision = z.object({
  pr_title: z
    .string()
    .min(5)
    .refine((s) => CC_PREFIX_RE.test(s), {
      message:
        "pr_title must follow Conventional Commits (type(scope)?: subject)",
    }),
  pr_body: z.string().min(1),
  summary_for_issue_comment: z.string().min(1),
  changed_files: z.array(z.string().min(1)).default([]),
});
export type ImplementDecision = z.infer<typeof ImplementDecision>;
