// When the live camera may deliver a code. It is held while one code is being
// handled, while a message shows, and for as long as the Upload picker is open.
// Only the end of whatever took the hold releases it: a message timer from an
// earlier rejection must not reopen the camera under a pending upload.

export const MESSAGE_MS = 2500;

export type ScanHold = {
  /** True while the camera must not deliver a code. */
  isHeld: () => boolean;
  /** Take the hold for one camera code. False when it is already held. */
  take: () => boolean;
  /** Release the camera now, unless an upload is pending. */
  release: () => void;
  /** Show a message, then release the camera, unless an upload is pending. */
  flash: (message: string) => void;
  /**
   * The picker opened: drop any pending message timer and hold until it
   * closes. Returns this upload's token; its result and cancel must carry it.
   */
  uploadOpen: () => number;
  /**
   * The picker returned a result. False (drop it) unless `token` is the
   * upload still pending, so a late photo from an earlier upload or an earlier
   * open of the sheet never takes a later one's place. True keeps the hold for
   * whatever handles the result.
   */
  uploadDone: (token: number) => boolean;
  /** The picker closed without a photo; ignored unless `token` is pending. */
  uploadCancel: (token: number) => void;
  /** The sheet opened: start free, no message, no pending upload. */
  reset: () => void;
  /**
   * The sheet is closing: the camera stays mounted through the exit
   * animation, so keep it held (no second scan of the same code) and drop
   * any pending message timer or upload.
   */
  close: () => void;
};

export function createScanHold(onMessage: (message: string | null) => void): ScanHold {
  let held = false;
  let uploading = false;
  let lastToken = 0;
  let pendingToken = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    isHeld: () => held,
    take: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      if (!uploading) held = false;
    },
    flash: (message) => {
      clearTimer();
      onMessage(message);
      timer = setTimeout(() => {
        timer = null;
        onMessage(null);
        if (!uploading) held = false;
      }, MESSAGE_MS);
    },
    uploadOpen: () => {
      clearTimer();
      onMessage(null);
      uploading = true;
      held = true;
      lastToken += 1;
      pendingToken = lastToken;
      return pendingToken;
    },
    uploadDone: (token) => {
      if (token !== pendingToken) return false;
      pendingToken = -1;
      uploading = false;
      return true;
    },
    uploadCancel: (token) => {
      if (token !== pendingToken) return;
      pendingToken = -1;
      uploading = false;
      held = false;
    },
    reset: () => {
      clearTimer();
      pendingToken = -1;
      uploading = false;
      held = false;
      onMessage(null);
    },
    close: () => {
      clearTimer();
      pendingToken = -1;
      uploading = false;
      held = true;
    },
  };
}
