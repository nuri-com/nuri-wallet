// Whether Settings is open. Kept outside the home screen so it survives the
// home remounting on a language change (the screen re-renders in the new
// language instead of closing under the user's finger).
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const openSettings = (): void => set(true);
export const closeSettings = (): void => set(false);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getOpen = (): boolean => open;

export function useSettingsOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpen, getOpen);
}
