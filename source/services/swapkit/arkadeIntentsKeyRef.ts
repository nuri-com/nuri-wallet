// The opaque wallet-owned ref the wallet hands SwapKit with its Arkade Intents
// refund material. The server stores and echoes it verbatim; the refund
// executor only checks that it carries this wallet's prefix (provenance) and
// re-derives the signer from the wallet, never from the ref.
//
// SwapKit's shared contract bounds the ref to 200 characters
// (`refundMaterial.walletKeyRef`, nuri-com/nuri-mcp-bitcoin-swapkit#443). The
// scope is usually the commit's idempotency key, and a Lightning send that
// replays an expired order appends `:after:<orderId>` to that key, which pushes
// the ref past the bound and the commit is refused before anything is created.
import { bytesToHex } from "../../lib/bytes";
import { sha256, utf8ToBytes } from "../../lib/crypto";

/** The opaque wallet-owned ref prefix for Arkade Intents refund material. */
export const ARKADE_INTENTS_KEY_REF_PREFIX = "nuri-arkade-intents-v1";

/** SwapKit's `refundMaterial.walletKeyRef` / `arkade_refund_material` bound. */
export const WALLET_KEY_REF_MAX_LENGTH = 200;

/**
 * The ref for one scope. A ref that fits the contract is kept exactly as it was
 * always minted, so refs of existing orders never change; a longer one is
 * replaced by a digest of its scope, which is just as deterministic (the same
 * scope always mints the same ref) and still carries the wallet's prefix.
 */
export function arkadeIntentsKeyRef(scope: string): string {
  const ref = `${ARKADE_INTENTS_KEY_REF_PREFIX}:${scope || "refund"}`;
  if (ref.length <= WALLET_KEY_REF_MAX_LENGTH) return ref;
  return `${ARKADE_INTENTS_KEY_REF_PREFIX}:sha256:${bytesToHex(sha256(utf8ToBytes(scope)))}`;
}

export function isArkadeIntentsRefundKeyRef(raw: string): boolean {
  return String(raw || "").startsWith(`${ARKADE_INTENTS_KEY_REF_PREFIX}:`);
}
