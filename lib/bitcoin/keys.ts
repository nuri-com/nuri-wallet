// Bitcoin MuSig2 key derivation and wallet loading
import * as musig2 from "@scure/btc-signer/musig2.js";
import { bytesToHex, hexToBytes } from "../bytes";
import { zeroize } from "../crypto";
import {
  getPrivateKey,
  getAuthData,
  getBitcoinPublicKey,
  storeBitcoinPublicKey,
  AUTH_STORAGE_KEYS,
} from "../secureKeyStorage";
import { logWithId, LOG_EMOJI } from "../OperationLogUtils";
import { buildBitcoinTaprootDescriptor } from "./BitcoinTaprootDescriptor";
import { walletService } from "../../services/bitcoin/WalletService";
import type { WalletIdentity } from "./walletIdentity";
import { CSV_BLOCKS, BITCOIN_NETWORK as NETWORK } from "../../config/constants";
import { aggregatedPXOnlyHex } from "../musig2Agg";

export type DerivedKeys = {
  publicKey: Uint8Array;
  xOnlyHex: string;
  cosignerXOnly: string;
  aggregatedXOnly: string;
  aggregatedIntXOnly: string;
  compressedHex: string;
  compressedIntHex: string;
};

/**
 * Derives real MuSig2 keys from the stored Bitcoin public key + cosigner.
 * Reads the cached individual pubkey first — no private key, no biometric
 * prompt. Only legacy installs without a stored pubkey fall back to a one-time
 * getPrivateKey("bitcoin") read (which prompts) and then backfill the pubkey.
 */
export async function deriveRealKeys(opts: {
  cosignerPubkey: string | null;
}): Promise<DerivedKeys> {
  let privateKey: Uint8Array | null = null;

  try {
    let publicKeyCompressed: Uint8Array;
    const storedPubHex = await getBitcoinPublicKey();
    if (storedPubHex) {
      publicKeyCompressed = hexToBytes(storedPubHex);
    } else {
      privateKey = await getPrivateKey("bitcoin");
      publicKeyCompressed = musig2.IndividualPubkey(privateKey);
      // backfill for legacy installs so subsequent loads are key-free
      try {
        await storeBitcoinPublicKey(bytesToHex(publicKeyCompressed));
      } catch {}
    }

    const xOnlyExt = bytesToHex(publicKeyCompressed.slice(1));

    // Resolve cosigner key
    let cosignerKey = opts.cosignerPubkey || null;
    if (!cosignerKey) {
      try {
        const stored = await getAuthData(AUTH_STORAGE_KEYS.COSIGNER_PUBKEY);
        if (stored) cosignerKey = stored;
      } catch {}
    }
    if (!cosignerKey) {
      throw new Error("Co-signer public key not available");
    }

    const clientPubkeyExt = publicKeyCompressed;

    const serverCompressed = await getAuthData("COSIGNER_PUBKEY_COMPRESSED");
    if (!serverCompressed || serverCompressed.length !== 66) {
      throw new Error("Missing cosigner compressed key. Please relink via setup.");
    }
    const serverPubkey = hexToBytes(serverCompressed);

    const aggregatedExt = aggregatedPXOnlyHex(clientPubkeyExt, serverPubkey);

    if (aggregatedExt.length !== 64) {
      throw new Error(`External aggregated key must be 64 hex chars, got ${aggregatedExt.length}`);
    }

    const aggregatedInt = aggregatedPXOnlyHex(publicKeyCompressed, serverPubkey);

    if (aggregatedInt.length !== 64) {
      throw new Error(`Internal aggregated key must be 64 hex chars, got ${aggregatedInt.length}`);
    }

    return {
      publicKey: publicKeyCompressed,
      xOnlyHex: xOnlyExt,
      cosignerXOnly: cosignerKey,
      aggregatedXOnly: aggregatedExt,
      aggregatedIntXOnly: aggregatedInt,
      compressedHex: bytesToHex(publicKeyCompressed),
      compressedIntHex: bytesToHex(publicKeyCompressed),
    };
  } finally {
    if (privateKey) {
      zeroize(privateKey);
    }
  }
}

export type WalletPublicKeys = {
  userExternal: string;
  userInternal: string;
  aggregatedExternal: string;
  aggregatedInternal: string;
};

/**
 * Loads a wallet from stored public keys — no biometric auth required.
 * Returns the wallet address, or null if public keys are not available.
 * `csvSequence` is the BIP68 sequence of the recovery leaf; the legacy
 * block-count co-signer policy is the default.
 */
export async function loadWalletFromPublicKeys(
  publicKeys: WalletPublicKeys | null | undefined,
  csvSequence: number = CSV_BLOCKS,
  identity?: WalletIdentity,
): Promise<string | null> {
  logWithId(`${LOG_EMOJI.auth} Bitcoin.pubkeys`, "load wallet from public keys", undefined, {
    context: "background",
  });

  if (!publicKeys) {
    logWithId(`${LOG_EMOJI.auth} Bitcoin.pubkeys`, "no stored public keys", undefined, {
      context: "background",
    });
    return null;
  }

  const { userExternal, userInternal, aggregatedExternal, aggregatedInternal } = publicKeys;

  logWithId(
    `${LOG_EMOJI.auth} Bitcoin.pubkeys`,
    "stored public keys found",
    {
      userExternal: userExternal.slice(0, 8),
      userInternal: userInternal.slice(0, 8),
      aggregatedExternal: aggregatedExternal.slice(0, 8),
      aggregatedInternal: aggregatedInternal.slice(0, 8),
    },
    { context: "background" },
  );

  const descExternal = buildBitcoinTaprootDescriptor(aggregatedExternal, userExternal, csvSequence);

  const descInternal = buildBitcoinTaprootDescriptor(aggregatedInternal, userInternal, csvSequence);

  await walletService.createWallet(
    descExternal.external,
    descInternal.internal,
    NETWORK,
    aggregatedExternal,
    aggregatedInternal,
    csvSequence,
    userExternal,
    userInternal,
    identity,
  );

  const address = await walletService.getNewAddress();
  logWithId(
    `${LOG_EMOJI.auth} Bitcoin.pubkeys`,
    "wallet loaded from public keys",
    { addressSuffix: String(address).slice(-6) },
    { context: "background" },
  );

  return address;
}
