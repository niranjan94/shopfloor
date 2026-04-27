import type { IssueMetadata } from "../state";

export interface ArtifactPaths {
  specFilePath: string;
  planFilePath: string;
}

const CANONICAL_SPEC_DIR = "docs/shopfloor/specs";
const CANONICAL_PLAN_DIR = "docs/shopfloor/plans";

export function resolveArtifactPaths(
  issueNumber: number,
  slug: string,
  metadata: IssueMetadata | null,
): ArtifactPaths {
  return {
    specFilePath:
      metadata?.specPath ?? `${CANONICAL_SPEC_DIR}/${issueNumber}-${slug}.md`,
    planFilePath:
      metadata?.planPath ?? `${CANONICAL_PLAN_DIR}/${issueNumber}-${slug}.md`,
  };
}

export function validateOverridePath(path: string): void {
  if (path.length === 0) {
    throw new Error("override path must not be empty");
  }
  if (path.startsWith("/")) {
    throw new Error("override path must be a relative path (no leading '/')");
  }
  if (path.split("/").some((seg) => seg === "..")) {
    throw new Error("override path must not contain '..' segments");
  }
  if (!path.endsWith(".md")) {
    throw new Error("override path must end in '.md'");
  }
}
