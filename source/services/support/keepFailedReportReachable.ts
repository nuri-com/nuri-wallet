// Keeps a failed support report reachable until it is sent or the user lets
// it go (#1932). Its only entry is a toast, and the toast slot is
// replace-not-queue: a "Copied" toast or another move's pill can take it away
// at any moment. So "offered once" is never "still reachable": whenever the
// pill leaves the screen without being acted on, it is offered again once the
// slot has had time to free up.
import type { SupportReportState } from "../../lib/support/reportErrorToSupport";

/** Long enough for an ordinary toast (3.5 s) that replaced the pill to go. */
export const REPORT_REOFFER_MS = 4000;

export function keepFailedReportReachable(opts: {
  state: () => SupportReportState | null;
  /** False while a sheet or the chat owns the screen, or another pill the
   * user needs (a running move) holds the toast slot. */
  canShow: () => boolean;
  /** Show the pill; call `gone` when it leaves the screen without a tap. */
  show: (gone: () => void) => void;
  /** The report arrived after all: nothing left to keep. */
  onSent: () => void;
  /** Re-check on these signals (report changes, a surface closing). */
  subscribe: ReadonlyArray<(listener: () => void) => () => void>;
}): () => void {
  let onScreen = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const offer = () => {
    if (stopped) return;
    const state = opts.state()?.state;
    if (state === "sent") {
      opts.onSent();
      return;
    }
    if (state !== "failed" || onScreen) return;
    if (!opts.canShow()) {
      // Something else owns the screen or the slot: look again later, so a
      // slot that frees up without any signal still gets the pill back.
      if (!timer) timer = setTimeout(retry, REPORT_REOFFER_MS);
      return;
    }
    onScreen = true;
    opts.show(() => {
      if (stopped || !onScreen) return;
      onScreen = false;
      if (timer) clearTimeout(timer);
      timer = setTimeout(retry, REPORT_REOFFER_MS);
    });
  };
  const retry = () => {
    timer = null;
    offer();
  };
  const offs = opts.subscribe.map((subscribe) => subscribe(offer));
  offer();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
  };
}
