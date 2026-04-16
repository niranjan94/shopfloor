import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as core from "@actions/core";
import type { GitHubAdapter } from "../github";
import { renderPrompt } from "../prompt-render";

/**
 * Resolve a prompt file path. If the path is absolute and exists, return it as-is.
 * Otherwise, try the path relative to the current working directory, then relative
 * to `$GITHUB_ACTION_PATH/..` so callers can pass `prompts/triage.md` without
 * caring whether the shopfloor repo has been checked out at the workspace root.
 */
export function resolvePromptFile(promptFile: string): string {
  if (isAbsolute(promptFile) && existsSync(promptFile)) return promptFile;
  if (existsSync(promptFile)) return promptFile;
  const actionPath = process.env.GITHUB_ACTION_PATH;
  if (actionPath) {
    core.info(
      `resolvePromptFile: GITHUB_ACTION_PATH=${actionPath}, trying sibling and self paths`,
    );
    const fromActionSibling = join(actionPath, "..", promptFile);
    core.info(
      `resolvePromptFile: sibling=${fromActionSibling} exists=${existsSync(fromActionSibling)}`,
    );
    if (existsSync(fromActionSibling)) return fromActionSibling;
    const fromActionSelf = join(actionPath, promptFile);
    core.info(
      `resolvePromptFile: self=${fromActionSelf} exists=${existsSync(fromActionSelf)}`,
    );
    if (existsSync(fromActionSelf)) return fromActionSelf;
  } else {
    core.info("resolvePromptFile: GITHUB_ACTION_PATH is not set");
  }
  core.warning(
    `resolvePromptFile: could not find ${promptFile} in any search path, returning as-is`,
  );
  return promptFile;
}

function parseContextJson(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("context must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
      k,
      v === null || v === undefined ? "" : String(v),
    ]),
  );
}

export interface MergeAllowedToolsOptions {
  baseAllowedTools: string;
  settingsFile: string;
}

export function mergeAllowedTools(options: MergeAllowedToolsOptions): string {
  const base = options.baseAllowedTools
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = new Set(base);

  if (!existsSync(options.settingsFile)) {
    return Array.from(merged).join(",");
  }

  let projectTools: string[] = [];
  try {
    const settings = JSON.parse(
      readFileSync(options.settingsFile, "utf-8"),
    ) as unknown;
    const allow = (settings as { permissions?: { allow?: unknown } })
      ?.permissions?.allow;
    if (Array.isArray(allow)) {
      // Exclude entries that contain `"` — they would escape out of the double-quoted
      // --allowedTools shell argument and corrupt the args string.
      projectTools = allow.filter(
        (t): t is string =>
          typeof t === "string" && t.length > 0 && !t.includes('"'),
      );
    }
  } catch (err) {
    core.warning(
      `render-prompt: failed to parse ${options.settingsFile}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Array.from(merged).join(",");
  }

  if (projectTools.length > 0) {
    core.info(
      `render-prompt: merged ${projectTools.length} project permission(s) from ${options.settingsFile} into allowed tools`,
    );
  }
  for (const t of projectTools) merged.add(t);
  return Array.from(merged).join(",");
}

export async function runRenderPrompt(_adapter: GitHubAdapter): Promise<void> {
  const promptFile = core.getInput("prompt_file", { required: true });
  const contextFile = core.getInput("context_file");
  const contextJson = core.getInput("context_json");
  const baseAllowedTools = core.getInput("base_allowed_tools");
  const settingsFile =
    core.getInput("settings_file") || ".claude/settings.json";

  if (!contextFile && !contextJson) {
    throw new Error(
      "render-prompt: either context_file or context_json is required",
    );
  }

  let rawContext: string;
  if (contextFile) {
    rawContext = readFileSync(contextFile, "utf-8");
  } else {
    rawContext = contextJson;
  }

  let context: Record<string, string>;
  try {
    context = parseContextJson(rawContext);
  } catch (err) {
    throw new Error(
      `render-prompt: failed to parse context: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const resolvedPromptFile = resolvePromptFile(promptFile);
  const rendered = renderPrompt(resolvedPromptFile, context);
  if (rendered.includes("{{MISSING:")) {
    const missing = Array.from(
      rendered.matchAll(/\{\{MISSING:([a-zA-Z0-9_]+)\}\}/g),
    ).map((m) => m[1]);
    core.warning(
      `render-prompt: missing context keys: ${Array.from(new Set(missing)).join(", ")}`,
    );
  }
  core.setOutput("rendered", rendered);

  const allowedTools = mergeAllowedTools({
    baseAllowedTools: baseAllowedTools,
    settingsFile,
  });
  core.setOutput("allowed_tools", allowedTools);
}
