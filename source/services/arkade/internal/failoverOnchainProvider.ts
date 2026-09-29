// An Arkade `OnchainProvider` that survives its Esplora going down mid-session.
//
// The SDK takes ONE provider at `Wallet.create` and keeps it for the wallet's
// life. `resolveArkadeEsploraUrl` picks the host at that moment, which covers a
// host that is already unreachable at boot — and nothing else. mempool.space
// answering at boot and then rate-limiting ten seconds later (its 429s are
// per-IP and arrive in bursts) leaves the wallet pinned to a host that returns
// nothing, and the boarding read that the Arkade claim depends on fails for the
// rest of the session.
//
// This wraps both hosts instead: every read tries the primary, and falls back to
// the second Esplora on failure. Once the fallback answers, it becomes the
// preferred host for subsequent calls, so a persistently rate-limited primary is
// paid for once rather than on every read.
//
// Deliberately NOT failed over:
//   - `broadcastTransaction`: submitting the same transaction to a second host
//     after an ambiguous failure is a double-broadcast risk, and the failure may
//     be a rejection rather than a timeout. A broadcast failure must surface.
//   - `watchAddresses`: it owns a long-lived websocket/polling loop with its own
//     retry behaviour; wrapping it would fork the subscription lifecycle.
// Both go to the currently preferred host and are left alone otherwise.
import type { OnchainProvider } from "@arkade-os/sdk";
import { emitTrace } from "./logging";
import { truncateForLog } from "./utils";

type ProviderRead<T> = (provider: OnchainProvider) => Promise<T>;

export class FailoverOnchainProvider implements OnchainProvider {
  private preferFallback = false;

  constructor(
    private readonly primary: OnchainProvider,
    private readonly fallback: OnchainProvider,
    private readonly primaryLabel: string,
    private readonly fallbackLabel: string,
  ) {}

  /** The host reads currently go to first. Exposed for logging/tests. */
  get activeLabel(): string {
    return this.preferFallback ? this.fallbackLabel : this.primaryLabel;
  }

  private get active(): OnchainProvider {
    return this.preferFallback ? this.fallback : this.primary;
  }

  private async read<T>(op: string, run: ProviderRead<T>): Promise<T> {
    // Snapshot BOTH providers before the first await. `active`/`standby` read
    // mutable state, and two concurrent failures that each consulted it after
    // their await could flip `preferFallback` twice (landing back on the dead
    // host), or one call could observe the other's flip and retry the primary it
    // had just seen fail.
    const usedFallbackFirst = this.preferFallback;
    const first = usedFallbackFirst ? this.fallback : this.primary;
    const second = usedFallbackFirst ? this.primary : this.fallback;
    const firstLabel = usedFallbackFirst ? this.fallbackLabel : this.primaryLabel;
    const secondLabel = usedFallbackFirst ? this.primaryLabel : this.fallbackLabel;

    try {
      return await run(first);
    } catch (error: unknown) {
      let result: T;
      try {
        result = await run(second);
      } catch {
        // Both hosts refused: surface the FIRST error, which describes the host
        // the caller believes it is talking to.
        throw error;
      }
      // Set the preference to the provider that actually answered — never a
      // toggle of shared state, which is only correct for one call at a time.
      this.preferFallback = !usedFallbackFirst;
      emitTrace({
        atMs: Date.now(),
        op: "wallet_esplora",
        status: "failover",
        detail: `call=${op} from=${firstLabel} to=${secondLabel} err=${truncateForLog(
          error instanceof Error ? error.message : String(error || "unknown"),
          120,
        )}`,
      });
      return result;
    }
  }

  getCoins(address: string) {
    return this.read("getCoins", (p) => p.getCoins(address));
  }

  getFeeRate() {
    return this.read("getFeeRate", (p) => p.getFeeRate());
  }

  getTxOutspends(txid: string) {
    return this.read("getTxOutspends", (p) => p.getTxOutspends(txid));
  }

  getTransactions(address: string) {
    return this.read("getTransactions", (p) => p.getTransactions(address));
  }

  getRawTransaction(txid: string) {
    return this.read("getRawTransaction", (p) => p.getRawTransaction(txid));
  }

  getTxStatus(txid: string) {
    return this.read("getTxStatus", (p) => p.getTxStatus(txid));
  }

  getChainTip() {
    return this.read("getChainTip", (p) => p.getChainTip());
  }

  // Not failed over — see the module header.
  broadcastTransaction(...txs: string[]) {
    return this.active.broadcastTransaction(...txs);
  }

  watchAddresses(
    addresses: string[],
    eventCallback: Parameters<OnchainProvider["watchAddresses"]>[1],
  ) {
    return this.active.watchAddresses(addresses, eventCallback);
  }
}
