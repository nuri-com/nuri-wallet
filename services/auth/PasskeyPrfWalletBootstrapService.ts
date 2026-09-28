import * as musig2 from "@scure/btc-signer/musig2.js";
import {
  SWAPKIT_HTLC_PROVIDERS,
  deriveSwapKitHtlcProviderRoot,
  deriveWalletEntropy,
} from "../../lib/walletDerivation";
import { deriveBitcoinAddress } from "../../lib/bitcoin/bip86";
import { deriveEthereumAddress } from "../../lib/ethereum/address";
import { bytesToHex } from "../../lib/bytes";
import {
  deletePrivateKey,
  storeBitcoinPublicKey,
  storeCombinedWalletKeys,
  storePrivateKey,
  storeSwapKitHtlcRoots,
} from "../../lib/secureKeyStorage";
import { zeroize } from "../../lib/crypto";

export type PrfBootstrapResult = {
  bitcoinAddress: string;
  ethereumAddress: string;
  // Compressed Bitcoin signing pubkey (hex). This is the arkade client signing
  // key (clientPk33 / walletPublicKeys.userExternal) — the caller persists it so
  // ArkadeRemoteIdentity can identify the wallet. Same value persistBootstrappedKeys
  // stores as the Bitcoin public key.
  bitcoinPublicKey: string;
  bitcoinPrivateKey: Uint8Array;
  ethereumPrivateKey: Uint8Array;
};

/**
 * Derive the wallet roots from a PRF. Pure: nothing is persisted and the PRF is
 * left for the caller to zeroize. A caller that has to establish WHICH wallet a
 * ceremony just produced needs the addresses before anything reaches storage —
 * on the wrong wallet, a single write is already one too many.
 */
export function deriveWalletRootsFromPrf(prf: Uint8Array): PrfBootstrapResult {
  // Seed material, not just a step: each entropy buffer reproduces its whole
  // key on its own. The derivation copies the private keys out, so a caller can
  // only ever wipe those — these two have to be wiped here, on every path out,
  // including the one where the addresses turn out to belong to someone else.
  let bitcoinEntropy: Uint8Array | null = null;
  let ethereumEntropy: Uint8Array | null = null;
  try {
    bitcoinEntropy = deriveWalletEntropy(prf, "bitcoin");
    const bitcoinResult = deriveBitcoinAddress(bitcoinEntropy);
    ethereumEntropy = deriveWalletEntropy(prf, "ethereum");
    const ethereumResult = deriveEthereumAddress(ethereumEntropy);
    return {
      bitcoinAddress: bitcoinResult.address,
      ethereumAddress: ethereumResult.address,
      bitcoinPublicKey: bytesToHex(musig2.IndividualPubkey(bitcoinResult.privateKey)),
      bitcoinPrivateKey: bitcoinResult.privateKey,
      ethereumPrivateKey: ethereumResult.privateKey,
    };
  } finally {
    if (bitcoinEntropy) zeroize(bitcoinEntropy);
    if (ethereumEntropy) zeroize(ethereumEntropy);
  }
}

/**
 * Persist the SwapKit HTLC provider roots (v2 contract) for this PRF. The PRF is
 * the only thing they can be derived from, so this has to happen while it is in
 * hand. Deterministic, so writing them is idempotent — the same PRF rewrites
 * identical roots every time, and a later rollback cannot leave inconsistent
 * state. Best effort: a store failure must not block a login, swap flows just
 * fail closed ("root missing") until the next sign-in retries.
 */
export async function persistSwapKitHtlcRootsFromPrf(prf: Uint8Array): Promise<void> {
  try {
    const roots = Object.fromEntries(
      SWAPKIT_HTLC_PROVIDERS.map((provider) => [
        provider,
        deriveSwapKitHtlcProviderRoot(prf, provider),
      ]),
    );
    try {
      await storeSwapKitHtlcRoots(roots);
    } finally {
      // Wipe even when the store fails — key material never outlives its use;
      // the roots are re-derived fresh on the next sign-in anyway.
      for (const root of Object.values(roots)) zeroize(root);
    }
  } catch {}
}

/**
 * Derive Bitcoin/Ethereum keys from a PRF. Does NOT persist them — the caller
 * must call persistBootstrappedKeys() once any dependent state (e.g. Arkade
 * restore) has succeeded, then zeroize the returned key buffers. The PRF
 * argument is zeroized here.
 */
export async function bootstrapWalletFromPrf(prf: Uint8Array): Promise<PrfBootstrapResult> {
  try {
    const derived = deriveWalletRootsFromPrf(prf);
    await persistSwapKitHtlcRootsFromPrf(prf);
    return derived;
  } finally {
    zeroize(prf);
  }
}

/**
 * Persist the derived keys to secure storage. Atomic commit point of the
 * bootstrap — after this returns, both root-key entries, the mandatory combined
 * unlock entry, and the wallet-derived Nostr identity exist. On any failure,
 * both roots are removed so the caller can retry from scratch.
 */
export async function persistBootstrappedKeys(
  bitcoinPrivateKey: Uint8Array,
  ethereumPrivateKey: Uint8Array,
): Promise<void> {
  let storedBitcoinKey = false;
  let storedEthereumKey = false;
  try {
    await storePrivateKey(bitcoinPrivateKey, "bitcoin");
    storedBitcoinKey = true;
    await storePrivateKey(ethereumPrivateKey, "ethereum");
    storedEthereumKey = true;
    // Mandatory combined entry: one protected read grants access to Bitcoin,
    // EVM, and the wallet-derived Nostr identity. This call must throw on failure
    // so bootstrap rolls back; there is no separate per-key fallback.
    await storeCombinedWalletKeys(bitcoinPrivateKey, ethereumPrivateKey);
    // Persist the Bitcoin individual pubkey LAST, after both private keys are
    // committed, so a mid-bootstrap failure can't leave a pubkey without its
    // key. deletePrivateKey("bitcoin") in the catch also clears any stored pubkey.
    await storeBitcoinPublicKey(bytesToHex(musig2.IndividualPubkey(bitcoinPrivateKey)));
  } catch (error) {
    // Contract: on any failure, remove BOTH private keys (and the btc pubkey,
    // cleared by deletePrivateKey("bitcoin")) so the caller retries from scratch.
    if (storedBitcoinKey) {
      await deletePrivateKey("bitcoin").catch(() => {});
    }
    if (storedEthereumKey) {
      await deletePrivateKey("ethereum").catch(() => {});
    }
    throw error;
  }
}
