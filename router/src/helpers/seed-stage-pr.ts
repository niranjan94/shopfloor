import type { GitHubAdapter } from "../github";

export interface SeedStagePrParams {
  issueNumber: number;
  slug: string;
  stage: "spec" | "plan";
  content: string;
  baseBranch: string;
  prTitle: string;
  prSummary: string;
}

export interface SeedStagePrResult {
  prNumber: number;
  url: string;
  branchName: string;
  filePath: string;
}

const DIR_FOR_STAGE: Record<SeedStagePrParams["stage"], string> = {
  spec: "docs/shopfloor/specs",
  plan: "docs/shopfloor/plans",
};

export async function seedStagePr(
  adapter: GitHubAdapter,
  params: SeedStagePrParams,
): Promise<SeedStagePrResult> {
  const { issueNumber, slug, stage, content, baseBranch, prTitle, prSummary } =
    params;
  const branchName = `shopfloor/${stage}/${issueNumber}-${slug}`;
  const filePath = `${DIR_FOR_STAGE[stage]}/${issueNumber}-${slug}.md`;

  const baseSha = await adapter.getRefSha(baseBranch);
  const created = await adapter.createRef(branchName, baseSha);

  // If the branch already existed (a retry path), the file may also already
  // be there. Look up the blob sha; if absent, getFileSha returns null and
  // we omit the sha so contents API treats this as a create.
  const existingSha = created
    ? null
    : await adapter.getFileSha(filePath, branchName);

  await adapter.putFileContents({
    path: filePath,
    branch: branchName,
    message: `docs(${stage}): seed ${stage} from issue #${issueNumber}`,
    content,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const pr = await adapter.openStagePr({
    base: baseBranch,
    head: branchName,
    title: prTitle,
    body: `${prSummary}\n\nRefs #${issueNumber}`,
    stage,
    issueNumber,
    preserveBodyIfExists: false,
  });

  return {
    prNumber: pr.number,
    url: pr.url,
    branchName,
    filePath,
  };
}
