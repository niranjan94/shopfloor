import { Octokit } from "@octokit/rest";

const RETRY_BASE_MS = 1000;
const RETRY_MAX = 3;

export function makeGh(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "shopfloor-smoke-runner" });
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;
      const status = (err as { status?: number }).status;
      const code = (err as { code?: string }).code;
      const retriable =
        (status !== undefined && status >= 500) ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT";
      if (!retriable || attempt >= RETRY_MAX) throw err;
      const delay = RETRY_BASE_MS * attempt * attempt;
      console.warn(
        `[smoke/github] retrying ${label} after ${delay}ms (attempt ${attempt + 1}/${RETRY_MAX})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export async function deleteIssueGraphQL(
  gh: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const node = await gh.graphql<{
    repository: { issue: { id: string } | null } | null;
  }>(
    `query($owner:String!,$repo:String!,$num:Int!){
       repository(owner:$owner,name:$repo){ issue(number:$num){ id } }
     }`,
    { owner, repo, num: issueNumber },
  );
  const id = node.repository?.issue?.id;
  if (!id) {
    throw new Error(
      `deleteIssueGraphQL: cannot resolve node id for ${owner}/${repo}#${issueNumber}`,
    );
  }
  await gh.graphql(
    `mutation($id:ID!){ deleteIssue(input:{ issueId:$id }){ __typename } }`,
    { id },
  );
}
