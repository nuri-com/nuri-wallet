import { useSyncExternalStore } from "react";
import { type AppLocale, getAppLocale, subscribeAppLocale } from "./index";

/** The current app language; re-renders the caller when it changes. */
export function useAppLocale(): AppLocale {
  return useSyncExternalStore(subscribeAppLocale, getAppLocale, getAppLocale);
}
