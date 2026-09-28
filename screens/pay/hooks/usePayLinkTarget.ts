// The request state around one payable target: in flight, produced, or gone.
//
// The payment logic itself lives in services/pay/PayTargetService — this hook
// only decides which answer the screen is currently allowed to show.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PayTarget } from "../../../lib/pay/payTarget";
import type { PayRail } from "../../../lib/pay/selectPayRail";
import { buildPayTarget } from "../../../services/pay/PayTargetService";

/** `failed` means the rail was asked and produced nothing payable — the screen
 * carries that on the button, never as error text. */
export function usePayLinkTarget() {
  const [target, setTarget] = useState<PayTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only the newest request may write the target: a payer who switches rail
  // while a slow invoice is in flight must not be shown the old one.
  const requestIdRef = useRef(0);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    setTarget(null);
    setFailed(false);
    setBusy(false);
  }, []);

  const request = useCallback(
    async (rail: PayRail, amount: string | null, refundAddress?: string) => {
      const id = requestIdRef.current + 1;
      requestIdRef.current = id;
      setFailed(false);
      setBusy(true);
      try {
        const next = await buildPayTarget(rail, amount, refundAddress);
        if (requestIdRef.current !== id) return;
        setTarget(next);
        setFailed(next === null);
      } catch {
        if (requestIdRef.current !== id) return;
        setTarget(null);
        setFailed(true);
      } finally {
        if (requestIdRef.current === id) setBusy(false);
      }
    },
    [],
  );

  // A target with a deadline stops being payable the moment it passes it. A
  // page left open is the normal case here — the payer is switching to another
  // wallet to scan — so the invoice is dropped when it expires rather than left
  // on screen as a QR that only fails inside the payer's wallet. Dropping it
  // into `failed` puts the same "Try again" the screen already has in its
  // place, and that mints a fresh invoice.
  const expiresAtMs = target?.expiresAtMs ?? null;
  useEffect(() => {
    if (expiresAtMs === null) return;
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      setTarget(null);
      setFailed(true);
      return;
    }
    const timer = setTimeout(() => {
      setTarget(null);
      setFailed(true);
    }, remaining);
    return () => clearTimeout(timer);
  }, [expiresAtMs]);

  return { target, busy, failed, request, reset };
}
