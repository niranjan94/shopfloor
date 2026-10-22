import type { SdkTool } from "../../tools/types.js";
import type { StageContext } from "../_shared/context.js";

// Triage is read-only. The Claude SDK provides Read/Glob/Grep/WebFetch by
// default; we add no GitHub-mutation tools here. Progress updates do not
// apply because no pinned comment exists at triage time.
export function triageTools(_ctx: StageContext): SdkTool[] {
  return [];
}
