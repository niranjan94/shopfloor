import { readFileSync } from "node:fs";

export function renderPrompt(
  filePath: string,
  context: Record<string, string>,
): string {
  const template = readFileSync(filePath, "utf-8");
  const missing = new Set<string>();
  const rendered = template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (match, key: string) => {
      if (key in context) return context[key] ?? "";
      missing.add(key);
      return match;
    },
  );
  if (missing.size > 0) {
    throw new Error(
      `render-prompt: unresolved placeholders: ${Array.from(missing).join(", ")}`,
    );
  }
  return rendered;
}
