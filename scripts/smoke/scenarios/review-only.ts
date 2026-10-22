import type { Scenario, ScenarioOutcome } from "../lib/types.js";

const TIMEOUT_MS = 12 * 60_000;
const REVIEW_MARKER = /<!-- shopfloor-review -->/;

const REVIEW_ONLY: Scenario = {
  id: "review-only",
  name: "Review-only flow",
  flaky: false,
  timeoutMs: TIMEOUT_MS,
  async run(ctx): Promise<ScenarioOutcome> {
    const branchName = `${ctx.tag.replace(/\//g, "-")}/readme-tweak`;

    const repoInfo = await ctx.gh.repos.get({
      owner: ctx.owner,
      repo: ctx.repo,
    });
    const defaultBranch = repoInfo.data.default_branch;
    const baseRef = await ctx.gh.git.getRef({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: `heads/${defaultBranch}`,
    });
    const baseSha = baseRef.data.object.sha;

    await ctx.gh.git.createRef({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    const readme = await ctx.gh.repos.getContent({
      owner: ctx.owner,
      repo: ctx.repo,
      path: "README.md",
      ref: branchName,
    });
    if (Array.isArray(readme.data) || readme.data.type !== "file") {
      throw new Error("README.md not found or not a file on default branch");
    }
    const fileSha = readme.data.sha;
    const decoded = Buffer.from(readme.data.content, "base64").toString(
      "utf-8",
    );
    const next = decoded.replace(/\n*$/, `\n\n<!-- smoke ${ctx.tag} -->\n`);
    await ctx.gh.repos.createOrUpdateFileContents({
      owner: ctx.owner,
      repo: ctx.repo,
      path: "README.md",
      branch: branchName,
      message: `${ctx.tag}: smoke readme tweak`,
      content: Buffer.from(next, "utf-8").toString("base64"),
      sha: fileSha,
    });

    const pr = await ctx.gh.pulls.create({
      owner: ctx.owner,
      repo: ctx.repo,
      title: `${ctx.tag} review-only: README tweak`,
      head: branchName,
      base: defaultBranch,
      body: `Smoke test PR for review-only flow. Tag: ${ctx.tag}`,
    });
    ctx.log(`+ PR #${pr.data.number} opened on ${branchName}`);

    await ctx.expectReviewByApp(
      pr.data.number,
      ctx.appLogins.review,
      REVIEW_MARKER,
      { timeoutMs: 10 * 60_000 },
    );

    await ctx.closePr(pr.data.number);
    await ctx.deleteBranch(branchName);

    return { kind: "pass" };
  },
};

export default REVIEW_ONLY;
