import * as core from '@actions/core';
import type { GitHubAdapter } from '../github';
import { renderPrompt } from '../prompt-render';

export async function runRenderPrompt(_adapter: GitHubAdapter): Promise<void> {
  const promptFile = core.getInput('prompt_file', { required: true });
  const contextJson = core.getInput('context_json', { required: true });
  let context: Record<string, string>;
  try {
    const parsed = JSON.parse(contextJson) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('context_json must be a JSON object');
    }
    context = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        k,
        v === null || v === undefined ? '' : String(v)
      ])
    );
  } catch (err) {
    throw new Error(
      `render-prompt: failed to parse context_json: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const rendered = renderPrompt(promptFile, context);
  if (rendered.includes('{{MISSING:')) {
    const missing = Array.from(rendered.matchAll(/\{\{MISSING:([a-zA-Z0-9_]+)\}\}/g)).map(
      (m) => m[1]
    );
    core.warning(`render-prompt: missing context keys: ${Array.from(new Set(missing)).join(', ')}`);
  }
  core.setOutput('rendered', rendered);
}
