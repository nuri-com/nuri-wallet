// Single entry point for "what's my Bitcoin balance".
//
// Reads both rails — the arkade wallet and the MuSig2+CSV on-chain wallet — but
// `total`, the headline balance, is the arkade one alone. `byChannel.arkade` and
// `byChannel.onchain` keep the per-rail numbers for callers that need the
// on-chain side. The shape itself and the Arkade mapping live in ./balanceShape
// (a leaf, see #874) and are re-exported here so every call site keeps working.

import { getBtcL2Provider, getBtcL2ProviderFor } from "./providers/registry";
import { walletService } from "./WalletService";
import { EMPTY_BITCOIN_BALANCE, type BitcoinBalance } from "./balanceShape";

export type { BitcoinBalance } from "./balanceShape";

/**
 * A balance plus how the on-chain half of it was obtained. `failed` means the
 * figures in `byChannel.onchain` / `detail.onchain` are not a reading — they are
 * zeros standing in for a read that did not happen.
 */
export type BitcoinBalanceRead = BitcoinBalance & { onchainRead: "ok" | "failed" };
export { EMPTY_BITCOIN_BALANCE, balanceFromArkadeSummary } from "./balanceShape";

export async function getBitcoinBalance(params: {
  // `mode` retained for call-site compatibility but ignored — both rails are
  // always summed.
  mode?: "arkade";
  address?: string;
  scheduleAutoClaim?: boolean;
  scheduleAutoRecover?: boolean;
  scheduleAutoBoardingSweep?: boolean;
  /**
   * Bypass any internal cooldown the provider may apply. Pass true when
   * the caller has signal that state changed (e.g. responding to
   * arkade:receiveUpdated).
   */
  forceFresh?: boolean;
}): Promise<BitcoinBalanceRead> {
  const snapshot = walletService.getAddressSnapshot();
  // app.nuri.com reads exactly the current v4 L1 wallet. Legacy discovery and
  // migration live outside the app on v1.nuri.com/migrate.
  const onchainAddresses = [snapshot.musig2Address.trim()].filter(Boolean);

  const [arkade, onchainReads] = await Promise.all([
    getBtcL2Provider().getBalance({
      address: params.address,
      forceFresh: params.forceFresh,
      scheduleAutoClaim: params.scheduleAutoClaim,
      scheduleAutoRecover: params.scheduleAutoRecover,
      scheduleAutoBoardingSweep: params.scheduleAutoBoardingSweep,
    }),
    // No on-chain wallet yet (arkade-only identity) → the list is empty and no
    // lookup happens, rather than calling the provider with an empty address. A
    // read that FAILS is reported as such and never as an empty balance:
    // mempool.space being unreachable is not the user having spent their coins,
    // and the caller has a last known figure to keep.
    Promise.all(
      onchainAddresses.map((address) =>
        getBtcL2ProviderFor("onchain")
          .getBalance({ address, forceFresh: params.forceFresh })
          .then((balance) => ({ address, balance, ok: true }))
          .catch(() => ({ address, balance: EMPTY_BITCOIN_BALANCE, ok: false })),
      ),
    ),
  ]);
  // A failed network read is not an empty wallet. Report failure so callers
  // retain their last known balance instead of painting a false zero.
  const onchainOk = onchainReads.every((r) => r.ok);
  const onchain = onchainOk
    ? onchainReads.reduce(
        (acc, { balance }) => ({
          total: acc.total + balance.byChannel.onchain,
          confirmed: acc.confirmed + balance.detail.onchain.confirmed,
          unconfirmed: acc.unconfirmed + balance.detail.onchain.unconfirmed,
          txCount: acc.txCount + balance.detail.onchain.txCount,
        }),
        { total: 0, confirmed: 0, unconfirmed: 0, txCount: 0 },
      )
    : { total: 0, confirmed: 0, unconfirmed: 0, txCount: 0 };
  // The only displayed L1 address is also the only send source.
  const spendableAddress = snapshot.musig2Address.trim();
  const spendable = onchainOk
    ? (onchainReads.find((r) => r.address === spendableAddress)?.balance.byChannel.onchain ?? 0)
    : 0;

  return {
    onchainRead: onchainOk ? "ok" : "failed",
    // Arkade only. The on-chain rail settles at its own pace — a sweep or an
    // incoming payment is not spendable the instant it is seen — so counting it
    // in the headline would show sats the user cannot move yet.
    // `byChannel.onchain` carries its number for the board, and
    // `detail.onchain.spendable` the part of it the send path may offer.
    total: arkade.total,
    byChannel: {
      arkade: arkade.byChannel.arkade,
      onchain: onchain.total,
      lightning: 0,
    },
    detail: {
      onchain: {
        confirmed: onchain.confirmed,
        unconfirmed: onchain.unconfirmed,
        txCount: onchain.txCount,
        spendable,
      },
      arkade: arkade.detail.arkade,
    },
  };
}
