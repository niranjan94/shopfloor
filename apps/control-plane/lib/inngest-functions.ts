import { createExecuteStageFunction, type StageJobPayload } from "./shopfloor";
import { inngest } from "./inngest";
import { handleStageJob } from "./runtime";

export const executeStageFn = createExecuteStageFunction({
  inngest,
  handler: async (job: StageJobPayload) => {
    await handleStageJob(job);
  },
});

export const inngestFunctions = [executeStageFn];
