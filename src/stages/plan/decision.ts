import { z } from "zod";

export const PlanDecision = z.object({
  file_path: z.string().regex(/^docs\/shopfloor\/plans\/.+\.md$/, {
    message: "file_path must live under docs/shopfloor/plans/",
  }),
  plan_markdown: z.string().min(50),
  pr_title: z.string().min(5),
  pr_body: z.string().min(1),
  summary_for_issue_comment: z.string().min(1),
});
export type PlanDecision = z.infer<typeof PlanDecision>;
