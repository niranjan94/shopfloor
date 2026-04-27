const OPENER = "<!-- shopfloor:metadata";
const CLOSER = "-->";
// Match a well-formed block (opener ... closer) anywhere in the body.
const WELL_FORMED_BLOCK = /<!--\s*shopfloor:metadata[\s\S]*?-->/;
// Match a malformed block that has the opener but no closer. Used as a
// repair path so a previous broken write can be fixed idempotently instead
// of stacking a second block on top of it.
const MALFORMED_TAIL = /<!--\s*shopfloor:metadata[\s\S]*$/;

function renderBlock(fields: Record<string, string>): string {
  const lines = [OPENER];
  if (fields.slug !== undefined) lines.push(`Shopfloor-Slug: ${fields.slug}`);
  if (fields.specPath !== undefined)
    lines.push(`Shopfloor-Spec-Path: ${fields.specPath}`);
  if (fields.planPath !== undefined)
    lines.push(`Shopfloor-Plan-Path: ${fields.planPath}`);
  lines.push(CLOSER);
  return lines.join("\n");
}

export function upsertIssueMetadata(
  body: string | null,
  fields: Record<string, string>,
): string {
  const block = renderBlock(fields);
  if (body === null || body.length === 0) return block;
  if (WELL_FORMED_BLOCK.test(body)) {
    return body.replace(WELL_FORMED_BLOCK, block);
  }
  if (MALFORMED_TAIL.test(body)) {
    return body.replace(MALFORMED_TAIL, block);
  }
  // No block present: append with a blank line separator so the original
  // body formatting stays intact.
  const sep = body.endsWith("\n") ? "\n" : "\n\n";
  return `${body}${sep}${block}`;
}
