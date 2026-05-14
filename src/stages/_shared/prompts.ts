// Prompt files are inlined as text imports at build time (esbuild text loader)
// and at test time (vitest inline-text plugin), so no runtime fs read is
// needed. renderTemplate stays — it interpolates `{{ key }}` placeholders
// from the inlined prompt strings.

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
