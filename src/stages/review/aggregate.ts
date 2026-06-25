import type { Category, LensName, ReviewComment } from "./decision.js";
import {
  buildPositionMap,
  type DiffFilePatch,
  partitionCommentsByDiff,
} from "./diff-positions.js";
import type { LensOutcome } from "./runner.js";

export interface AggregateInput {
  outcomes: LensOutcome[];
  patches: DiffFilePatch[];
  currentIteration: number;
  maxIterations: number;
  confidenceThreshold: number;
  // Consecutive prior review runs that ended in `errored` (read from the PR
  // footer). Defaults to 0. When the incremented count reaches
  // `maxConsecutiveReviewErrors`, the errored outcome escalates so a human is
  // paged instead of the pipeline spinning on a persistent infrastructure
  // failure. Both are irrelevant (0 / infinity) in reviewOnly mode.
  currentErrorCount?: number;
  maxConsecutiveReviewErrors?: number;
}

export type AggregateOutcome =
  | {
      kind: "approve";
      body: string;
      successfulLenses: number;
    }
  | {
      kind: "request_changes";
      body: string;
      anchoredComments: ReviewComment[];
      droppedComments: ReviewComment[];
      nextIteration: number;
      lensWarnings: string[];
    }
  | {
      kind: "iteration_cap";
      maxIterations: number;
    }
  | {
      kind: "errored";
      body: string;
      failures: Array<{ lens: LensName; kind: string; message: string }>;
      // Consecutive errored runs including this one.
      errorCount: number;
      // True once errorCount reaches maxConsecutiveReviewErrors: stop retrying
      // silently and page a human via the review-stuck label.
      escalate: boolean;
    };

const SHOPFLOOR_REVIEW_MARKER = "<!-- shopfloor-review -->";

function renderLensFailure(f: {
  lens: LensName;
  kind: string;
  message: string;
}): string {
  return `- \`${f.lens}\` failed (${f.kind}): ${f.message}`;
}

const SOURCE_CATEGORY: Record<LensName, Category> = {
  compliance: "compliance",
  bugs: "bug",
  security: "security",
  smells: "smell",
};

function tokenOverlap(a: string, b: string): number {
  const aSet = new Set(
    a.slice(0, 200).toLowerCase().split(/\W+/).filter(Boolean),
  );
  const bSet = new Set(
    b.slice(0, 200).toLowerCase().split(/\W+/).filter(Boolean),
  );
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const t of aSet) if (bSet.has(t)) intersection++;
  return intersection / Math.min(aSet.size, bSet.size);
}

function dedupeComments(all: ReviewComment[]): ReviewComment[] {
  const keepers: ReviewComment[] = [];
  for (const c of all) {
    const duplicate = keepers.find(
      (k) =>
        k.path === c.path &&
        k.line === c.line &&
        k.side === c.side &&
        tokenOverlap(k.body, c.body) >= 0.75,
    );
    if (duplicate) {
      if (c.confidence > duplicate.confidence) {
        const idx = keepers.indexOf(duplicate);
        keepers[idx] = c;
      }
      continue;
    }
    keepers.push(c);
  }
  return keepers;
}

