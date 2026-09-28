// Where the swap order behind a deposit address stands, while the page is open.
//
// A stranger funds the deposit from a wallet this app cannot see, so the order
// is the only thing that can answer "did it arrive". Polling stops the moment
// the order is terminal, and a status outage is not an answer — it keeps
// polling rather than declaring anything about the money.
import { useEffect, useState } from "react";
import { type PayOrderStatus, readPayOrderStatus } from "../../../services/pay/PayTargetService";

const POLL_MS = 12_000;

export function usePayOrderStatus(txId: string | null): PayOrderStatus | null {
  const [status, setStatus] = useState<PayOrderStatus | null>(null);

  useEffect(() => {
    if (!txId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setStatus({ state: "waiting", phase: null });

    const poll = async () => {
      try {
        const next = await readPayOrderStatus(txId);
        if (cancelled) return;
        setStatus(next);
        if (next.state !== "waiting") return;
      } catch {
        if (cancelled) return;
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [txId]);

  return status;
}
