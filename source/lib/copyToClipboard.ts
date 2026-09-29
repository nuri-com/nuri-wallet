// @service copy
// App-wide copy: writes to the clipboard AND shows the shared DS "Copied" toast,
// so every copy affordance in the app gives the same confirmation. The toast
// renderer is supplied at runtime by <CopyToastBridge> (mounted in DsOverlayRoot,
// inside the DS ToastProvider) via registerCopiedToast — a plain module singleton
// so non-hook callers (onPress handlers, services) can trigger it too. If the
// bridge has not mounted yet, the clipboard write still happens silently.
import * as Clipboard from "expo-clipboard";

type CopiedToast = () => void;

let copiedToast: CopiedToast | null = null;

/** Called by <CopyToastBridge>. Pass null on unmount to clear the handler. */
export function registerCopiedToast(handler: CopiedToast | null): void {
  copiedToast = handler;
}

/** Copy `value` to the clipboard and show the shared "Copied" toast on success.
 *  Returns false when the write failed — callers with their own success UI must
 *  gate on the result. Never logs `value` (may be an address or card number). */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(value);
    copiedToast?.();
    return true;
  } catch (error) {
    console.warn("copyToClipboard failed", error instanceof Error ? error.message : error);
    return false;
  }
}
