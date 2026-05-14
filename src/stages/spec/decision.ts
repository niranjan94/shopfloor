import { z } from "zod";

export const SpecDecision = z.object({
  file_path: z.string().regex(/^docs\/shopfloor\/specs\/.+\.md$/, {
    message: "file_path must live under docs/shopfloor/specs/",
  }),
  spec_markdown: z.string().min(50),
  pr_title: z.string().min(5),
  pr_body: z.string().min(1),
  summary_for_issue_comment: z.string().min(1),
});
export type SpecDecision = z.infer<typeof SpecDecision>;
