// A move into this wallet's own Lightning balance through a provider that
// resolves the Lightning address itself (BitcoinVN). The provider requests the
// invoice, so the wallet never sees a payment hash to wait for, and the provider
// reports the order completed well after the sats are in the wallet.
//
// So the wallet names its own address with a fresh tag (`name+tag@domain`,
// LUD-16). The Arkade server keeps the tag on the receive it issues for it: the
// receive under this order's tag IS this order's payout, and its claim is the
// moment the money has arrived.
//
// Import-light on purpose: the quote layer and the tracker import it, so the
// module that owns the wallet identity registers the server ask here.
import { bytesToHex } from "../../lib/bytes";
import { randomBytes } from "../../lib/crypto";

const TAGGED = /^[^+@\s]+\+([a-z0-9]{1,32})@[^@\s]+$/;
const SATS_PER_BTC = 100_000_000;

/** `name@domain` under a fresh tag, or null for anything that is not a plain Lightning address. */
export function withPayoutTag(address: string, tag = bytesToHex(randomBytes(8))): string | null {
  const [name, domain, ...rest] = address.trim().toLowerCase().split("@");
  if (!name || !domain || rest.length > 0 || name.includes("+")) return null;
  return `${name}+${tag}@${domain}`;
}

export type LightningPayout = { tag: string; sats: number };

/** The tagged payout an order waits for, or null when it has none. */
export function lightningPayoutOf(order: {
  to: string;
  settleTarget: string;
  minimumSettleAmount?: string;
}): LightningPayout | null {
  if (String(order.to || "").toUpperCase() !== "BTC_LN") return null;
  const tag = TAGGED.exec(
    String(order.settleTarget || "")
      .trim()
      .toLowerCase(),
  )?.[1];
  const sats = Math.round(Number(order.minimumSettleAmount) * SATS_PER_BTC);
  return tag && Number.isSafeInteger(sats) && sats > 0 ? { tag, sats } : null;
}

/** The server's receive under a tag, or null when it has none. */
type PayoutAsk = (
  tag: string,
) => Promise<{ claimed: boolean; amount_msat: number } | null | undefined>;

let payoutAsk: PayoutAsk | null = null;

/** Registered by services/arkade/internal/identity (arkadeReceiveTagged). */
export function setLightningPayoutAsk(ask: PayoutAsk): void {
  payoutAsk = ask;
}

const PAYOUT_POLL_MS = 3_000;

/**
 * Resolves true once the receive under the order's tag is claimed for exactly
 * the order's amount, false when `signal` ends the wait first. Asks only while
 * `due()` holds, so nothing is asked before the wallet has paid. With no ask
 * registered it never resolves true: the provider's own status ends the order.
 */
export async function waitForLightningPayout(args: {
  payout: LightningPayout;
  signal: AbortSignal;
  due: () => boolean;
  intervalMs?: number;
}): Promise<boolean> {
  const { payout, signal } = args;
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, args.intervalMs ?? PAYOUT_POLL_MS);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal.aborted) return false;
    if (!args.due()) continue;
    try {
      const receive = await payoutAsk?.(payout.tag);
      if (receive?.claimed && Math.trunc(Number(receive.amount_msat) / 1000) === payout.sats) {
        return true;
      }
    } catch {
      // A failed ask is asked again; the provider's own status still ends the order.
    }
  }
  return false;
}
