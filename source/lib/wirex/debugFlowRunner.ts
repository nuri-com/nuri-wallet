import { errMsg } from "../errorMessage";

export type WirexDebugRunnerStatus = "ok" | "action_required" | "failed" | "skipped";

export type WirexDebugRunnerStepResult = {
  key: string;
  title: string;
  status: WirexDebugRunnerStatus;
  note: string;
};

export type WirexDebugRunnerStep = {
  key: string;
  title: string;
  run: () => Promise<{
    status: WirexDebugRunnerStatus;
    note: string;
  }>;
};

export const runWirexDebugFlowSteps = async (
  steps: WirexDebugRunnerStep[],
  onProgress?: (result: WirexDebugRunnerStepResult) => void,
): Promise<WirexDebugRunnerStepResult[]> => {
  const results: WirexDebugRunnerStepResult[] = [];

  for (const step of steps) {
    try {
      const outcome = await step.run();
      const result: WirexDebugRunnerStepResult = {
        key: step.key,
        title: step.title,
        status: outcome.status,
        note: outcome.note,
      };
      results.push(result);
      onProgress?.(result);
      if (outcome.status !== "ok") {
        break;
      }
    } catch (error: unknown) {
      const message = errMsg(error);
      const result: WirexDebugRunnerStepResult = {
        key: step.key,
        title: step.title,
        status: "failed",
        note: message,
      };
      results.push(result);
      onProgress?.(result);
      break;
    }
  }

  return results;
};
