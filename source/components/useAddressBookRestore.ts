// Address-book restoration for a recipient picker that opens on its own
// (#1997): starts a relay sync on open, so contacts saved on another device
// show without a visit to Settings → Address book, and reports whether the
// list is confirmed or only this device's copy.
import { useCallback, useEffect, useState } from "react";
import { type PickerRestoreStatus, restoreForPicker } from "../lib/addressBook/restoreForPicker";
import { getAddressBook } from "../services/addressBook/AddressBookService";

export function useAddressBookRestore(active: boolean): {
  status: PickerRestoreStatus;
  retry: () => void;
} {
  const [status, setStatus] = useState<PickerRestoreStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs a read
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setStatus("loading");
    void getAddressBook()
      .then(async (book) => {
        if (cancelled) return;
        // The contacts themselves reach the picker through the book's
        // subscription; only the status is taken from here. A wallet switch
        // mid-read closes this book, which ends as "offline".
        await restoreForPicker(
          book,
          (_contacts, next) => setStatus(next),
          () => cancelled,
        );
      })
      .catch(() => {
        if (!cancelled) setStatus("offline");
      });
    return () => {
      cancelled = true;
    };
  }, [active, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { status, retry };
}
