// Internal arkade server swap-intent helper shared by prod-tier and debug-tier code.
import { ArkAddress } from "@arkade-os/sdk";
import * as btc from "@scure/btc-signer";
import { bytesToHex } from "../../../lib/bytes";
import { sha256 } from "../../../lib/crypto";
import { arkadeSwapIntentCreate } from "../ArkadeApiService";
import { getOrCreateArkadeIdentity } from "./identity";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import { hexToBytesLocal, truncateForLog } from "./utils";

function scriptHashForLog(scriptHex: string): string {
  const bytes = hexToBytesLocal(scriptHex);
  return bytes.length ? bytesToHex(sha256(bytes)).slice(0, 16) : "n/a";
}

/**
 * The output script the funds will land in, for the intent the server approves.
 *
 * Ark-funded flows (ark_send, and the former Boltz chain swap, which funded an
 * Ark lockup address) decode as Ark addresses. A collaborative exit has no
 * intermediate Ark address at all — it settles straight into an on-chain output
 * — so a Bitcoin address must produce a Bitcoin scriptPubKey instead. Decoding
 * that as an Ark address is what threw "expected 65 bytes, got 33".
 */
function arkadeFundingTarget(address: string): {
  fundingAddress: string;
  fundingScriptHex: string;
} {
  const fundingAddress = String(address || "").trim();
  if (!fundingAddress) {
    throw new Error("arkade funding address required");
  }
  let fundingScriptHex = "";
  try {
    fundingScriptHex = bytesToHex(ArkAddress.decode(fundingAddress).pkScript).toLowerCase();
  } catch {
    // Not an Ark address — treat it as the on-chain recipient of an offboard.
    try {
      fundingScriptHex = bytesToHex(
        btc.OutScript.encode(btc.Address().decode(fundingAddress)),
      ).toLowerCase();
    } catch {
      throw new Error("arkade funding address is neither an ark nor a bitcoin address");
    }
  }
  if (!fundingScriptHex) {
    throw new Error("arkade funding script missing");
  }
  return {
    fundingAddress,
    fundingScriptHex,
  };
}

export async function createArkadeServerSwapIntent(params: {
  kind:
    | "ark_send"
    | "btc_onchain"
    | "lightning_invoice"
    | "lightning_lnurl"
    | "lightning_refund"
    | "arkade_stablecoin";
  finalRecipient: string;
  /** What the far side receives in sats. Absent on a stablecoin purchase, where
   * the sats are an internal hop and the output is a token amount instead. */
  finalAmountSats?: number;
  /** Stablecoin purchases only: what the user is buying. */
  outputAsset?: string;
  outputAmount?: number;
  outputChain?: string;
  routeId?: string;
  refundLocktime?: number;
  fundingAddress: string;
  fundingAmountSats: number;
  paymentHash?: string;
  invoice?: string;
  /** Which corridor is funding this intent, when it is not the wallet's own
   * send. The server binds the approval sheet to it. */
  provider?: string;
  /** The corridor negotiation id, so the server can reconcile its own view of
   * the swap with the approval it signed. */
  rfqId?: string;
  /** The funded covenant a `lightning_refund` returns. The server binds its
   * approval to this, so a payment approval can never authorise a refund. */
  lockupAddress?: string;
  op: string;
}): Promise<string> {
  const finalRecipient = String(params.finalRecipient || "").trim();
  const finalAmountSats = Math.trunc(Number(params.finalAmountSats || 0));
  const isStablecoinPurchase = params.kind === "arkade_stablecoin";
  const fundingAmountSats = Math.trunc(Number(params.fundingAmountSats || 0));
  if (!finalRecipient) {
    throw new Error("swap intent final recipient required");
  }
  if (!isStablecoinPurchase && (!Number.isFinite(finalAmountSats) || finalAmountSats <= 0)) {
    throw new Error("swap intent final amount required");
  }
  // The approval renders the output, so a purchase with no stated output is one
  // the user cannot meaningfully approve.
  if (
    isStablecoinPurchase &&
    (!params.outputAsset || !(Number(params.outputAmount) > 0) || !params.outputChain)
  ) {
    throw new Error("swap intent output required");
  }
  if (!Number.isFinite(fundingAmountSats) || fundingAmountSats <= 0) {
    throw new Error("swap intent funding amount required");
  }

  const identity = await getOrCreateArkadeIdentity();
  const intentContext = await identity.getSwapIntentContext();
  const fundingTarget = arkadeFundingTarget(params.fundingAddress);
  const response = await arkadeSwapIntentCreate(null, {
    kind: params.kind,
    cred_id_b64u: intentContext.credIdB64u,
    client_signer_pubkey: intentContext.clientPk33,
    final_recipient: finalRecipient,
    // Rejected rather than ignored on a stablecoin purchase: the sats there are
    // the Lightning hop, not what the user is buying.
    ...(isStablecoinPurchase ? {} : { final_amount_sats: finalAmountSats }),
    ...(isStablecoinPurchase
      ? {
          output_asset: params.outputAsset,
          output_amount: params.outputAmount,
          output_chain: params.outputChain,
          route_id: params.routeId,
          refund_locktime: params.refundLocktime,
        }
      : {}),
    funding_address: fundingTarget.fundingAddress,
    funding_script_hex: fundingTarget.fundingScriptHex,
    funding_amount_sats: fundingAmountSats,
    payment_hash: params.paymentHash,
    invoice: params.invoice,
    provider: params.provider,
    rfq_id: params.rfqId,
    lockup_address: params.lockupAddress,
  });
  const intentId = String(response.intent?.id || "").trim();
  if (!intentId) {
    throw new Error("swap intent create returned empty id");
  }
  logArkadeWalletSignTrace("swap_intent_created", {
    op: params.op,
    intent: truncateForLog(intentId, 24),
    kind: params.kind,
    final_sats: finalAmountSats,
    funding_sats: fundingAmountSats,
    funding_script_hash: scriptHashForLog(fundingTarget.fundingScriptHex),
    expected_next: "v5_send_prepare_uses_server_intent",
  });
  emitTrace({
    atMs: Date.now(),
    op: "swap_intent",
    status: "created",
    id: intentId,
    detail: `op=${params.op} kind=${params.kind} final=${finalAmountSats} funding=${fundingAmountSats}`,
  });
  return intentId;
}
