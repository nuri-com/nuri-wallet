// Wiring for lib/arkade/evmAddressProof: proves this device's EVM address to
// the Arkade server so other users' activity can name payments to it (#1708).
//
// Runs after the wallet unlocks on native (the key cache is warm, so signing
// raises no Face ID) and once signed in on web, the same entry points as the
// Wirex provisioning repair. One run per address per launch; a failure is
// silent and the next launch tries again.

import { privateKeyToAccount } from "viem/accounts";
import { bytesToHex, zeroize } from "../../lib/crypto";
import { proveEvmAddress } from "../../lib/arkade/evmAddressProof";
import { getEthereumAddress, getPrivateKey } from "../../lib/secureKeyStorage";
import { arkadeLnurlSetProfile } from "./ArkadeApiService";
import { getArkadeLnurlStatus } from "./ArkadeLnurlService";
import { getArkadeLnurlAssertion, getArkadeReceiveOwner } from "./internal/identity";
import { emitTrace } from "./internal/logging";
import { writeCachedLnurlStatus } from "./internal/lnurlStatusCache";

const REASON = "evm_address_proof";

// Addresses already handled this launch, so unlocks do not repeat the check.
const done = new Set<string>();
let inFlight: Promise<void> | null = null;
// Bumped on sign-out: a run that started before it is abandoned.
let generation = 0;

async function signWithEvmKey(message: string): Promise<string> {
  const keyBytes = await getPrivateKey("ethereum");
  try {
    return await privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`).signMessage({
      message,
    });
  } finally {
    zeroize(keyBytes);
  }
}

async function run(): Promise<void> {
  const started = generation;
  const local = (await getEthereumAddress())?.toLowerCase() ?? "";
  if (!local || done.has(local)) return;
  const result = await proveEvmAddress({
    readStatus: () => getArkadeLnurlStatus(undefined, { allowPrompt: false, reason: REASON }),
    localEvmAddress: async () => local,
    credId: async () => (await getArkadeReceiveOwner()).credIdB64u,
    sign: signWithEvmKey,
    submit: async (status, signature) => {
      const assertion = await getArkadeLnurlAssertion(REASON, false);
      if (!assertion || !status.username) return false;
      const profile = await arkadeLnurlSetProfile(assertion, {
        username: status.username,
        evm_address_signature: signature,
      });
      return profile.evm_address_verified === true;
    },
    isCurrent: async (credId) => {
      if (generation !== started) return false;
      const owner = await getArkadeReceiveOwner().catch((): null => null);
      return owner?.credIdB64u === credId && generation === started;
    },
    // Written under the current credential's key, which isCurrent just checked.
    markProven: (status) => writeCachedLnurlStatus({ ...status, evmAddressVerified: true }),
  });
  if (generation !== started) return;
  if (result !== "skipped" && result !== "stale") done.add(local);
  emitTrace({ atMs: Date.now(), op: REASON, status: "ok", detail: `result=${result}` });
}

/** Sign-out / another wallet: forget this launch's runs and strand any in flight. */
export function resetEvmAddressProof(): void {
  generation += 1;
  done.clear();
  inFlight = null;
}

export function runEvmAddressProof(): void {
  if (inFlight) return;
  const current: Promise<void> = run()
    .catch((error: unknown) => {
      emitTrace({
        atMs: Date.now(),
        op: REASON,
        status: "failed",
        detail: `error=${error instanceof Error ? error.message : "unknown"}`,
      });
    })
    .finally(() => {
      // A reset may already have let a newer run start.
      if (inFlight === current) inFlight = null;
    });
  inFlight = current;
}
