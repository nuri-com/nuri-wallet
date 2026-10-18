// Proving the user's EVM address to the Arkade server, once.
//
// The server names a payment's address after a Nuri user only when that user
// proved they hold it (nuri-com/nuri-expo#1708): the address signs
// "nuri-evm-binding-v1:<credIdB64u>" with personal_sign, and the server checks
// it on set-profile. The address it publishes is written by the app, so without
// the proof anyone could claim someone else's address.
//
// Pure decision + steps; the wiring (keys, server, cache) is injected so it can
// be tested without React Native.

import type { ArkadeLnurlStatus } from "../../services/arkade/types/lnurl";

export const EVM_BINDING_PREFIX = "nuri-evm-binding-v1:";

export function evmBindingMessage(credIdB64u: string): string {
  return `${EVM_BINDING_PREFIX}${credIdB64u}`;
}

export type EvmAddressProofDeps = {
  /** The user's username status (no passkey prompt). */
  readStatus: () => Promise<ArkadeLnurlStatus>;
  /** This device's EVM address. */
  localEvmAddress: () => Promise<string | null>;
  /** The passkey credential id the server's auth token carries. */
  credId: () => Promise<string>;
  /** personal_sign with the EVM key. */
  sign: (message: string) => Promise<string>;
  /** set-profile with the signature; true once the server reports it proven. */
  submit: (status: ArkadeLnurlStatus, signature: string) => Promise<boolean>;
  /** Still the account (credential) this run started for. */
  isCurrent: (credId: string) => Promise<boolean>;
  /** Record the proof in this account's cached status. */
  markProven: (status: ArkadeLnurlStatus) => void;
};

export type EvmAddressProofResult = "proven" | "already" | "skipped" | "refused" | "stale";

export async function proveEvmAddress(deps: EvmAddressProofDeps): Promise<EvmAddressProofResult> {
  const [status, local] = await Promise.all([deps.readStatus(), deps.localEvmAddress()]);
  if (!status.registered || !status.username || !local) return "skipped";
  // Only the address the server already publishes for this user is signed for:
  // the profile sync writes it first, and a mismatch waits for that sync.
  if (status.evmAddress?.toLowerCase() !== local.toLowerCase()) return "skipped";
  if (status.evmAddressVerified) return "already";
  // The account can change at every await (sign-out, another wallet): nothing
  // from this run is signed, sent or cached for an account that left.
  const credId = await deps.credId();
  if (!(await deps.isCurrent(credId))) return "stale";
  const signature = await deps.sign(evmBindingMessage(credId));
  if (!(await deps.isCurrent(credId))) return "stale";
  const proven = await deps.submit(status, signature);
  if (!(await deps.isCurrent(credId))) return "stale";
  if (!proven) return "refused";
  deps.markProven(status);
  return "proven";
}
