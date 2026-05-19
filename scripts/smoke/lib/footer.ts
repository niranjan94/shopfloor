import type { StageName } from "./types.js";

export interface PrFooter {
  issueNumber: number;
  stage: StageName;
  reviewIteration: number;
}

// Mirrors src/state/metadata.ts:parsePrMetadata. If the format changes in
// src/, update this file in lockstep. The runner intentionally does not
// import the production parser to keep scripts/smoke standalone.
export function parsePrFooter(
  body: string | null | undefined,
): PrFooter | null {
  if (!body) return null;
  const issueMatch = body.match(/Shopfloor-Issue:\s*#(\d+)/);
  const stageMatch = body.match(
    /Shopfloor-Stage:\s*(spec|plan|implement|review)/,
  );
  const iterMatch = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  if (!issueMatch || !stageMatch) return null;
  return {
    issueNumber: Number(issueMatch[1]),
    stage: stageMatch[1] as StageName,
    reviewIteration: iterMatch ? Number(iterMatch[1]) : 0,
  };
}
