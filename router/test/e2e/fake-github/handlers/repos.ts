import type { FakeState } from "../state";

function nextTick(state: FakeState): number {
  return ++state.clock;
}

export function createCommitStatus(
  state: FakeState,
  params: {
    sha: string;
    state: "pending" | "success" | "failure" | "error";
    context: string;
    description: string;
    target_url?: string;
  },
): void {
  let perSha = state.statuses.get(params.sha);
  if (!perSha) {
    perSha = new Map();
    state.statuses.set(params.sha, perSha);
  }
  perSha.set(params.context, {
    sha: params.sha,
    context: params.context,
    state: params.state,
    description: params.description.slice(0, 140),
    targetUrl: params.target_url,
    updatedAt: `2026-04-15T00:00:${String(state.clock + 1).padStart(2, "0")}Z`,
  });
  state.eventLog.push({
    kind: "setStatus",
    sha: params.sha,
    context: params.context,
    t: nextTick(state),
  });
}
