// Single entry point for "spend the MuSig2+CSV on-chain balance".
//
// The on-chain send is a 2-of-2 round with the ARKADE co-signer: build the PSBT,
// register the server swap intent that binds recipient and amount, then sign
// under a native passkey approval and broadcast. Previously this state machine
// lived inline in BitcoinSendScreen, which meant nothing else could spend the
// on-chain balance. It is a service now because the card top-up funds its BTC
// leg from the same wallet.
//
// Returns only once the transaction is broadcast (or throws). Callers that need
// progress render it from `onStatus`.

import * as btc from "@scure/btc-signer";
import {
  buildBitcoinSendPsbt,
  estimateBitcoinSendFeeSats,
} from "../../lib/bitcoin/buildBitcoinSendPsbt";
import { base64ToBytes, bytesToHex } from "../../lib/bytes";
import { prepareDepositPsbt } from "../../lib/bitcoin/prepareDepositPsbt";
import { errMsg } from "../../lib/errorMessage";
import { logWithId, LOG_EMOJI } from "../../lib/OperationLogUtils";
import { withOutgoingBrowserApproval } from "../arkade/internal/browserApproval";
import { getOrCreateArkadeIdentity } from "../arkade/internal/identity";
import { createArkadeServerSwapIntent } from "../arkade/internal/swapIntents";
import { truncateForLog } from "../arkade/internal/utils";
import { blockchainService } from "./BlockchainService";
import { walletService } from "./WalletService";

const SOURCE = "services/bitcoin/OnchainSendService.ts";

export type OnchainSendStatus = "building" | "awaiting_approval" | "broadcasting";

export type OnchainSendResult = {
  txid: string;
  sats: number;
  feeSats: number;
};

/**
 * The miner fee a send from the MuSig2 on-chain wallet will pay, for the caller
 * that has to leave headroom for it — see the amount contract below.
 *
 * Never throws: a UTXO read that did not answer is not a reason to hold nothing
 * back, so it falls through to the smallest spend there is. The build's own
 * funding check stays the authority either way.
 */
export async function estimateOnchainSendFeeSats(): Promise<number> {
  const from = walletService.getMusig2SendSource();
  const inputCount = from
    ? await blockchainService
        .fetchUTXOs(from.address)
        .then((utxos) => utxos.length)
        .catch(() => 0)
    : 0;
  return estimateBitcoinSendFeeSats(inputCount);
}

/**
 * Send from the MuSig2 on-chain wallet to a Bitcoin address.
 *
 * The amount is what the RECIPIENT receives; the miner fee is added on top and
 * taken from the same wallet, so the caller must leave headroom. Throws before
 * anything is signed when the balance cannot cover amount + fee.
 */
export async function sendBitcoinOnchainFromMusig2(params: {
  toAddress: string;
  amountSats: number;
  onStatus?: (status: OnchainSendStatus) => void;
  /** AWAITED immediately before the signed transaction is broadcast — after
   * the build and the passkey approval. A caller recording "may have sent"
   * durably here is guaranteed the record exists before the tx can be on the
   * wire; `onStatus` is display-only and is not awaited. A throw aborts the
   * broadcast. */
  onBeforeBroadcast?: () => void | Promise<void>;
}): Promise<OnchainSendResult> {
  const toAddress = String(params.toAddress || "").trim();
  const amountSats = Math.trunc(Number(params.amountSats));

  if (!toAddress) throw new Error("recipient address required");
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error("amount_sats must be above zero");
  }

  const startedAtMs = Date.now();

  try {
    params.onStatus?.("building");
    // The wallet's own key material, never re-derived here: a source that does
    // not match the address the UTXOs sit on produces a tweak the co-signer
    // refuses to sign against.
    const from = walletService.getMusig2SendSource();
    if (!from) throw new Error("onchain_send_wallet_unavailable");
    const built = await buildBitcoinSendPsbt({ toAddress, from, amountSats });

    // Registered BEFORE the approval is armed, so the co-signer validates the
    // spend against a server-held recipient and amount rather than against the
    // PSBT alone. Both figures are what the recipient receives — the miner fee
    // comes out of the change, not out of the output the intent names.
    const swapIntentId = await createArkadeServerSwapIntent({
      kind: "btc_onchain",
      finalRecipient: toAddress,
      finalAmountSats: built.sats,
      fundingAddress: toAddress,
      fundingAmountSats: built.sats,
      op: "send_bitcoin_onchain_musig2",
    });

    params.onStatus?.("awaiting_approval");
    // Opens no browser despite the name: it arms the native passkey approval the
    // co-signer's `/prepare` + `/cosign` round runs under, and fires `/complete`
    // on the way out. Everything inside `identity.sign` is that round.
    const txid = await withOutgoingBrowserApproval(
      {
        kind: "bitcoin_offboard",
        title: "Approve Bitcoin Send",
        recipient: toAddress,
        amountSats: built.sats,
        finalAmountSats: built.sats,
        note: `Sends ${built.sats} sats to a Bitcoin address.`,
        source: "arkade",
        approvalScope: "direct_send_session",
        swapIntentId,
      },
      async () => {
        const identity = await getOrCreateArkadeIdentity();
        const signed = await identity.sign(btc.Transaction.fromPSBT(base64ToBytes(built.psbtB64)));
        signed.finalize();
        await params.onBeforeBroadcast?.();
        params.onStatus?.("broadcasting");
        return blockchainService.broadcastTransaction(bytesToHex(signed.extract()));
      },
      {
        detail: `flow=bitcoin.onchain_send kind=bitcoin_offboard sats=${built.sats} recipient=${truncateForLog(toAddress, 90)}`,
      },
    );

    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.onchainSend`,
      "broadcast ok",
      { sats: built.sats, feeSats: Number(built.fee), durMs: Date.now() - startedAtMs },
      { context: "user", event: "FLOW", action: "send", source: `${SOURCE}#sendBitcoinOnchain` },
    );

    return { txid, sats: built.sats, feeSats: Number(built.fee) };
  } catch (error: unknown) {
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.onchainSend`,
      "send failed",
      { message: errMsg(error, "unknown"), durMs: Date.now() - startedAtMs },
      { context: "user", event: "API_ERR", action: "send", source: `${SOURCE}#sendBitcoinOnchain` },
    );
    throw error;
  }
}

