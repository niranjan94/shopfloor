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
    const keys = Array.from(missing).sort().join(", ");
    throw new Error(
      `renderPrompt: unresolved placeholders in ${filePath}: ${keys}`,
    );
  }
  return rendered;
}
