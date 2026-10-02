import { releaseSwapLoop } from "../swapkit/SwapKitLoopRegistry";
// Prod-tier service: outgoing Lightning payments from the arkade wallet.
// Covers BOLT11 invoice payments and LNURL-pay address resolution. The
// `arkade:BTC -> lightning:BTC` corridor is quoted through SwapKit — the server
// owns route gating, quote verification and order tracking — and this service
// funds the Arkade lockup SwapKit returns, via the offchain wallet under
// browser approval. Filling is non-interactive: the solver claims the lockup
// with the preimage it learns by paying the invoice, so the wallet may go
// offline the moment the funding is submitted.
//
// Cross-cutting helpers (emitTrace, truncateForLog, getOrCreateWallet,
// withOutgoingBrowserApproval, etc.) are imported back from the legacy debug
// service during the prod/debug migration.

import { provisionRefundKey } from "@arkade-os/sdk";
import { errMsg } from "../../lib/errorMessage";
import { bytesToHex } from "../../lib/bytes";
import { decodeBolt11Facts } from "../../lib/bitcoin/lightning";
import { shortTime } from "../../lib/logShared";
import {
  isLnurlPaymentInput,
  normalizeLightningInput,
  requestLnurlInvoice,
  resolveLnurlPayRequest,
} from "../bitcoin/LnurlService";
import {
  ARKADE_INTENTS_LIGHTNING_ROUTE_ID,
  createArkadeIntentsLightningSend,
  prefetchArkadeIntentsLightningQuote,
} from "../swapkit/SwapKitArkadeLightningSendService";
import { asSwapKitV2OrderId } from "../swapkit/SwapKitV2Service";
import { executeAndSubmitV2Action } from "../swapkit/SwapKitV2ActionService";
import { startSwapKitV2Tracking } from "../swapkit/SwapKitV2PendingTracker";
import { fundArkadeIntentsOutpoint } from "./ArkadeSendService";
import { runLightningFundingGuards } from "./lightningFundingGuards";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import { EventBus } from "../events/AppEventBusService";
import { withOutgoingBrowserApproval } from "./internal/browserApproval";
import {
  assertInvoicePrefixForNetwork,
  assertInvoiceStillPayable,
} from "./internal/lightningHelpers";
import {
  type ArkadeLightningSendRecord,
  getArkadeLightningSendOwnerKey,
  recordArkadeLightningSendFunding,
  saveArkadeLightningSend,
} from "./internal/lightningSendStore";
import { emitTrace, logArkadeWalletSignTrace } from "./internal/logging";
import { ArkadeMaxSendAmountError, maxFundableAmountSats } from "./internal/maxSendAmount";
import { inferArkadeNetwork } from "./internal/network";
import {
  attachOutgoingPaySwap,
  createTraceOpId,
  emitOutgoingPayWalletSnapshot,
  formatOutgoingPayTraceDetail,
  registerOutgoingPayTrace,
} from "./internal/payTrace";
import { assertArkadeRecoveryCsvCompatible } from "./internal/recovery";
import { createArkadeServerSwapIntent } from "./internal/swapIntents";
import type { ArkadeOutgoingPayTrace } from "./internal/types";
import { truncateForLog } from "./internal/utils";
import { getOrCreateWallet } from "./internal/walletCache";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

const ARKADE_LIGHTNING_REUSED_INVOICE_MESSAGE =
  "This Lightning invoice is already in use. Create a fresh invoice and try again.";
const ARKADE_LIGHTNING_PROVIDER_INVOICE_MESSAGE =
  "This Lightning provider could not create an invoice for that request. Create a fresh request and try again.";

export function isArkadeLightningReusedInvoiceError(error: unknown): boolean {
  const raw = errMsg(error, "").toLowerCase();
  return (
    raw.includes("a swap with this invoice exists already") ||
    raw.includes("invoice already has an open swap") ||
    raw.includes("lightning invoice is already in use")
  );
}

/**
 * The corridor refused to fund because the lockup the solver quoted is not the
 * one that can be rebuilt from the covenant's own parameters.
 *
 * Always raised BEFORE the wallet sends — refusing to fund a lockup that cannot
 * be rebuilt is the guard working, not failing — so nothing has moved when this
 * is seen. It is also not a transient fault: it means the solver's covenant
 * shape and the one this build derives have diverged, which no retry can close.
 * Both facts are why it does not share the generic "please try again" line.
 */
