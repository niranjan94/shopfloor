import type { Stage } from "../state/labels.js";

export interface PrBodyArgs {
  issueNumber: number;
  stage: Stage;
  reviewIteration: number;
  userBody: string;
}

export function renderPrBodyWithMetadata(args: PrBodyArgs): string {
  const meta = [
    `Shopfloor-Issue: #${args.issueNumber}`,
    `Shopfloor-Stage: ${args.stage}`,
    `Shopfloor-Review-Iteration: ${args.reviewIteration}`,
  ].join("\n");
  return `${args.userBody.trimEnd()}\n\n<!-- shopfloor:metadata -->\n${meta}\n<!-- /shopfloor:metadata -->\n`;
}
