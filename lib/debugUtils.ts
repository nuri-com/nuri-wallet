import { useCallback, useState } from "react";
import * as Clipboard from "expo-clipboard";
import { Share } from "react-native";
import { shortTime } from "./logShared";
import { errMsg } from "./errorMessage";

export { shortTime };

export function useDebugLogs(tag: string) {
  const [logs, setLogs] = useState<string[]>([]);

  const appendLog = useCallback(
    (message: string) => {
      setLogs((prev) => {
        const line = `🧪 [${shortTime()} ${tag}] ${message}`;
        return [...prev.slice(-119), line];
      });
    },
    [tag],
  );

  const clearLogs = useCallback(() => {
    setLogs([`🧪 [${shortTime()} ${tag}] logs cleared`]);
  }, [tag]);

  const buildLogPayload = useCallback(
    (extra?: Record<string, string>) => {
      const lines = [
        `=== ${tag.toUpperCase()}_EXPORT ===`,
        ...(extra ? Object.entries(extra).map(([k, v]) => `${k}=${v}`) : []),
        `ts=${new Date().toISOString()}`,
        `log_count=${logs.length}`,
        "--- LOGS_START ---",
        ...logs,
        "--- LOGS_END ---",
      ];
      return lines.join("\n");
    },
    [logs, tag],
  );

  const handleCopyAllLogs = useCallback(
    async (extra?: Record<string, string>) => {
      const payload = buildLogPayload(extra);
      try {
        await Clipboard.setStringAsync(payload);
        appendLog(`copy all logs ok chars=${payload.length} lines=${payload.split("\n").length}`);
      } catch (error: unknown) {
        const msg = errMsg(error);
        appendLog(`copy all logs failed error=${msg}`);
      }
    },
    [appendLog, buildLogPayload],
  );

  const handleShareAllLogs = useCallback(
    async (extra?: Record<string, string>) => {
      const payload = buildLogPayload(extra);
      try {
        await Share.share({ message: payload });
        appendLog(`share all logs ok chars=${payload.length} lines=${payload.split("\n").length}`);
      } catch (error: unknown) {
        const msg = errMsg(error);
        appendLog(`share all logs failed error=${msg}`);
      }
    },
    [appendLog, buildLogPayload],
  );

  return {
    logs,
    setLogs,
    appendLog,
    clearLogs,
    buildLogPayload,
    handleCopyAllLogs,
    handleShareAllLogs,
  };
}
