// GitHub's pulls.createReview is atomic: a single inline comment whose
// (path, line, side) doesn't fall on a line present in the PR's unified diff
// hunks rejects the entire call with "Unprocessable Entity: Line could not be
// resolved". Reviewers (LLM agents) sometimes guess a line outside the
// changed hunks. This module parses each file's patch into the set of valid
// line numbers per side so off-diff comments can be filtered before posting.

export interface DiffFilePatch {
  filename: string;
  patch?: string;
  status?: string;
}

export interface DiffPositions {
  left: Set<number>;
  right: Set<number>;
}

export interface ReviewCommentLike {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunkPositions(patch: string | undefined): DiffPositions {
  const positions: DiffPositions = { left: new Set(), right: new Set() };
  if (!patch) return positions;
  const lines = patch.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of lines) {
    const header = line.match(HUNK_HEADER);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      positions.right.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      positions.left.add(oldLine);
      oldLine++;
    } else if (line.startsWith(" ") || line === "") {
      // Context line: valid on both sides.
      positions.left.add(oldLine);
      positions.right.add(newLine);
      oldLine++;
      newLine++;
    } else {
      // Unknown marker (e.g. another hunk header handled above, or noise) —
      // bail out of hunk-tracking until the next header resets state.
      inHunk = false;
    }
  }
  return positions;
}

export function buildPositionMap(
  patches: DiffFilePatch[],
): Map<string, DiffPositions> {
  const map = new Map<string, DiffPositions>();
  for (const file of patches) {
    map.set(file.filename, parseHunkPositions(file.patch));
  }
  return map;
}

function commentFits(
  comment: ReviewCommentLike,
  positions: DiffPositions,
): boolean {
  const sideSet = (side: "LEFT" | "RIGHT") =>
    side === "LEFT" ? positions.left : positions.right;
  if (!sideSet(comment.side).has(comment.line)) return false;
  if (comment.start_line !== undefined) {
    const startSide = comment.start_side ?? comment.side;
    if (!sideSet(startSide).has(comment.start_line)) return false;
  }
  return true;
}

export function partitionCommentsByDiff<T extends ReviewCommentLike>(
  comments: T[],
  positionMap: Map<string, DiffPositions>,
): { valid: T[]; dropped: T[] } {
  const valid: T[] = [];
  const dropped: T[] = [];
  for (const c of comments) {
    const positions = positionMap.get(c.path);
    if (positions && commentFits(c, positions)) {
      valid.push(c);
    } else {
      dropped.push(c);
    }
  }
  return { valid, dropped };
}
