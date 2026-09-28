import * as Application from "expo-application";
import Constants from "expo-constants";
import { APP_UPDATE_TIMEOUT_MS } from "../../config/constants";
import { UPDATE_BASE_URL } from "../../config/endpoints";
import { errMsg } from "../../lib/errorMessage";

function parseMustUpdateResponse(body: string): boolean {
  return (
    String(body || "")
      .trim()
      .toLowerCase() === "true"
  );
}

export function getNativeAppVersion(): string | null {
  try {
    const v = Application.nativeApplicationVersion;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

// Version of the currently-running JS bundle, read from the running manifest
// (mirrors `version`/`appVersion` in app.config.ts). An OTA ships a new
// manifest, so this moves with OTA — unlike getNativeAppVersion(), which reads
// the native Info.plist and stays fixed until a store build. This is what lets
// the must-update gate tell an OTA'd client apart from one still on the old
// bundle. Empty when the manifest is unavailable → the gate then does nothing
// (fails open), so an updated client is never wrongly locked.
export function getBundleAppVersion(): string {
  const v = Constants.expoConfig?.version;
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

export async function checkMustUpdateForVersion(
  version: string,
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  const trimmed = String(version || "").trim();
  if (!trimmed) return false;

  const timeoutMs = Math.max(250, Number(opts?.timeoutMs ?? APP_UPDATE_TIMEOUT_MS));
  const url = `${UPDATE_BASE_URL}/v1/must-update?version=${encodeURIComponent(trimmed)}`;

  let controller: AbortController | null = null;
  try {
    controller = new AbortController();
  } catch {
    controller = null;
  }

  let timeoutId: any = null;

  try {
    const fetchPromise = (async () => {
      const res = await fetch(url, {
        method: "GET",
        signal: controller?.signal,
      });

      if (!res.ok) return false;

      let text = "";
      try {
        text = await res.text();
      } catch {
        return false;
      }

      return parseMustUpdateResponse(text);
    })();

    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => {
        try {
          controller?.abort();
        } catch {}
        resolve(false);
      }, timeoutMs);
    });

    const result = await Promise.race([fetchPromise, timeoutPromise]);
    try {
      if (timeoutId) clearTimeout(timeoutId);
    } catch {}
    return result;
  } catch (err: unknown) {
    const msg = errMsg(err);
    try {
      console.log("[AppUpdateService] must-update check failed; defaulting to false", msg);
    } catch {}
    return false;
  } finally {
    try {
      if (timeoutId) clearTimeout(timeoutId);
    } catch {}
  }
}
