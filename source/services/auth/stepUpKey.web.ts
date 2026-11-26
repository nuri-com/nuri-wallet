// services/auth/stepUpKey.web.ts
// Step-up on web (#1898): same security as native. The browser keeps the keys
// in storage without a biometric gate, so the stored key is never used for a
// step-up. Instead the user confirms with their wallet passkey
// (userVerification "required": Face ID / Touch ID / device PIN), the PRF
// output re-derives the ethereum key, and only that key signs. A cancelled or
// failed ceremony throws, so nothing is signed or sent.
//
// Fails closed on identity: the derived address must equal the address this
// device is signed into, so picking another nuri.com passkey cannot sign for
// a different wallet.
import { PRF_SALT } from "../../config/constants";
import { WALLET_RP_ID } from "../../config/passkey";
import { normalizePrfOutput, zeroize } from "../../lib/crypto";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { authStateManager } from "./AuthStateService";
import { useExistingWalletPasskey } from "./PasskeyNativeModuleService";
import { deriveWalletRootsFromPrf } from "./PasskeyPrfWalletBootstrapService";

export async function readStepUpEthereumKey(signal?: AbortSignal): Promise<Uint8Array> {
  const expected = (await getEthereumAddress())?.trim().toLowerCase() ?? "";
  if (!expected) throw new Error("step_up_no_wallet");

  const credIdHint =
    authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || undefined;

  // `signal` is the step-up deadline: aborting releases the browser's single
  // WebAuthn slot, so the next queued step-up can open its own prompt.
  const result = await useExistingWalletPasskey(WALLET_RP_ID, PRF_SALT, credIdHint, { signal });
  const prf = normalizePrfOutput(result.prfB64 || "");
  try {
    if (!prf.length) throw new Error("step_up_empty_prf");
    const derived = deriveWalletRootsFromPrf(prf);
    zeroize(derived.bitcoinPrivateKey);
    if (derived.ethereumAddress.trim().toLowerCase() !== expected) {
      zeroize(derived.ethereumPrivateKey);
      throw new Error("step_up_wrong_wallet");
    }
    return derived.ethereumPrivateKey;
  } finally {
    zeroize(prf);
  }
}
