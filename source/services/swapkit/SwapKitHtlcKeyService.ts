import { bytesToHex, secp256k1, sha256, zeroize } from "../../lib/crypto";
import {
  getEthereumAddress,
  getSwapKitHtlcKeyState,
  getSwapKitHtlcRoot,
  storeSwapKitHtlcKeyState,
} from "../../lib/secureKeyStorage";
import type { SwapKitHtlcProvider } from "../../lib/walletDerivation";
import { getCacheValue } from "../balance/TransactionCacheService";
import { restoreSwapKitRecoverySnapshotFromNostr } from "../nostr/NostrBackupService";
import {
  assertProvider,
  deriveScalar,
  deriveSwapKitHtlcPreimage,
} from "./SwapKitHtlcSecretService";

/**
 * Provider-neutral HTLC key allocation + derivation for the SwapKit v2 wallet
 * contract (nuri-mcp-bitcoin-swapkit docs/HTLC-WALLET-CONTRACT.md).
 *
 * Persisted state is PUBLIC only: one atomic nextKeyIndex per provider and the
 * idempotent (provider, derive actionId) -> keyIndex map. Private keys and
 * preimages are re-derived on demand from the provider root in the keychain
 * and zeroized after use — they are never persisted, exported or submitted.
 *
 * The state lives in the KEYCHAIN next to the HTLC roots (same lifecycle):
 * the roots are deterministic from the PRF, so a lost counter re-derives
 * already-used preimages and every provider rejects them as duplicates. It
 * previously lived in the purgeable nuri-cache.db — that reset is exactly
 * what triggered the 2026-07-16 satora-duplicate-preimage incident; a legacy
 * cache row is migrated once on first load.
 *
 * SECRET materialization (preimage / swap private key handed to a caller)
 * lives in SwapKitHtlcSecretService — this module returns public material
 * only.
 */

export type SwapKitHtlcMaterial = {
  keyIndex: number;
  /** Compressed 33-byte secp256k1 public key, 0x-hex. */
  publicKey: string;
  /** Compressed 33-byte secp256k1 public key, 0x-hex. */
  userId: string;
  /** SHA-256 of the derived preimage, 0x-hex. */
  preimageHash: string;
  evmAddress: string;
};

type HtlcKeyState = {
  nextKeyIndex: Partial<Record<SwapKitHtlcProvider, number>>;
  /** `${provider}:${actionId}` -> keyIndex */
  allocations: Record<string, number>;
};

const STORAGE_KEY = "swapkit:htlc-keys:v1";

let state: HtlcKeyState | null = null;
// All allocations run through this chain so reserve+persist is atomic even
// when two swaps derive material concurrently.
let allocationChain: Promise<unknown> = Promise.resolve();

/**
 * Per-provider floor rebuilt from the newest Nostr recovery snapshot. The
 * counter is the one piece of HTLC state that is NOT re-derivable from the
 * PRF, so losing it while the roots survive re-derives an already-used
 * preimage. The snapshot already carries `recovery.keyIndex` per order, so the
 * high-water mark is reconstructible without publishing anything new.
 */
async function nostrKeyIndexFloor(): Promise<Partial<Record<SwapKitHtlcProvider, number>>> {
  const floor: Partial<Record<SwapKitHtlcProvider, number>> = {};
  try {
    const orders = await restoreSwapKitRecoverySnapshotFromNostr();
    for (const order of orders ?? []) {
      const provider = order?.recovery?.provider as SwapKitHtlcProvider | undefined;
      const index = Number(order?.recovery?.keyIndex);
      if (!provider || !Number.isSafeInteger(index) || index < 0) continue;
      floor[provider] = Math.max(floor[provider] ?? 0, index + 1);
    }
  } catch {}
  return floor;
}

