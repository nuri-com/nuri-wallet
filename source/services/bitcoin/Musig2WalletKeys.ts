// Resolves the current MuSig2+CSV L1 wallet's public key material.
//
// MISSION-CRITICAL BOUNDARY: this app supports exactly ONE L1 wallet:
// user key + Nuri Cosigner v4 from arkade.nuri.com. Legacy wallet discovery,
// balances and migration are intentionally outside app.nuri.com (v1.nuri.com).
// Do not add legacy resolver, signer, address, balance or sweep code here.

import { errMsg } from "../../lib/errorMessage";
import { bip68SequenceFromTimelock, tryBip68SequenceFromTimelock } from "../../lib/bitcoin/csv";
import { deriveMusig2CsvAddress } from "../../lib/bitcoin/deriveMusig2CsvAddress";
import { getMusig2AddressCache } from "../../lib/secureKeyStorage";
import { ARKADE_ONCHAIN_CSV_TIMELOCK, BITCOIN_NETWORK } from "../../config/constants";
import { authStateManager } from "../auth/AuthStateService";
import type { ArkadeRelativeTimelock } from "../arkade/ArkadeApiService";
import { getCachedArkadeIdentity, getOrCreateArkadeIdentity } from "../arkade/internal/identity";
import { toDerivationNetwork } from "./WalletService";
import { logWithId, LOG_EMOJI } from "../../lib/OperationLogUtils";

const ARKADE_FN = "resolveArkadeMusig2WalletKeys";

function logResolveSkip(fn: string, reason: string, fields: Record<string, unknown>): void {
  logWithId(
    `${LOG_EMOJI.bitcoin} Bitcoin.musig2Keys`,
    "no on-chain wallet",
    { reason, ...fields },
    {
      context: "background",
      event: "STATE",
      action: "hydrate",
      source: `services/bitcoin/Musig2WalletKeys.ts#${fn}`,
    },
  );
}

export type ArkadeMusig2WalletKeys = {
  /** Compressed 33-byte user pubkey, hex — the arkade client key. */
  userCompressed: string;
  /** x-only 32-byte v4 aggregate (user + arkade cosigner), hex. */
  aggregatedXonly32: string;
  /** The recovery leaf's relative timelock, as the co-signer states it. */
  csvTimelock: ArkadeRelativeTimelock;
  /**
   * Credential the read snapshot belongs to. Resolving the context is async, so the caller has to be
   * able to tell whether these keys still belong to the identity that is loaded when they land.
   */
  credId: string | null;
};

/** The subset of the arkade signing context an address derivation needs. */
type ArkadeAggregateContext = {
  clientPk33: string;
  aggregatedXonly32: string;
  nuriServerCsv: ArkadeRelativeTimelock | null;
};

/**
 * The cached arkade context, but only when it describes THIS user key — a
 * context left by another identity would aggregate to a different address.
 * Answers from memory or from the persisted signer context: no network, no
 * passkey prompt.
 */
function cachedArkadeContextFor(userCompressed: string): ArkadeAggregateContext | null {
  try {
    const cached = getCachedArkadeIdentity()?.getCachedSigningPublicContext() ?? null;
    return cached && cached.clientPk33 === userCompressed ? cached : null;
  } catch {
    return null;
  }
}

/**
 * The authenticated signing context — the only place the co-signer states the
 * recovery timelock. Null (already logged) when it cannot be reached, so a
 * caller holding a cached context can still fall back to that.
 */
async function liveArkadeContext(): Promise<ArkadeAggregateContext | null> {
  try {
    return await (await getOrCreateArkadeIdentity()).getSigningPublicContext();
  } catch (e: unknown) {
    logResolveSkip(ARKADE_FN, "arkade_context_unavailable", { message: errMsg(e) });
    return null;
  }
}

/**
 * The context's timelock when the address derivation can actually use it:
 * stated by the co-signer AND expressible as a BIP68 sequence. Anything else is
 * null and has to be resolved elsewhere — the value sits IN the script.
 */
function usableCsvTimelock(ctx: ArkadeAggregateContext | null): ArkadeRelativeTimelock | null {
  const csv = ctx?.nuriServerCsv ?? null;
  if (!csv) return null;
  return tryBip68SequenceFromTimelock(csv) === null ? null : csv;
}

