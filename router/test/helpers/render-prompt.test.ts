import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { renderPrompt } from "../../src/prompt-render";
import {
  mergeAllowedTools,
  runRenderPrompt,
} from "../../src/helpers/render-prompt";

describe("renderPrompt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shopfloor-render-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("substitutes known keys", () => {
    const path = join(tmpDir, "p.md");
    writeFileSync(path, "Hello {{name}} from {{place}}.");
    const result = renderPrompt(path, {
      name: "Marvin",
      place: "Sirius Cybernetics",
    });
    expect(result).toBe("Hello Marvin from Sirius Cybernetics.");
  });

  test("marks missing keys", () => {
    const path = join(tmpDir, "p.md");
    writeFileSync(path, "Hello {{name}} from {{missing_key}}.");
    const result = renderPrompt(path, { name: "Marvin" });
    expect(result).toContain("{{MISSING:missing_key}}");
  });

  test("allows whitespace in placeholder", () => {
    const path = join(tmpDir, "p.md");
    writeFileSync(path, "Value: {{  spaced_key  }}");
    const result = renderPrompt(path, { spaced_key: "ok" });
    expect(result).toBe("Value: ok");
  });
});

describe("mergeAllowedTools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shopfloor-merge-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns base when settings file does not exist", () => {
    const result = mergeAllowedTools({
      baseAllowedTools: "Read,Glob,Grep",
      settingsFile: join(tmpDir, "does-not-exist.json"),
    });
    expect(result).toBe("Read,Glob,Grep");
  });

  test("merges permissions.allow into base, deduping", () => {
    const settingsFile = join(tmpDir, "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        permissions: {
          allow: ["Bash(pnpm install)", "WebFetch", "Read"],
        },
      }),
    );
    const result = mergeAllowedTools({
      baseAllowedTools: "Read,Glob,Grep",
      settingsFile,
    });
    const tools = new Set(result.split(","));
    expect(tools.has("Read")).toBe(true);
    expect(tools.has("Glob")).toBe(true);
    expect(tools.has("Grep")).toBe(true);
    expect(tools.has("Bash(pnpm install)")).toBe(true);
    expect(tools.has("WebFetch")).toBe(true);
    // Read appears once (deduped)
    expect(result.split(",").filter((t) => t === "Read").length).toBe(1);
  });

  test("filters out entries containing double quotes", () => {
    const settingsFile = join(tmpDir, "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({
        permissions: {
          allow: ['Bash(echo "hi")', "WebFetch"],
        },
      }),
    );
    const result = mergeAllowedTools({
      baseAllowedTools: "Read",
      settingsFile,
    });
    expect(result).not.toContain("Bash(echo");
    expect(result.split(",")).toContain("WebFetch");
  });

  test("tolerates missing permissions key", () => {
    const settingsFile = join(tmpDir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ someOtherKey: true }));
    const result = mergeAllowedTools({
      baseAllowedTools: "Read,Glob",
      settingsFile,
    });
    expect(result).toBe("Read,Glob");
  });

  test("handles malformed JSON gracefully", () => {
    const settingsFile = join(tmpDir, "settings.json");
    writeFileSync(settingsFile, "not-json{{{");
    const result = mergeAllowedTools({
      baseAllowedTools: "Read",
      settingsFile,
    });
    expect(result).toBe("Read");
  });

  test("empty base is fine", () => {
    const settingsFile = join(tmpDir, "settings.json");
    writeFileSync(
      settingsFile,
      JSON.stringify({ permissions: { allow: ["WebFetch"] } }),
    );
    const result = mergeAllowedTools({
      baseAllowedTools: "",
      settingsFile,
    });
    expect(result).toBe("WebFetch");
  });
});

describe("runRenderPrompt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shopfloor-run-render-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test("throws on unresolved placeholders", async () => {
    const promptPath = join(tmpDir, "prompt.md");
    writeFileSync(promptPath, "Hello {{name}} and {{unknown_var}}.");
    const contextPath = join(tmpDir, "context.json");
    writeFileSync(contextPath, JSON.stringify({ name: "Alice" }));

    vi.spyOn(core, "getInput").mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        prompt_file: promptPath,
        context_file: contextPath,
        context_json: "",
        base_allowed_tools: "",
        settings_file: join(tmpDir, "nonexistent-settings.json"),
      };
      return inputs[name] ?? "";
    });
    vi.spyOn(core, "setOutput").mockImplementation(() => {});

    const adapter = {} as Parameters<typeof runRenderPrompt>[0];
    await expect(runRenderPrompt(adapter)).rejects.toThrow(
      /unresolved placeholders.*unknown_var/,
    );
  });
});
