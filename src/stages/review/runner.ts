import type { StageContext } from "../_shared/context.js";
import type { LensDecision, LensName } from "./decision.js";
import { runComplianceLens } from "./lenses/compliance/runner.js";
import { runBugsLens } from "./lenses/bugs/runner.js";
import { runSecurityLens } from "./lenses/security/runner.js";
import { runSmellsLens } from "./lenses/smells/runner.js";
import type { LensRunnerArgs } from "./lenses/shared.js";

export interface LensOutcome {
  lens: LensName;
  decision: LensDecision | null;
  error: { kind: string; message: string } | null;
}

const LENSES: ReadonlyArray<
  readonly [LensName, (ctx: StageContext, args: LensRunnerArgs) => Promise<LensDecision>]
> = [
  ["compliance", runComplianceLens],
  ["bugs", runBugsLens],
  ["security", runSecurityLens],
  ["smells", runSmellsLens],
];

// Fan all four lenses out via Promise.allSettled so a single lens failure
// (timeout, budget, output validation) does not abort the siblings. The
// aggregator treats any lens failure as a request-changes signal.
export async function runReview(
  ctx: StageContext,
  args: LensRunnerArgs,
): Promise<LensOutcome[]> {
  const results = await Promise.allSettled(
    LENSES.map(([_, fn]) => fn(ctx, args)),
  );
  return results.map((r, i) => {
    const entry = LENSES[i]!;
    const name = entry[0];
    if (r.status === "fulfilled") {
      return { lens: name, decision: r.value, error: null };
    }
    const reason = r.reason as { kind?: string; message?: string } | undefined;
    return {
      lens: name,
      decision: null,
      error: {
        kind: reason?.kind ?? "agent_execution",
        message: String(reason?.message ?? r.reason),
      },
    };
  });
}