/**
 * Resolve the ARKADE (v4) wallet's user key, aggregate and CSV timelock — the
 * inputs of the address the user receives into today. Cached context first (no
 * network, no passkey prompt), the authenticated signing context when there is
 * no cache hit or the cached one states no usable timelock.
 *
 * Returns null on anything unresolved. There is deliberately NO fallback to the
 * v1 `COSIGNER_PUBKEY_COMPRESSED` key: that aggregate belongs to the legacy
 * wallet and would silently derive an address of the wrong wallet.
 */
export async function resolveArkadeMusig2WalletKeys(): Promise<ArkadeMusig2WalletKeys | null> {
  const snapshot = authStateManager.getState().walletPublicKeys;
  const credId = snapshot?.walletPasskeyCredIdB64u?.trim() || null;
  const userCompressed = snapshot?.userExternal;
  if (!userCompressed || userCompressed.length !== 66) {
    logResolveSkip(ARKADE_FN, "missing_user_pubkey", {
      present: Boolean(userCompressed),
      len: userCompressed?.length ?? 0,
    });
    return null;
  }

  let pubCtx = cachedArkadeContextFor(userCompressed);
  // A cache hit without a usable timelock cannot publish an address on its own
  // — the persisted context never carries one — so escalate to the
  // authenticated context, which is where the co-signer states it. A failed
  // escalation keeps the cached context: the confirmation below can still
  // publish from it, where returning null could not.
  if (!usableCsvTimelock(pubCtx)) {
    const live = await liveArkadeContext();
    if (live) pubCtx = live;
  }
  if (!pubCtx) return null;

  const aggregatedXonly32 = pubCtx.aggregatedXonly32;
  if (pubCtx.clientPk33 !== userCompressed || aggregatedXonly32?.length !== 64) {
    logResolveSkip(ARKADE_FN, "arkade_context_mismatch", {
      clientMatches: pubCtx.clientPk33 === userCompressed,
      lenAgg: aggregatedXonly32?.length ?? 0,
    });
    return null;
  }

  // Only a timelock BIP68 can encode is published: one the co-signer stated in
  // an unencodable form would abort the derivation, so it is treated as unstated
  // and the confirmed default is tried instead of leaving the user address-less.
  const csvTimelock = usableCsvTimelock(pubCtx);
  if (csvTimelock) return { userCompressed, aggregatedXonly32, csvTimelock, credId };
  const confirmed = await confirmFallbackCsvTimelock(userCompressed, aggregatedXonly32);
  return confirmed ? { ...confirmed, credId } : null;
}

/**
 * The CSV value sits IN the script, so a guessed timelock derives a different
 * address — funds paid there would not be in the wallet the user is looking at.
 * The persisted signing context carries no timelock, so when the co-signer did
 * not state one, `ARKADE_ONCHAIN_CSV_TIMELOCK` is trusted only if it reproduces
 * the address already cached for this credential. With nothing to confirm
 * against we publish nothing at all rather than a maybe-address.
 */
async function confirmFallbackCsvTimelock(
  userCompressed: string,
  aggregatedXonly32: string,
): Promise<Omit<ArkadeMusig2WalletKeys, "credId"> | null> {
  const credId =
    authStateManager.getState().walletPublicKeys?.walletPasskeyCredIdB64u?.trim() || null;
  const cachedAddress = (await getMusig2AddressCache(credId))?.trim().toLowerCase() || "";
  if (!cachedAddress) {
    logResolveSkip(ARKADE_FN, "csv_timelock_unconfirmed", { hasCachedAddress: false });
    return null;
  }

  let derived: string;
  try {
    derived = deriveMusig2CsvAddress({
      aggregatedXonly32,
      userCompressed,
      csvSequence: bip68SequenceFromTimelock(ARKADE_ONCHAIN_CSV_TIMELOCK),
      network: toDerivationNetwork(BITCOIN_NETWORK),
    }).address.toLowerCase();
  } catch (e: unknown) {
    logResolveSkip(ARKADE_FN, "csv_fallback_derivation_failed", { message: errMsg(e) });
    return null;
  }

  if (derived !== cachedAddress) {
    logResolveSkip(ARKADE_FN, "csv_fallback_address_mismatch", {
      cachedSuffix: cachedAddress.slice(-6),
      derivedSuffix: derived.slice(-6),
    });
    return null;
  }

  return { userCompressed, aggregatedXonly32, csvTimelock: ARKADE_ONCHAIN_CSV_TIMELOCK };
}
