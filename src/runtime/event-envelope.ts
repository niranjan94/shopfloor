import type { EventPayload } from "../state/types.js";

/**
 * Runtime-agnostic event envelope.
 * Replaces GITHUB_EVENT_PATH / GITHUB_EVENT_NAME / GITHUB_REPOSITORY for
 * self-host and Vercel control-plane paths.
 */
export interface EventEnvelope {
  name: string;
  payload: EventPayload | Record<string, unknown>;
  deliveryId: string;
  installationId?: number;
  receivedAt: string;
}

export interface RepoRef {
  owner: string;
  name: string;
}

export function extractRepoFromPayload(
  payload: Record<string, unknown>,
): RepoRef | null {
  const repository = payload.repository as
    | { owner?: { login?: string }; name?: string }
    | undefined;
  const owner = repository?.owner?.login;
  const name = repository?.name;
  if (!owner || !name) return null;
  return { owner, name };
}

export function extractInstallationId(
  payload: Record<string, unknown>,
): number | undefined {
  const installation = payload.installation as { id?: number } | undefined;
  return typeof installation?.id === "number" ? installation.id : undefined;
}