export function aggregateFindings(input: AggregateInput): AggregateOutcome {
  const succeeded: Array<{
    lens: LensName;
    decision: NonNullable<LensOutcome["decision"]>;
  }> = [];
  const failedLenses: Array<{ lens: LensName; kind: string; message: string }> =
    [];
  for (const o of input.outcomes) {
    if (o.decision) {
      succeeded.push({ lens: o.lens, decision: o.decision });
    } else if (o.error) {
      failedLenses.push({ lens: o.lens, ...o.error });
    }
  }

  const lensWarnings: string[] = [];
  for (const s of succeeded) {
    const expected = SOURCE_CATEGORY[s.lens];
    const outOfScope = s.decision.comments.filter(
      (c) => c.category !== expected,
    );
    if (outOfScope.length > 0) {
      lensWarnings.push(
        `${s.lens} reviewer returned ${outOfScope.length} out-of-scope comment(s) (expected category '${expected}')`,
      );
    }
  }

  // A `blocked` lens ran but could not inspect the diff, so its empty comment
  // set is not evidence of cleanliness. Treat it like a failure: it must not
  // contribute to an approval, and it is surfaced so the cause is visible.
  const blockedLenses = succeeded.filter(
    (s) => s.decision.verdict === "blocked",
  );

  // Every lens failed before returning a verdict (e.g. the Claude CLI never
  // installed, all agents timed out). There is no review result at all, so this
  // is an operational error rather than a "changes requested" verdict. Surface
  // it as such instead of blocking an unevaluated PR with a misleading
  // REQUEST_CHANGES review.
  if (succeeded.length === 0 && failedLenses.length > 0) {
    const errorCount = (input.currentErrorCount ?? 0) + 1;
    const maxErrors =
      input.maxConsecutiveReviewErrors ?? Number.POSITIVE_INFINITY;
    const escalate = errorCount >= maxErrors;
    const closing = escalate
      ? `This has now failed ${errorCount} consecutive times. A human should take over this PR.`
      : "This is an infrastructure error, not a code-review result. The pull request has not been evaluated and will be re-reviewed.";
    const body = [
      SHOPFLOOR_REVIEW_MARKER,
      "**Shopfloor agent review: could not complete.** Every reviewer failed before returning a verdict.",
      "",
      closing,
      "",
      "**Reviewer failures:**",
      ...failedLenses.map(renderLensFailure),
    ].join("\n");
    return {
      kind: "errored",
      body,
      failures: failedLenses,
      errorCount,
      escalate,
    };
  }

  const allComments = succeeded.flatMap((s) => s.decision.comments);
  const deduped = dedupeComments(allComments);
  const filtered = deduped.filter(
    (c) => c.confidence >= input.confidenceThreshold,
  );

  const allCleanVerdicts =
    succeeded.length > 0 &&
    succeeded.every((s) => s.decision.verdict === "clean");
  const noFilteredComments = filtered.length === 0;
  const noLensFailures = failedLenses.length === 0;
  const noBlockedLenses = blockedLenses.length === 0;

  // Approve only when every lens that ran returned clean AND no failures AND
  // no blocked (could-not-inspect) lenses AND no above-threshold findings
  // survived dedupe. Any lens failure or block forces request-changes so the
  // impl agent at least has a chance to address it.
  if (
    allCleanVerdicts &&
    noFilteredComments &&
    noLensFailures &&
    noBlockedLenses
  ) {
    const body = [
      SHOPFLOOR_REVIEW_MARKER,
      `**Shopfloor agent review: clean** across ${succeeded.length}/4 reviewers.`,
      "",
      succeeded.map((s) => `- ${s.decision.summary}`).join("\n"),
    ].join("\n");
    return { kind: "approve", body, successfulLenses: succeeded.length };
  }

  const nextIteration = input.currentIteration + 1;
  if (nextIteration > input.maxIterations) {
    return { kind: "iteration_cap", maxIterations: input.maxIterations };
  }

  const positionMap = buildPositionMap(input.patches);
  const { valid: anchored, dropped } = partitionCommentsByDiff(
    filtered,
    positionMap,
  );

  const bodyParts: string[] = [
    SHOPFLOOR_REVIEW_MARKER,
    `**Shopfloor agent review: changes requested** (iteration ${nextIteration}/${input.maxIterations}).`,
  ];
  if (succeeded.length > 0) {
    bodyParts.push("");
    bodyParts.push(succeeded.map((s) => `- ${s.decision.summary}`).join("\n"));
  }
  if (failedLenses.length > 0) {
    bodyParts.push("");
    bodyParts.push("**Lens failures:**");
    for (const f of failedLenses) {
      bodyParts.push(renderLensFailure(f));
    }
  }
  if (blockedLenses.length > 0) {
    bodyParts.push("");
    bodyParts.push("**Lenses blocked (could not inspect the diff):**");
    for (const b of blockedLenses) {
      bodyParts.push(`- \`${b.lens}\`: ${b.decision.summary}`);
    }
  }
  if (dropped.length > 0) {
    bodyParts.push("");
    bodyParts.push("**Findings dropped (line not in PR diff hunks):**");
    for (const c of dropped) {
      const sideMarker = c.side === "LEFT" ? " (LEFT)" : "";
      const firstLine = c.body.split("\n", 1)[0];
      bodyParts.push(
        `- \`${c.path}:${c.line}\`${sideMarker} [${c.category} / ${c.confidence}]: ${firstLine}`,
      );
    }
  }

  return {
    kind: "request_changes",
    body: bodyParts.join("\n"),
    anchoredComments: anchored,
    droppedComments: dropped,
    nextIteration,
    lensWarnings,
  };
}
