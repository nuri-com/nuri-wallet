// Factory for screen-level structured loggers — replaces inline logXxxScreen/warnXxxScreen/errorXxxScreen
import { logWithId, warnWithId, errorWithId, LOG_EMOJI } from "./OperationLogUtils";

type LogOpts = {
  context?: "user" | "poll" | "background" | "system";
  result?: string;
  event?: any;
  flow?: string;
};

export function createScreenLogger(tag: string, emoji?: string) {
  const resolvedEmoji = emoji || "";

  return {
    log(action: string, message: string, extra?: any, opts?: LogOpts) {
      logWithId(`${resolvedEmoji} ${tag}.${action}`, message, extra, {
        scope: tag,
        screen: tag,
        action,
        source: `screens/${tag}.tsx#${action}`,
        context: opts?.context,
        result: opts?.result,
        event: opts?.event,
        flow: opts?.flow,
      });
    },
    warn(action: string, message: string, extra?: any, opts?: LogOpts) {
      warnWithId(`${resolvedEmoji} ${tag}.${action}`, message, extra, {
        scope: tag,
        screen: tag,
        action,
        source: `screens/${tag}.tsx#${action}`,
        context: opts?.context,
        result: opts?.result,
        event: opts?.event,
        flow: opts?.flow,
      });
    },
    error(action: string, message: string, extra?: any, opts?: LogOpts) {
      errorWithId(`${resolvedEmoji} ${tag}.${action}`, message, extra, {
        scope: tag,
        screen: tag,
        action,
        source: `screens/${tag}.tsx#${action}`,
        context: opts?.context,
        result: opts?.result,
        event: opts?.event,
        flow: opts?.flow,
      });
    },
  };
}

export { LOG_EMOJI };
