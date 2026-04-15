/**
 * Parses the GITHUB_OUTPUT delimited file format `@actions/core` writes.
 * Format: `key<<DELIM\nvalue\nDELIM\n` (multi-line values supported).
 */
export function parseGithubOutput(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const m = header.match(/^([A-Za-z0-9_]+)<<(.+)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const delim = m[2];
    const valueLines: string[] = [];
    i++;
    while (i < lines.length && lines[i] !== delim) {
      valueLines.push(lines[i]);
      i++;
    }
    out[key] = valueLines.join("\n");
    i++; // skip the closing delim
  }
  return out;
}
