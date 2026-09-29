import { Alert } from "react-native";

let installed = false;

/**
 * Globally suppress native Alert UI and log instead.
 * This keeps existing call sites intact but prevents any user-facing alerts.
 */
export function installAlertSuppression() {
  if (installed) return;
  installed = true;

  const anyAlert: any = Alert;
  anyAlert.alert = (...args: unknown[]) => {
    try {
      console.log("[AlertSuppressed]", ...args);
    } catch {
      // ignore logging errors
    }
  };
}
