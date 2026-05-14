import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function readPrompt(metaUrl: string, file: string): string {
  const here = dirname(fileURLToPath(metaUrl));
  return readFileSync(join(here, file), "utf8");
}

export function renderTemplate(
  tpl: string,
  vars: Record<string, unknown>,
): string {
  return tpl.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (_match, key: string) => {
      if (!(key in vars)) {
        throw new Error(`renderTemplate: missing variable "${key}"`);
      }
      const v = vars[key];
      return typeof v === "string" ? v : JSON.stringify(v);
    },
  );
}
