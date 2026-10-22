import { randomBytes } from "node:crypto";

export function newRunTag(now: Date = new Date()): string {
  const y = now.getUTCFullYear().toString().padStart(4, "0");
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = now.getUTCDate().toString().padStart(2, "0");
  const suffix = randomBytes(2).toString("hex");
  return `smoke-${y}${m}${d}-${suffix}`;
}

export function scenarioTag(runTag: string, scenarioId: string): string {
  return `${runTag}/${scenarioId}`;
}
