import type { SdkTool } from "../../tools/types.js";
import type { StageContext } from "../_shared/context.js";

// Plan stage is design-only. No GitHub mutations and no file writes from the
// agent's side -- the apply step commits the markdown the agent emits via
// structured output.
export function planTools(_ctx: StageContext): SdkTool[] {
  return [];
}
