/**
 * Checks that must pass immediately before a Lightning payment is funded (the
 * irreversible boundary), registered by the features that need them. A guard
 * that throws stops the payment with nothing sent.
 *
 * The eSIM service registers one: an eSIM order's invoice is recorded as
 * "send started" in its relay-backed record before the sats move, so a
 * restored wallet can never offer that invoice for a second payment.
 *
 * No imports on purpose: features register here without pulling in the send
 * service, and the send service calls here without knowing the features.
 */
export type LightningFundingGuard = (paymentHash: string) => Promise<void>;

const guards = new Set<LightningFundingGuard>();

export function registerLightningFundingGuard(guard: LightningFundingGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** Run every guard in turn; the first that throws stops the payment. */
export async function runLightningFundingGuards(paymentHash: string): Promise<void> {
  const hash = String(paymentHash || "").toLowerCase();
  for (const guard of [...guards]) await guard(hash);
}