export function isArkadeLightningLockupMismatchError(error: unknown): boolean {
  const name = String((error as { name?: unknown } | null | undefined)?.name || "");
  if (name === "AddressMismatch") return true;
  return errMsg(error, "").toLowerCase().includes("lockup address does not match local derivation");
}

export function formatArkadeLightningPayError(error: unknown): string {
  if (isArkadeLightningReusedInvoiceError(error)) {
    return ARKADE_LIGHTNING_REUSED_INVOICE_MESSAGE;
  }
  const raw = errMsg(error, "").toLowerCase();
  if (
    raw.includes("cannot create reverse swap") ||
    raw.includes("cannot_create_reverse_swap") ||
    raw.includes("missing lnurl invoice")
  ) {
    return ARKADE_LIGHTNING_PROVIDER_INVOICE_MESSAGE;
  }
  return errMsg(error, "Lightning payment failed");
}

type FundedPaymentResult = {
  amount: number;
  txid: string;
};

type WalletBalance = {
  available?: unknown;
  boarding?: { total?: unknown };
};

export type ArkadeLightningSendSubmittedPayload = {
  kind: "bolt11" | "lnurl";
  txid: string;
  amountSats: number;
  finalAmountSats: number;
  recipient?: string;
  paymentHash?: string;
  opId?: string;
};

export type ArkadeLightningSendAuthenticatedPayload = {
  id?: number;
  kind?: string;
  amountSats?: number;
  finalAmountSats?: number;
  recipient?: string;
  paymentHash?: string;
};

function emitLightningSendSubmitted(payload: ArkadeLightningSendSubmittedPayload): void {
  try {
    EventBus.emit("bitcoin:sendSubmitted", payload);
  } catch {}
}

/**
 * Warm the corridor quote for a BOLT11 invoice while the user is still on the
 * review screen. Read-only: no order, no intent, no signature, no prompt. The
 * refund address comes from the same refund key the send provisions, so the
 * quote is only reused if the send asks for exactly the same thing. Any error
 * is swallowed; the send then quotes as before.
 */
export async function prefetchArkadeLightningQuote(invoice: string): Promise<void> {
  try {
    const request = normalizeLightningInput(String(invoice || ""));
    if (!request || isLnurlPaymentInput(request)) return;
    const wallet = await getOrCreateWallet();
    const refundKey = await provisionRefundKey(wallet);
    await prefetchArkadeIntentsLightningQuote({
      invoice: request,
      refundAddress: refundKey.address,
    });
  } catch {}
}

