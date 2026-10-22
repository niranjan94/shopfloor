import type { Stage } from "./labels.js";

export interface PrMetadata {
  issueNumber: number;
  stage: Stage;
  reviewIteration: number;
  reviewErrorCount: number;
}

export interface IssueMetadata {
  slug?: string;
  specPath?: string;
  planPath?: string;
}

export interface StageBranchRef {
  stage: "spec" | "plan" | "impl";
  issueNumber: number;
  slug: string;
}

export function parsePrMetadata(
  body: string | null | undefined,
): PrMetadata | null {
  if (!body) return null;
  const issueMatch = body.match(/Shopfloor-Issue:\s*#(\d+)/);
  const stageMatch = body.match(
    /Shopfloor-Stage:\s*(spec|plan|implement|review)/,
  );
  const iterMatch = body.match(/Shopfloor-Review-Iteration:\s*(\d+)/);
  const errMatch = body.match(/Shopfloor-Review-Error-Count:\s*(\d+)/);
  if (!issueMatch || !stageMatch) return null;
  return {
    issueNumber: Number(issueMatch[1]),
    stage: stageMatch[1] as Exclude<Stage, "triage">,
    reviewIteration: iterMatch ? Number(iterMatch[1]) : 0,
    reviewErrorCount: errMatch ? Number(errMatch[1]) : 0,
  };
}

export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "issue";
}

// Canonical stage-branch shape for spec, plan, and impl branches:
// `shopfloor/<stage>/<issueNumber>-<slug>`. Returns null for malformed refs so
// revision-mode callers can fail closed. The stage is auto-detected from the
// branch prefix, so callers switch on the returned `.stage` field rather than
// passing a kind argument.
export function parseStageBranchRef(ref: string): StageBranchRef | null {
  const match = ref.match(/^shopfloor\/(spec|plan|impl)\/(\d+)-(.+)$/);
  if (!match) return null;
  const stageRaw = match[1];
  const issueRaw = match[2];
  const slug = match[3];
  if (!stageRaw || !issueRaw || !slug) return null;
  const stage = stageRaw as StageBranchRef["stage"];
  const issueNumber = Number(issueRaw);
  if (!Number.isFinite(issueNumber) || slug.length === 0) return null;
  return { stage, issueNumber, slug };
}

// The metadata block is a single HTML comment appended by the triage helper.
// HTML comments don't render in GitHub's web UI, so users see the block only
// if they edit the issue. The block's schema is open: extra keys are ignored
// so new metadata can be added later without breaking this parser.
export function parseIssueMetadata(
  body: string | null | undefined,
): IssueMetadata | null {
  if (!body) return null;
  const blockMatch = body.match(/<!--\s*shopfloor:metadata\s*([\s\S]*?)-->/);
  if (!blockMatch) return null;
  const block = blockMatch[1];
  if (!block) return null;
  const metadata: IssueMetadata = {};
  const slugMatch = block.match(/^\s*Shopfloor-Slug:\s*(\S+)\s*$/m);
  const slugVal = slugMatch?.[1];
  if (slugVal) metadata.slug = slugVal;
  const specPathMatch = block.match(/^\s*Shopfloor-Spec-Path:\s*(\S+)\s*$/m);
  const specPathVal = specPathMatch?.[1];
  if (specPathVal) metadata.specPath = specPathVal;
  const planPathMatch = block.match(/^\s*Shopfloor-Plan-Path:\s*(\S+)\s*$/m);
  const planPathVal = planPathMatch?.[1];
  if (planPathVal) metadata.planPath = planPathVal;
  return metadata;
}
