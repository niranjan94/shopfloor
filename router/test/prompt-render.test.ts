import { expect, test } from 'vitest';
import { renderPrompt } from '../src/prompt-render';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');

const commonReviewContext: Record<string, string> = {
  repo_owner: 'niranjan94',
  repo_name: 'shopfloor',
  pr_number: '45',
  pr_title: 'Implementation for #42',
  pr_body: 'PR body',
  diff: 'diff --git a/src/auth.ts b/src/auth.ts\n@@ +const X = 1;',
  changed_files: 'src/auth.ts',
  spec_file_contents: 'spec',
  plan_file_contents: 'plan',
  issue_body: 'issue body',
  iteration_count: '0',
  previous_review_comments_json: '[]'
};

test('triage prompt renders with fixture context', () => {
  const rendered = renderPrompt(join(repoRoot, 'prompts/triage.md'), {
    issue_number: '42',
    issue_title: 'Add GitHub OAuth',
    issue_body: 'Users want to log in with GitHub.',
    issue_comments: '',
    repo_owner: 'niranjan94',
    repo_name: 'shopfloor',
    claude_md_contents: ''
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain('{{MISSING');
});

test('spec prompt renders with fixture context', () => {
  const rendered = renderPrompt(join(repoRoot, 'prompts/spec.md'), {
    issue_number: '42',
    issue_title: 'Add GitHub OAuth',
    issue_body: 'Users want to log in with GitHub.',
    issue_comments: '',
    triage_rationale: 'Large feature; auth touches multiple modules.',
    branch_name: 'shopfloor/spec/42-add-github-oauth',
    spec_file_path: 'docs/shopfloor/specs/42-add-github-oauth.md',
    repo_owner: 'niranjan94',
    repo_name: 'shopfloor',
    previous_spec_contents: '',
    review_comments_json: '[]'
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain('{{MISSING');
});

test('plan prompt renders with fixture context', () => {
  const rendered = renderPrompt(join(repoRoot, 'prompts/plan.md'), {
    issue_number: '42',
    issue_title: 'Add GitHub OAuth',
    issue_body: 'Users want to log in with GitHub.',
    branch_name: 'shopfloor/plan/42-add-github-oauth',
    plan_file_path: 'docs/shopfloor/plans/42-add-github-oauth.md',
    repo_owner: 'niranjan94',
    repo_name: 'shopfloor',
    spec_file_contents: '# Spec\nDetails here.',
    previous_plan_contents: '',
    review_comments_json: '[]'
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain('{{MISSING');
});

test('implement prompt renders with fixture context', () => {
  const rendered = renderPrompt(join(repoRoot, 'prompts/implement.md'), {
    issue_number: '42',
    issue_title: 'Add GitHub OAuth',
    issue_body: 'Users want to log in with GitHub.',
    spec_file_contents: '# Spec',
    plan_file_contents: '# Plan',
    branch_name: 'shopfloor/impl/42-add-github-oauth',
    progress_comment_id: '999',
    review_comments_json: '[]',
    iteration_count: '0',
    bash_allowlist: 'pnpm install,pnpm test:*',
    repo_owner: 'niranjan94',
    repo_name: 'shopfloor'
  });
  expect(rendered).toMatchSnapshot();
  expect(rendered).not.toContain('{{MISSING');
});

for (const name of ['review-compliance', 'review-bugs', 'review-security', 'review-smells']) {
  test(`${name} prompt renders with fixture context`, () => {
    const rendered = renderPrompt(join(repoRoot, `prompts/${name}.md`), commonReviewContext);
    expect(rendered).toMatchSnapshot();
    expect(rendered).not.toContain('{{MISSING');
  });
}