/**
 * Sign and broadcast a deposit transaction a provider built for us, unchanged.
 *
 * A bridge deposit (LI.FI's BTC-source rail) is not a payment we compose: the provider hands over the
 * exact PSBT — deposit output, its OP_RETURN, our change, the relayer's fee — and its solver matches
 * on that transaction, so the outputs have to be the ones quoted, in that order. `prepareDepositPsbt`
 * verifies the inputs are ours and that the funding output comes first, stamps the taproot material the
 * co-signer needs, and adds nothing else; everything below is the same approval, co-sign and broadcast
 * round the wallet's own sends use.
 */
export async function sendBitcoinDepositPsbt(params: {
  psbt: string;
  /** The deposit address the route named, which the PSBT has to pay first. */
  expectedRecipient: string;
  /** What the accepted funding instruction said this deposit costs the wallet, in sats. The PSBT's
   * own arithmetic has to agree, and this is the figure the approval shows. */
  acceptedDebitSats: number;
  onStatus?: (status: OnchainSendStatus) => void;
  /**
   * Called with the signed transaction BEFORE it is broadcast, and awaited. The caller records it
   * durably here: a broadcast the network accepted can still fail to answer, and the app can die
   * right after it, so whatever is written afterwards may never be written. A throw here aborts the
   * send before anything leaves the wallet.
   */
  onSigned?: (signed: { txid: string; rawHex: string }) => Promise<void>;
}): Promise<OnchainSendResult> {
  const startedAtMs = Date.now();
  try {
    params.onStatus?.("building");
    const from = walletService.getMusig2SendSource();
    if (!from) throw new Error("onchain_send_wallet_unavailable");
    const prepared = prepareDepositPsbt({
      psbt: params.psbt,
      from,
      expectedRecipient: params.expectedRecipient,
      acceptedDebitSats: params.acceptedDebitSats,
    });

    // The intent binds what the co-signer approves to the funding output the provider named, at the
    // amount the provider's own transaction carries.
    const swapIntentId = await createArkadeServerSwapIntent({
      kind: "btc_onchain",
      finalRecipient: prepared.fundingAddress,
      finalAmountSats: prepared.fundingAmountSats,
      fundingAddress: prepared.fundingAddress,
      fundingAmountSats: prepared.fundingAmountSats,
      op: "send_bitcoin_deposit_psbt",
    });

    params.onStatus?.("awaiting_approval");
    const txid = await withOutgoingBrowserApproval(
      {
        kind: "bitcoin_offboard",
        title: "Approve Bitcoin Send",
        recipient: prepared.fundingAddress,
        // The intent binds the funding output, and the v4 co-signer compares its amount against the
        // intent's funding_amount_sats, so this field stays the deposit output. The wallet's real cost
        // is checked in prepareDepositPsbt and stated in the note.
        amountSats: prepared.fundingAmountSats,
        finalAmountSats: prepared.fundingAmountSats,
        note: `Spends ${prepared.debitSats.toLocaleString("en-US")} sats from your on-chain Bitcoin wallet, of which ${prepared.fundingAmountSats.toLocaleString("en-US")} sats goes to the swap's deposit address.`,
        source: "arkade",
        approvalScope: "direct_send_session",
        swapIntentId,
      },
      async () => {
        const identity = await getOrCreateArkadeIdentity();
        const signed = await identity.sign(
          btc.Transaction.fromPSBT(base64ToBytes(prepared.psbtB64)),
        );
        signed.finalize();
        const raw = signed.extract();
        const rawHex = bytesToHex(raw);
        // Parsed with unknown outputs allowed: the provider's deposit carries its OP_RETURN memo, which
        // the default parser refuses, and the id has to be read from those exact bytes.
        const txid = btc.Transaction.fromRaw(raw, { allowUnknownOutputs: true }).id;
        await params.onSigned?.({ txid, rawHex });
        params.onStatus?.("broadcasting");
        return blockchainService.broadcastTransaction(rawHex);
      },
      {
        detail: `flow=bitcoin.deposit_psbt kind=bitcoin_offboard debit=${prepared.debitSats} deposit=${prepared.fundingAmountSats} recipient=${truncateForLog(prepared.fundingAddress, 90)}`,
      },
    );

    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.depositPsbt`,
      "broadcast ok",
      {
        sats: prepared.fundingAmountSats,
        feeSats: prepared.feeSats,
        durMs: Date.now() - startedAtMs,
      },
      {
        context: "user",
        event: "FLOW",
        action: "send",
        source: `${SOURCE}#sendBitcoinDepositPsbt`,
      },
    );

    return {
      txid,
      sats: prepared.fundingAmountSats,
      feeSats: prepared.feeSats,
    };
  } catch (error: unknown) {
    logWithId(
      `${LOG_EMOJI.bitcoin} Bitcoin.depositPsbt`,
      "send failed",
      { message: errMsg(error, "unknown"), durMs: Date.now() - startedAtMs },
      {
        context: "user",
        event: "API_ERR",
        action: "send",
        source: `${SOURCE}#sendBitcoinDepositPsbt`,
      },
    );
    throw error;
  }
}
