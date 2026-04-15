import { expect, test } from "vitest";
import { renderPrompt } from "../src/prompt-render";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");

const commonReviewContext: Record<string, string> = {
  repo_owner: "niranjan94",
  repo_name: "shopfloor",
  pr_number: "45",
  pr_title: "Implementation for #42",
  pr_body: "PR body",
  diff: "diff --git a/src/auth.ts b/src/auth.ts\n@@ +const X = 1;",
  changed_files: "src/auth.ts",
  plan_file_contents: "plan",
  issue_body: "issue body",
  iteration_count: "0",
  previous_review_comments_json: "[]",
};

test("triage prompt renders with fixture context", () => {
  const rendered = renderPrompt(join(repoRoot, "prompts/triage.md"), {
    issue_number: "42",
    issue_title: "Add GitHub OAuth",
    issue_body: "Users want to log in with GitHub.",
    issue_comments: "",
    repo_owner: "niranjan94",
    repo_name: "shopfloor",
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain("{{MISSING");
});

test("spec prompt renders with fixture context", () => {
  const rendered = renderPrompt(join(repoRoot, "prompts/spec.md"), {
    issue_number: "42",
    issue_title: "Add GitHub OAuth",
    issue_body: "Users want to log in with GitHub.",
    issue_comments: "",
    triage_rationale: "Large feature; auth touches multiple modules.",
    branch_name: "shopfloor/spec/42-add-github-oauth",
    spec_file_path: "docs/shopfloor/specs/42-add-github-oauth.md",
    repo_owner: "niranjan94",
    repo_name: "shopfloor",
    previous_spec_contents: "",
    review_comments_json: "[]",
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain("{{MISSING");
});

test("plan prompt renders with fixture context (large flow: spec present)", () => {
  const rendered = renderPrompt(join(repoRoot, "prompts/plan.md"), {
    issue_number: "42",
    issue_title: "Add GitHub OAuth",
    issue_body: "Users want to log in with GitHub.",
    issue_comments: "",
    branch_name: "shopfloor/plan/42-add-github-oauth",
    plan_file_path: "docs/shopfloor/plans/42-add-github-oauth.md",
    repo_owner: "niranjan94",
    repo_name: "shopfloor",
    spec_source:
      "<spec_file_contents>\n# Spec\nDetails here.\n</spec_file_contents>",
    previous_plan_contents: "",
    review_comments_json: "[]",
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain("{{MISSING");
});

test("plan prompt renders with fixture context (medium flow: no spec)", () => {
  const rendered = renderPrompt(join(repoRoot, "prompts/plan.md"), {
    issue_number: "42",
    issue_title: "Add a /health endpoint",
    issue_body: "Expose /health returning 200 OK.",
    issue_comments: "",
    branch_name: "shopfloor/plan/42-add-health-endpoint",
    plan_file_path: "docs/shopfloor/plans/42-add-health-endpoint.md",
    repo_owner: "niranjan94",
    repo_name: "shopfloor",
    spec_source:
      "<spec_source>\nThere is no spec for this issue. This is the medium-complexity flow, which skips the spec stage by design. Derive the design directly from the <issue_body> and <issue_comments> above, then write the plan as usual.\n</spec_source>",
    previous_plan_contents: "",
    review_comments_json: "[]",
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain("{{MISSING");
});

test("implement prompt renders with fixture context", () => {
  const rendered = renderPrompt(join(repoRoot, "prompts/implement.md"), {
    issue_number: "42",
    issue_title: "Add GitHub OAuth",
    issue_body: "Users want to log in with GitHub.",
    issue_comments: "",
    spec_source: "<spec_file_contents>\n# Spec\n</spec_file_contents>",
    plan_file_contents: "# Plan",
    branch_name: "shopfloor/impl/42-add-github-oauth",
    progress_comment_id: "999",
    review_comments_json: "[]",
    iteration_count: "0",
    bash_allowlist: "pnpm install,pnpm test:*",
    repo_owner: "niranjan94",
    repo_name: "shopfloor",
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain("{{MISSING");
});

test("implement-quick prompt renders with fixture context", () => {
  const rendered = renderPrompt(join(repoRoot, "prompts/implement-quick.md"), {
    issue_number: "42",
    issue_title: "Fix typo in README",
    issue_body: "There is a typo on line 3 of README.md.",
    issue_comments: "",
    branch_name: "shopfloor/impl/42-fix-typo-in-readme",
    progress_comment_id: "999",
    review_comments_json: "[]",
    iteration_count: "0",
    bash_allowlist: "pnpm install,pnpm test:*",
    repo_owner: "niranjan94",
    repo_name: "shopfloor",
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain("{{MISSING");
});

test("renderPrompt throws on unresolved placeholders", () => {
  const tmp = mkdtempSync(join(tmpdir(), "prompt-render-"));
  const file = join(tmp, "test.md");
  writeFileSync(file, "Hello {{ name }}, your role is {{ role }}.");
  try {
    expect(() => renderPrompt(file, { name: "Alice" })).toThrowError(
      /unresolved placeholders.*role/,
    );
  } finally {
    rmSync(tmp, { recursive: true });
  }
});

for (const name of [
  "review-compliance",
  "review-bugs",
  "review-security",
  "review-smells",
]) {
  test(`${name} prompt renders with fixture context`, () => {
    const rendered = renderPrompt(
      join(repoRoot, `prompts/${name}.md`),
      commonReviewContext,
    );
    expect(rendered).toMatchSnapshot();
    expect(rendered).not.toContain("{{MISSING");
  });
}
