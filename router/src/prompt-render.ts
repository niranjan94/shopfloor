import { readFileSync } from "node:fs";

export function renderPrompt(
  filePath: string,
  context: Record<string, string>,
): string {
  const template = readFileSync(filePath, "utf-8");
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_, key: string) => {
      if (key in context) return context[key] ?? "";
      return `{{MISSING:${key}}}`;
    },
  );
}