async function loadState(): Promise<HtlcKeyState> {
  if (state) return state;
  let parsed: unknown = null;
  try {
    const stored = await getSwapKitHtlcKeyState();
    if (stored) parsed = JSON.parse(stored);
  } catch {}
  if (parsed == null) {
    // One-time migration from the legacy cache-DB row (read-only; the
    // keychain becomes authoritative on the next persist).
    try {
      parsed = await getCacheValue<unknown>(STORAGE_KEY);
    } catch {}
  }
  const raw = (parsed ?? {}) as Partial<HtlcKeyState>;
  const next: HtlcKeyState = {
    nextKeyIndex:
      raw.nextKeyIndex && typeof raw.nextKeyIndex === "object" ? { ...raw.nextKeyIndex } : {},
    allocations:
      raw.allocations && typeof raw.allocations === "object" ? { ...raw.allocations } : {},
  };
  // An absent counter is indistinguishable from a wiped one (browser storage
  // eviction wipes the PWA's; a fresh wallet simply has none), and guessing
  // wrong costs a duplicate preimage. Rebuild the floor BEFORE the first
  // allocation can hand out index 0 — a fresh wallet just gets an empty
  // snapshot back. Assign `state` only once complete so a concurrent caller
  // can never observe the pre-floor value.
  if (Object.keys(next.nextKeyIndex).length === 0) {
    for (const [provider, index] of Object.entries(await nostrKeyIndexFloor())) {
      next.nextKeyIndex[provider as SwapKitHtlcProvider] = index;
    }
  }
  state = next;
  return state;
}

/**
 * Atomically reuse the index already allocated to this actionId, or reserve
 * the provider's next unused index — at least `minimumKeyIndex` when the
 * server fast-forwards past provider-known material (v0.6.21 contract:
 * keyIndex = max(nextKeyIndex[provider], derivation.minimumKeyIndex)). The
 * reservation is persisted BEFORE it is returned, so a crash cannot hand the
 * same index to two actions.
 */
export function allocateSwapKitHtlcKeyIndex(
  provider: SwapKitHtlcProvider,
  actionId: string,
  minimumKeyIndex = 0,
): Promise<number> {
  const id = String(actionId || "").trim();
  if (!id) throw new Error("SwapKit HTLC derivation requires an actionId.");
  const minimum =
    Number.isSafeInteger(minimumKeyIndex) && minimumKeyIndex > 0 ? minimumKeyIndex : 0;
  const result = allocationChain.then(async () => {
    const current = await loadState();
    const key = `${provider}:${id}`;
    const existing = current.allocations[key];
    // Replay only material the server can accept: a parked action re-arms with
    // the SAME actionId but a raised minimum (v0.6.26), so a pinned allocation
    // below the floor is provider-rejected forever — reallocate it instead.
    if (existing != null && existing >= minimum) return existing;
    const index = Math.max(current.nextKeyIndex[provider] ?? 0, minimum);
    current.nextKeyIndex[provider] = index + 1;
    current.allocations[key] = index;
    await storeSwapKitHtlcKeyState(JSON.stringify(current));
    return index;
  });
  // Chain regardless of outcome so one failed allocation can't wedge the queue.
  allocationChain = result.catch(() => {});
  return result;
}

/**
 * `operation:"derive_material"`: allocate (or replay) the key index for this
 * actionId and return ONLY public material. Byte-identical on replay.
 */
export async function deriveSwapKitHtlcMaterial(
  provider: string,
  actionId: string,
  minimumKeyIndex = 0,
): Promise<SwapKitHtlcMaterial> {
  assertProvider(provider);
  const evmAddress = await getEthereumAddress();
  if (!evmAddress) throw new Error("Ethereum wallet address is missing. Sign in again.");
  const keyIndex = await allocateSwapKitHtlcKeyIndex(provider, actionId, minimumKeyIndex);
  const root = await getSwapKitHtlcRoot(provider);
  try {
    const swapKey = deriveScalar(root, `swap/${keyIndex}`);
    const userKey = deriveScalar(root, `user/${keyIndex}`);
    try {
      const preimage = deriveSwapKitHtlcPreimage(swapKey);
      const preimageHash = `0x${bytesToHex(sha256(preimage))}`;
      zeroize(preimage);
      return {
        keyIndex,
        publicKey: `0x${bytesToHex(secp256k1.getPublicKey(swapKey, true))}`,
        userId: `0x${bytesToHex(secp256k1.getPublicKey(userKey, true))}`,
        preimageHash,
        evmAddress,
      };
    } finally {
      zeroize(swapKey);
      zeroize(userKey);
    }
  } finally {
    zeroize(root);
  }
}