export async function payArkadeLightningInvoice(_params: {
  invoice: string;
  amountSats?: number;
  maxFeeSats?: number;
  /** Fires after the ceiling check, the invoice-expiry re-check and the user's
   * approval, immediately before the lockup is funded — the irreversible
   * boundary. Anything that refuses earlier moved nothing. */
  onBeforeBroadcast?: () => void | Promise<void>;
}): Promise<{
  id?: string;
  status?: string;
  paymentHash?: string;
  preimage?: string;
  amountSats?: number;
}> {
  const rawRequest = normalizeLightningInput(String(_params.invoice || ""));
  if (!rawRequest) {
    throw new Error("invoice required");
  }
  const payTrace: ArkadeOutgoingPayTrace = {
    opId: createTraceOpId("arkade.pay"),
    paymentHash: "",
    requestKind: "invoice",
    requestedTarget: truncateForLog(rawRequest, 100),
    amountSats: 0,
    startedAtMs: Date.now(),
  };
  emitTrace({
    atMs: payTrace.startedAtMs,
    op: "ln_pay_request",
    status: "attempt",
    id: payTrace.opId,
    detail: formatOutgoingPayTraceDetail(payTrace, [`target=${payTrace.requestedTarget}`]),
  });
  let invoice = rawRequest;
  let requestKind = "invoice";
  if (isLnurlPaymentInput(rawRequest)) {
    const requestedAmountSats = Math.trunc(Number(_params.amountSats || 0));
    if (!Number.isFinite(requestedAmountSats) || requestedAmountSats <= 0) {
      throw new Error("amount required for lnurl payment");
    }
    try {
      logArkadeWalletSignTrace("ln_pay_lnurl_resolve", {
        status: "start",
        sats: requestedAmountSats,
        target: truncateForLog(rawRequest, 90),
        expected_next: "fetch_lnurl_pay_request",
      });
      const lnurl = await resolveLnurlPayRequest(rawRequest);
      const minSendableSats = Math.ceil(lnurl.minSendableMsats / 1000);
      const maxSendableSats = Math.floor(lnurl.maxSendableMsats / 1000);
      logArkadeWalletSignTrace("ln_pay_lnurl_resolve", {
        status: "ok",
        sats: requestedAmountSats,
        min: minSendableSats,
        max: maxSendableSats,
        domain: lnurl.domain || "unknown",
        expected_next: "request_lnurl_invoice",
      });
      if (requestedAmountSats < minSendableSats) {
        throw new Error(`lightning address amount must be >= ${minSendableSats} sats`);
      }
      if (requestedAmountSats > maxSendableSats) {
        throw new Error(`lightning address amount must be <= ${maxSendableSats} sats`);
      }
      invoice = await requestLnurlInvoice(lnurl.callback, requestedAmountSats);
      const lnurlInvoiceSats = decodeBolt11Facts(invoice).amountSats;
      if (!lnurlInvoiceSats || lnurlInvoiceSats !== requestedAmountSats) {
        logArkadeWalletSignTrace("ln_pay_lnurl_invoice", {
          status: "failed",
          sats: requestedAmountSats,
          domain: lnurl.domain || "unknown",
          err: `invoice_amount_mismatch invoice=${lnurlInvoiceSats || 0}`,
          expected_next: "surface_send_error",
        });
        throw new Error(
          `lnurl invoice amount mismatch: requested=${requestedAmountSats} invoice=${lnurlInvoiceSats || 0}`,
        );
      }
      logArkadeWalletSignTrace("ln_pay_lnurl_invoice", {
        status: "ok",
        sats: requestedAmountSats,
        domain: lnurl.domain || "unknown",
        expected_next: "sdk_invoice_decode",
      });
      requestKind = "lnurl";
      payTrace.requestKind = requestKind;
      emitTrace({
        atMs: Date.now(),
        op: "ln_pay_request",
        status: "resolved",
        id: payTrace.opId,
        detail: formatOutgoingPayTraceDetail(payTrace, [
          "kind=lnurl",
          `amount=${requestedAmountSats}`,
          `min=${minSendableSats}`,
          `max=${maxSendableSats}`,
          `target=${lnurl.domain || "unknown"}`,
        ]),
      });
    } catch (error: unknown) {
      const message = errMsg(error, "lnurl resolve failed");
      logArkadeWalletSignTrace("ln_pay_lnurl_resolve", {
        status: "failed",
        sats: requestedAmountSats,
        err: truncateForLog(message, 120),
        expected_next: "surface_send_error",
      });
      emitTrace({
        atMs: Date.now(),
        op: "ln_pay_request",
        status: "resolve_failed",
        id: payTrace.opId,
        detail: formatOutgoingPayTraceDetail(payTrace, [`err=${message}`]),
      });
      throw error;
    }
  }
  const nodeUrl = arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, "");
  const network = inferArkadeNetwork(nodeUrl);
  const prefix = assertInvoicePrefixForNetwork(invoice, network, "pay");

  const invoiceFacts = decodeBolt11Facts(invoice);
  const invoiceSats = invoiceFacts.amountSats;
  payTrace.requestKind = requestKind;
  payTrace.amountSats = invoiceSats;
  payTrace.paymentHash = invoiceFacts.paymentHash;
  registerOutgoingPayTrace(payTrace);
  emitTrace({
    atMs: Date.now(),
    op: "ln_pay_request",
    status: "invoice_ready",
    id: payTrace.opId,
    detail: formatOutgoingPayTraceDetail(payTrace, [
      `kind=${requestKind}`,
      `sats=${invoiceSats}`,
      `payment_hash=${payTrace.paymentHash || "n/a"}`,
      `prefix=${prefix}`,
      "expected_next=browser_approval_then_lockup_funded",
    ]),
  });

  // No local min/max gate: the corridor's bounds belong to the solver, which
  // answers an out-of-bounds request with a SwapRefusal carrying the reason.
  // A second copy here would go stale the moment the solver ramps its limits.
  const wallet = await getOrCreateWallet();
  // The recovery-CSV check, the balance read and the refund key are
  // independent reads, so they run together. Every one of them still has to
  // pass before anything below runs: a failed CSV check throws here exactly as
  // it did when it ran alone, and nothing is quoted, committed or signed first.
  // The refund key is provisioned BEFORE the quote: it is bound into the
  // lockup covenant as its `sender`, so the server cannot default it, and its
  // descriptor is how the refund signer is found again later.
  const [, balanceRaw, refundKey] = await Promise.all([
    assertArkadeRecoveryCsvCompatible(wallet, "ln_pay"),
    wallet.getBalance() as Promise<unknown>,
    provisionRefundKey(wallet),
  ]);
  const balance: WalletBalance = isRecord(balanceRaw) ? balanceRaw : {};
  const availableSats = asNumber(balance.available);
  const boardingSats = asNumber(isRecord(balance.boarding) ? balance.boarding.total : 0);
  const maxPotentialSats = Number.isFinite(availableSats)
    ? Math.max(0, Math.trunc(availableSats))
    : 0;
  if (!Number.isFinite(availableSats) || availableSats < invoiceSats) {
    throw new Error(
      `insufficient offchain funds: available=${availableSats || 0} required=${invoiceSats} boarding=${boardingSats || 0}`,
    );
  }
  // Diagnostics only (it catches every error of its own), so it must not hold
  // the send up: it re-reads the balance and coins the check above just read.
  void emitOutgoingPayWalletSnapshot(wallet, "pre_send", payTrace, [
    `kind=${requestKind}`,
    `sats=${invoiceSats}`,
  ]);
  emitTrace({
    atMs: Date.now(),
    op: "ln_pay_prompt_plan",
    status: "approval_required",
    id: payTrace.opId,
    detail: formatOutgoingPayTraceDetail(payTrace, [
      "client_prf_prewarm=0",
      "combined_assertion_cache=1",
      "server_approval=browser_passkey",
      "broadcast_prompt=assertion_cache_expected_no_prompt",
      "arkade_native_prompt=passkey_prf_assertion_or_cache_hit",
      "keychain_face_id=bug_if_secureKeyStorage_getPrivateKey",
      "proof_logs=PasskeyNativeModuleService|WebAuthnPrfService|secureKeyStorage",
    ]),
  });

  let funded: FundedPaymentResult | null = null;
  let activeOrderId = "";
  let fundingAddress = "";
  let fundingAmountSats = invoiceSats;
  try {
    logArkadeWalletSignTrace("ln_pay_sdk_path", {
      status: "start",
      sdk: "swapkit_mcp",
      method: "swap",
      route: ARKADE_INTENTS_LIGHTNING_ROUTE_ID,
      reason: "browser_approval_wraps_wallet_send",
      expected_next: "server_intent_then_wallet_send",
    });
    // Refund key provisioned above, before the quote. Its address comes from
    // the same single getAddress() read as its pkScript, so the quote-time
    // refund address and the covenant's refund script cannot name different
    // scripts (a second read of a rotating receive address could).
    const refundAddress = refundKey.address;
    const payment = await createArkadeIntentsLightningSend({
      invoice,
      senderPublicKey: bytesToHex(refundKey.pubkey),
      refundAddress,
    });
    activeOrderId = payment.txId;
    const swapId = payment.rfqId;
    fundingAddress = payment.lockupAddress;
    // Exact figure from the route, never the rounded BTC one: the lockup must
    // carry the invoice amount plus the corridor's 30 bps to the sat, and a
    // lockup funded short is one the solver will not fill.
    fundingAmountSats = payment.fundAmountSats;
    attachOutgoingPaySwap(payTrace, swapId);
    emitTrace({
      atMs: Date.now(),
      op: "ln_pay_request",
      status: "route_quote_accepted",
      id: payTrace.opId,
      detail: formatOutgoingPayTraceDetail(payTrace, [
        `kind=${requestKind}`,
        `invoice_sats=${invoiceSats}`,
        `funding_sats=${fundingAmountSats}`,
        `funding=${truncateForLog(fundingAddress, 90)}`,
      ]),
    });
    if (!Number.isFinite(availableSats) || availableSats < fundingAmountSats) {
      if (requestKind === "lnurl" && Number.isFinite(availableSats)) {
        const maxAmountSats = maxFundableAmountSats({
          availableSats: maxPotentialSats,
          requestedSats: invoiceSats,
          fundingSats: fundingAmountSats,
        });
        logArkadeWalletSignTrace("ln_pay_max_amount_hint", {
          status: "available",
          requested_sats: invoiceSats,
          funding_sats: fundingAmountSats,
          available_sats: Math.max(0, Math.trunc(availableSats)),
          max_amount_sats: maxAmountSats,
          expected_next: "ui_sets_max_amount_before_passkey",
        });
        throw new ArkadeMaxSendAmountError(maxAmountSats);
      }
      throw new Error(
        `insufficient offchain funds: available=${availableSats || 0} required=${fundingAmountSats} boarding=${boardingSats || 0}`,
      );
    }
    // Persist BEFORE funding, never after. Once the wallet sends, the lockup is
    // the user's money in a covenant, and `rfqId` is the only handle anything
    // has for looking it up again — a record written afterwards would be
    // missing for exactly the crash that makes it matter.
    const sendRecord: ArkadeLightningSendRecord = {
      rfqId: swapId,
      txId: payment.txId,
      opId: payTrace.opId,
      paymentHash: payTrace.paymentHash,
      refundLocktime: payment.refundLocktime,
      lockupAddress: fundingAddress,
      refundAddress,
      fundAmountSats: fundingAmountSats,
      invoiceSats,
      senderDescriptor: refundKey.descriptor,
      senderPublicKey: bytesToHex(refundKey.pubkey),
      createdAtMs: Date.now(),
    };
    const sendOwnerKey = await getArkadeLightningSendOwnerKey();
    if (!sendOwnerKey) {
      throw new Error("lightning_send_owner_key_unavailable");
    }
    // The local record and the server intent are independent writes, so they
    // run together. Both are awaited before the funding below is armed, so the
    // record still exists before any sats can move, as before.
    const [, swapIntentId] = await Promise.all([
      saveArkadeLightningSend(sendOwnerKey, sendRecord),
      createArkadeServerSwapIntent({
        kind: requestKind === "lnurl" ? "lightning_lnurl" : "lightning_invoice",
        finalRecipient: rawRequest,
        finalAmountSats: invoiceSats,
        fundingAddress,
        fundingAmountSats,
        paymentHash: payTrace.paymentHash,
        invoice,
        provider: "arkade_intents",
        rfqId: swapId,
        op: "ln_pay",
      }),
    ]);
    let submittedEventEmitted = false;
    const emitSubmittedEvent = (submittedTxid: string) => {
      const txid = String(submittedTxid || "").trim();
      if (!txid || submittedEventEmitted) return;
      submittedEventEmitted = true;
      logArkadeWalletSignTrace("ln_pay_send_submitted", {
        kind: requestKind,
        txid: truncateForLog(txid, 20),
        funding_sats: fundingAmountSats,
        final_sats: invoiceSats,
        expected_next: "ui_closes_send_modal_and_tracks_pending",
      });
      emitLightningSendSubmitted({
        kind: requestKind === "lnurl" ? "lnurl" : "bolt11",
        txid,
        amountSats: fundingAmountSats,
        finalAmountSats: invoiceSats,
        recipient: requestKind === "lnurl" ? rawRequest : undefined,
        paymentHash: payTrace.paymentHash || undefined,
        opId: payTrace.opId,
      });
    };
    let fundingTxid = "";
    try {
      await executeAndSubmitV2Action(asSwapKitV2OrderId(payment.txId), payment.fundingAction, {
        recoveryKey: payment.recoveryKey,
        executors: {
          arkade_intents_fund: async (_request, ctx) => {
            if (ctx.previouslyStarted) {
              const evidence = await fundArkadeIntentsOutpoint({
                lockupAddress: fundingAddress,
                amountSats: fundingAmountSats,
                reconcileOnly: true,
              });
              fundingTxid = evidence.arkTxid;
              return evidence;
            }
            fundingTxid = String(
              await withOutgoingBrowserApproval(
                {
                  kind: requestKind === "lnurl" ? "lightning_address_pay" : "lightning_invoice_pay",
                  title:
                    requestKind === "lnurl"
                      ? "Approve Lightning Address Payment"
                      : "Approve Lightning Payment",
                  recipient: rawRequest,
                  amountSats: fundingAmountSats,
                  finalAmountSats: invoiceSats,
                  paymentHash: payTrace.paymentHash,
                  note:
                    requestKind === "lnurl"
                      ? "Outgoing LNURL payment routed through browser approval."
                      : "Outgoing Lightning invoice payment routed through browser approval.",
                  source: "debug_arkade",
                  approvalScope: "direct_send_session",
                  swapIntentId,
                },
                async () => {
                  // Last check before the sats move. Everything between the decode and
                  // here — the refund key, the route, the server intent, the passkey —
                  // takes real time, and funding an invoice that has since expired (or
                  // is about to) buys a lockup nobody can claim and a refund to wait
                  // out. Re-decoded from the invoice itself rather than trusting the
                  // figure read minutes ago.
                  assertInvoiceStillPayable(decodeBolt11Facts(invoice).expiresAt);
                  await _params.onBeforeBroadcast?.();
                  // Feature checks at the boundary (an eSIM order records the
                  // send in its backed-up record); one that throws sends nothing.
                  await runLightningFundingGuards(payTrace.paymentHash);
                  return wallet.send({
                    address: fundingAddress,
                    amount: fundingAmountSats,
                  });
                },
                {
                  opId: payTrace.opId,
                  detail: `flow=arkade.confirm arkade_tx=${payTrace.opId} kind=${requestKind} finalAmount=${invoiceSats} fundingAmount=${fundingAmountSats} recipient=${truncateForLog(rawRequest, 100)}`,
                  onSubmitted: emitSubmittedEvent,
                },
              ),
            );
            funded = { amount: fundingAmountSats, txid: fundingTxid };
            await recordArkadeLightningSendFunding(sendOwnerKey, swapId, fundingTxid);
            return fundArkadeIntentsOutpoint({
              lockupAddress: fundingAddress,
              amountSats: fundingAmountSats,
              fundingTxid,
            });
          },
        },
      });
    } catch (error) {
      // A failed evidence report after broadcast is pending, never a failed
      // payment. The journal and persisted funding txid resume without sending.
      if (!fundingTxid) throw error;
    }
    emitTrace({
      atMs: Date.now(),
      op: "ln_pay_request",
      status: "funded",
      id: payTrace.opId,
      detail: formatOutgoingPayTraceDetail(payTrace, [
        `kind=${requestKind}`,
        `invoice_sats=${invoiceSats}`,
        `funding_sats=${fundingAmountSats}`,
        `txid=${fundingTxid || "n/a"}`,
        "approval_cleared=1",
      ]),
    });
    emitSubmittedEvent(fundingTxid);
    funded = {
      amount: fundingAmountSats,
      txid: fundingTxid,
    };
    // Best-effort, and deliberately unable to throw: the sats have LEFT the
    // wallet by now. A storage failure here that reached the catch below would
    // report a completed send as failed, clear its pending markers and invite
    // the user to pay twice — over a txid the refund path does not even need,
    // since the record it resumes from was written before the funding.
    await recordArkadeLightningSendFunding(sendOwnerKey, swapId, fundingTxid);
    // V2 owns the evidence/retry stream and emits a bound refund action once
    // the covenant timelock opens. Funding alone is not proof of payment.
    emitTrace({
      atMs: Date.now(),
      op: "ln_pay_refund",
      status: "tracked",
      id: payTrace.opId,
      detail: `rfq=${swapId} refund_locktime=${sendRecord.refundLocktime} owner=swapkit_v2`,
    });
  } catch (error: unknown) {
    const raw = errMsg(error, "");
    // Diagnostics only and never throws: the error reaches the user without
    // waiting on another balance and coin read.
    void emitOutgoingPayWalletSnapshot(wallet, "post_failure", payTrace, [
      `kind=${requestKind}`,
      `sats=${invoiceSats}`,
      `err=${truncateForLog(raw || "unknown", 120)}`,
    ]);
    emitTrace({
      atMs: Date.now(),
      op: "ln_pay_request",
      status: "failed",
      id: payTrace.opId,
      detail: formatOutgoingPayTraceDetail(payTrace, [
        `kind=${requestKind}`,
        `sats=${invoiceSats}`,
        `durMs=${Date.now() - payTrace.startedAtMs}`,
        `err=${truncateForLog(raw || "unknown", 180)}`,
      ]),
    });
    if (isArkadeLightningReusedInvoiceError(error)) {
      logArkadeWalletSignTrace("ln_pay_reused_invoice", {
        status: "blocked",
        source: "arkade_swap_sdk_error",
        classification: "invoice_reuse",
        kind: requestKind,
        payment_hash: payTrace.paymentHash.slice(0, 16),
        sats: invoiceSats,
        expected_next: "create_fresh_invoice",
      });
      emitTrace({
        atMs: Date.now(),
        op: "ln_pay_reused_invoice",
        status: "blocked",
        id: payTrace.opId,
        detail: formatOutgoingPayTraceDetail(payTrace, [
          `kind=${requestKind}`,
          `sats=${invoiceSats}`,
          "why=invoice_swap_already_exists",
          "expected_next=create_fresh_invoice",
        ]),
      });
      throw new Error(ARKADE_LIGHTNING_REUSED_INVOICE_MESSAGE);
    }
    throw error;
  } finally {
    if (activeOrderId) {
      releaseSwapLoop(activeOrderId);
      if (funded) startSwapKitV2Tracking(activeOrderId);
    }
  }
  const txid = funded?.txid ?? "";
  const preimage: string = "";
  const preimageStatus = "revealed_by_solver_claim_after_fill";
  // Diagnostics only and never throws: the funded result returns without
  // waiting on another balance and coin read.
  void emitOutgoingPayWalletSnapshot(wallet, "post_success", payTrace, [
    `kind=${requestKind}`,
    `sats=${invoiceSats}`,
    `funding=${fundingAmountSats}`,
    `txid=${txid ? txid.slice(0, 16) : "n/a"}...`,
    `preimage_present=${preimage ? 1 : 0}`,
    `preimage_hash=${preimageStatus}`,
  ]);

  console.log(
    `🔐 [${shortTime()} ArkadeLightningSendService.payInvoice] kind=${requestKind} sats=${invoiceSats} funding=${fundingAmountSats} txid=${txid.slice(0, 16)}... paymentHash=${payTrace.paymentHash.slice(0, 16)}... preimage=${preimage ? 1 : 0} preimageHash=${preimageStatus} prefix=${prefix} network=${network}`,
  );
  emitTrace({
    atMs: Date.now(),
    op: "ln_pay_request",
    status: "funded_success",
    id: payTrace.opId,
    detail: formatOutgoingPayTraceDetail(payTrace, [
      `kind=${requestKind}`,
      `sats=${invoiceSats}`,
      `txid=${txid || "n/a"}`,
      `prefix=${prefix}`,
      `network=${network}`,
      `durMs=${Date.now() - payTrace.startedAtMs}`,
      `preimage=${preimage ? `${preimage.slice(0, 12)}...` : "n/a"}`,
      `preimage_present=${preimage ? 1 : 0}`,
      `preimage_hash=${preimageStatus}`,
    ]),
  });
  emitTrace({
    atMs: Date.now(),
    op: "ark_settle",
    status: "skip",
    detail: "reason=ln_pay_funded_success why=manual_settle_required prompt=0",
  });
  logArkadeWalletSignTrace("ark_settle_auto", {
    status: "skip",
    reason: "ln_pay_funded_success",
    prompt: 0,
    why: "manual_settle_required",
    expected_next: "payment_success_without_post_send_prompt",
  });

  return {
    id: txid || undefined,
    status: "transaction.mempool",
    paymentHash: invoiceFacts.paymentHash || undefined,
    preimage: preimage || undefined,
    amountSats: invoiceSats,
  };
}
