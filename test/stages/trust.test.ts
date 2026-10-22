import { describe, expect, it } from "vitest";
import type { StageContext } from "../../src/stages/_shared/context.js";
import {
  formatTrustedIssueComments,
  isTrustedAuthor,
  promptSafeIssue,
  promptSafePrBody,
  type TrustPolicy,
  trustedReviews,
} from "../../src/stages/_shared/trust.js";
import { baseConfig } from "../_harness/config.js";

const policy: TrustPolicy = {
  associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  botLogins: ["shopfloor[bot]"],
};

function ctxWith(partial: Partial<StageContext>): StageContext {
  return {
    event: {} as never,
    repo: { owner: "octo", name: "demo" },
    defaultBranch: "main",
    decision: { stage: "triage" },
    github: {} as never,
    reviewGithub: null,
    agent: {} as never,
    audit: () => {},
    config: baseConfig,
    runId: "r1",
    ...partial,
  };
}

describe("isTrustedAuthor", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])("trusts %s", (association) => {
    expect(isTrustedAuthor({ login: "a", association }, policy)).toBe(true);
  });

  it.each([
    "CONTRIBUTOR",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "NONE",
  ])("does not trust %s", (association) => {
    expect(isTrustedAuthor({ login: "a", association }, policy)).toBe(false);
  });

  it("fails closed when the author or association is unknown", () => {
    expect(isTrustedAuthor(undefined, policy)).toBe(false);
    expect(isTrustedAuthor({ login: "a", association: null }, policy)).toBe(
      false,
    );
  });

  it("trusts configured bot logins case-insensitively regardless of association", () => {
    expect(
      isTrustedAuthor({ login: "Shopfloor[bot]", association: "NONE" }, policy),
    ).toBe(true);
    expect(
      isTrustedAuthor({ login: "renovate[bot]", association: "NONE" }, policy),
    ).toBe(false);
  });
});

describe("formatTrustedIssueComments", () => {
  it("keeps only trusted comments and returns empty when none remain", () => {
    const rows = [
      {
        user: { login: "owner" },
        created_at: "t1",
        body: "keep me",
        author_association: "OWNER",
      },
      {
        user: { login: "outsider" },
        created_at: "t2",
        body: "drop me",
        author_association: "NONE",
      },
    ];
    expect(formatTrustedIssueComments(rows, policy)).toBe(
      "**@owner** (t1):\nkeep me",
    );
    expect(formatTrustedIssueComments(rows.slice(1), policy)).toBe("");
  });
});

describe("trustedReviews", () => {
  it("drops reviews from untrusted authors", () => {
    const review = (login: string, association: string | null) => ({
      id: 1,
      user: { login },
      body: login,
      commit_id: "c",
      state: "changes_requested",
      submitted_at: null,
      author_association: association,
    });
    const kept = trustedReviews(
      [
        review("member", "MEMBER"),
        review("outsider", "NONE"),
        review("x", null),
      ],
      policy,
    );
    expect(kept.map((r) => r.body)).toEqual(["member"]);
  });
});

describe("promptSafeIssue / promptSafePrBody", () => {
  it("returns the original text for trusted authors", () => {
    const ctx = ctxWith({
      issue: {
        number: 1,
        title: "title",
        body: "body",
        labels: [],
        author: { login: "o", association: "OWNER" },
      },
      pr: {
        number: 2,
        title: "",
        body: "pr body",
        headRef: "h",
        headSha: "s",
        baseRef: "main",
        author: { login: "o", association: "COLLABORATOR" },
      },
    });
    expect(promptSafeIssue(ctx)).toEqual({ title: "title", body: "body" });
    expect(promptSafePrBody(ctx)).toBe("pr body");
  });

  it("replaces untrusted text with a notice that names the author", () => {
    const ctx = ctxWith({
      issue: {
        number: 1,
        title: "SECRET_TITLE",
        body: "SECRET_BODY",
        labels: [],
        author: { login: "outsider", association: "NONE" },
      },
      pr: {
        number: 2,
        title: "",
        body: "SECRET_PR",
        headRef: "h",
        headSha: "s",
        baseRef: "main",
      },
    });
    const issue = promptSafeIssue(ctx);
    expect(issue.title).not.toContain("SECRET_TITLE");
    expect(issue.body).not.toContain("SECRET_BODY");
    expect(issue.body).toContain("@outsider");
    expect(issue.body).toContain("NONE");
    expect(promptSafePrBody(ctx)).not.toContain("SECRET_PR");
  });

  it("honours a widened trusted_author_associations config", () => {
    const ctx = ctxWith({
      config: { ...baseConfig, trustedAuthorAssociations: ["CONTRIBUTOR"] },
      issue: {
        number: 1,
        title: "t",
        body: "b",
        labels: [],
        author: { login: "c", association: "CONTRIBUTOR" },
      },
    });
    expect(promptSafeIssue(ctx)).toEqual({ title: "t", body: "b" });
  });
});
