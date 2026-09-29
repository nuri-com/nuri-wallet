// How many sheets or layers are currently covering the app.
//
// Anything the user opens — a DS sheet via DsSheetHost, a full-cover Layer —
// means they are in the middle of something: a send, a swap, a card top-up. Not
// everything may interrupt that. Applying a downloaded OTA update in particular
// restarts the app, and doing that over a running swap kills it.
//
// The DS overlay registry is write-only (register/update/unregister), so the
// two app-side wrappers every surface goes through count themselves here
// instead. Zero means the user is looking at a bare tab screen.

let openCount = 0;
const listeners = new Set<(open: number) => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener(openCount);
    } catch {}
  }
}

/** Called by DsSheetHost / Layer while they are visible. */
export function noteSurfaceOpened(): () => void {
  openCount += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCount = Math.max(0, openCount - 1);
    emit();
  };
}

export function hasOpenSurface(): boolean {
  return openCount > 0;
}

export function subscribeOpenSurfaces(listener: (open: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
