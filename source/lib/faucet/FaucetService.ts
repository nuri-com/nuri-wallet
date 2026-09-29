import {
  FAUCET_RELAY_MAX_ATTEMPTS,
  FAUCET_RELAY_RETRY_BUDGET_MS,
  FAUCET_RELAY_RETRY_DELAY_MS,
  FAUCET_RELAY_TIMEOUT_MS,
} from "../../config/constants";
import { WIREX_PROXY_BASE_URL } from "../../config/network";
import { errMsg, errName } from "../errorMessage";

export type DripResult = {
  sent: boolean;
  txHash?: string;
  reason?: string;
  /**
   * True when the relay never reached a verdict — timeout, transport failure,
   * or 429/5xx that outlived the retries. A refusal the relay CHOSE (has_gas,
   * already_claimed, faucet_empty, any other 4xx) is not transient. Callers use
   * this to keep an unreachable faucet fail-open instead of treating an outage
   * as proof the wallet cannot pay.
   */
  transient?: boolean;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Single relay POST. Fail open on timeout/error: caller proceeds to gas
// estimation/send so the UI is not stuck; the send fails naturally if gas is
// truly missing.
/** Every attempt states `transient` explicitly; the exported result keeps it optional. */
type DripAttempt = DripResult & { transient: boolean };

async function postDripOnce(url: string, beneficiary: string): Promise<DripAttempt> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FAUCET_RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beneficiary }),
      signal: controller.signal,
    });
    const json: unknown = await res.json().catch(() => ({}));
    const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const ok = obj.ok === true;
    const txHash = typeof obj.txHash === "string" ? obj.txHash : undefined;
    const reason = typeof obj.reason === "string" ? obj.reason : undefined;
    if (res.ok && ok) {
      return { sent: true, txHash, transient: false };
    }
    // Rate limiting and server faults are the relay being momentarily unable,
    // not unwilling — everything else is a decision that a retry cannot change.
    const transient = res.status === 429 || res.status >= 500;
    return { sent: false, reason: reason || `relay_http_${res.status}`, transient };
  } catch (e: unknown) {
    if (errName(e) === "AbortError") {
      return { sent: false, reason: "relay_timeout", transient: true };
    }
    return { sent: false, reason: errMsg(e, "relay_failed"), transient: true };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Retry only what a retry can fix, and only while the budget allows: a send is
// blocked on this call, so an unreachable relay must give up rather than stall.
async function postDrip(url: string, beneficiary: string): Promise<DripResult> {
  const deadline = Date.now() + FAUCET_RELAY_RETRY_BUDGET_MS;
  let attempt: DripAttempt = { sent: false, reason: "relay_not_attempted", transient: true };
  for (let i = 1; i <= FAUCET_RELAY_MAX_ATTEMPTS; i++) {
    attempt = await postDripOnce(url, beneficiary);
    if (attempt.sent || !attempt.transient || i === FAUCET_RELAY_MAX_ATTEMPTS) break;
    const delay = FAUCET_RELAY_RETRY_DELAY_MS * i;
    if (Date.now() + delay >= deadline) break;
    await wait(delay);
  }
  // `transient` survives into the result: exhausting the retries does not turn
  // an unreachable relay into a verdict about the wallet.
  return attempt;
}

/**
 * Drip Base mainnet gas via the wirex proxy faucet (nginx injects the server
 * key — no client key needed). Server refuses non-fatally with reasons like
 * already_claimed / has_gas / faucet_empty; callers must proceed regardless.
 */
export async function dripBaseGas(beneficiary: string): Promise<DripResult> {
  const base = WIREX_PROXY_BASE_URL.replace(/\/$/, "");
  return postDrip(`${base}/faucet/drip`, beneficiary);
}
