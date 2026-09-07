import { createExecuteStageFunction, type StageJobPayload } from "./shopfloor.js";
import { inngest } from "./inngest.js";
import { handleStageJob } from "./runtime.js";

export const executeStageFn = createExecuteStageFunction({
  inngest,
  handler: async (job: StageJobPayload) => {
    await handleStageJob(job);
  },
});

export const inngestFunctions = [executeStageFn];
