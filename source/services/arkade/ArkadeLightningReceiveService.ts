// Prod-tier service: incoming Lightning invoice creation for the arkade
// wallet. The server creates and stores the receive invoice; the client
// only requests the invoice and later claims server-discovered receive work.
//
// Cross-cutting helpers remain imported from the internal arkade modules during
// the prod/debug migration.

import { errMsg } from "../../lib/errorMessage";
import { shortTime } from "../../lib/logShared";
import { arkadeReceiveInvoice, type ArkadeReceiveRestore } from "./ArkadeApiService";
import { arkadeServerConfigService } from "./ArkadeServerConfigService";
import { ARKADE_LN_CREATE_TIMEOUT_MS } from "./internal/constants";
import { getArkadeReceiveOwner } from "./internal/identity";
import { assertInvoicePrefixForNetwork } from "./internal/lightningHelpers";
import { emitTrace } from "./internal/logging";
import { inferArkadeNetwork } from "./internal/network";
import { ArkadeReceiveAmountError, checkReceiveAmountSats } from "./internal/receiveLimits";
import { truncateForLog, withTimeout } from "./internal/utils";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function createArkadeLightningInvoice(_params: {
  amountSats: number;
  memo?: string;
}): Promise<{
  invoice: string;
  id?: string;
  paymentHash?: string;
  preimage?: string;
  expirySeconds?: number;
  expiresAtMs?: number;
  restore?: ArkadeReceiveRestore | null;
}> {
  const amountSats = Number(_params.amountSats);
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error("amount_sats must be above zero");
  }
  // Every receive path routes through here, so this is where the corridor's
  // bounds belong. Outside them the solver refuses the quote and the payer's
  // wallet only ever sees an opaque HTTP 400; failing here means the user is
  // told before an unpayable invoice exists. A caller that wants to pre-check
  // (to disable a button, say) uses the same predicate.
  const limitProblem = checkReceiveAmountSats(amountSats);
  if (limitProblem) {
    throw new ArkadeReceiveAmountError(limitProblem, Math.trunc(amountSats));
  }

  const createdAtMs = Date.now();
  const nodeUrl = arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, "");
  const network = inferArkadeNetwork(nodeUrl);
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_create",
    status: "attempt",
    detail: `sats=${Math.trunc(amountSats)} network=${network} owner=server`,
  });
  const memo = String(_params.memo || "").trim();
  const createStartMs = Date.now();
  const owner = await getArkadeReceiveOwner();
  let created: Awaited<ReturnType<typeof arkadeReceiveInvoice>>;
  try {
    created = await withTimeout(
      "create_server_receive_invoice",
      ARKADE_LN_CREATE_TIMEOUT_MS,
      arkadeReceiveInvoice(owner, {
        amount_sats: Math.trunc(amountSats),
        memo: memo || undefined,
      }),
    );
  } catch (error: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_create",
      status: "failed",
      detail: truncateForLog(
        `stage=create_server_receive_invoice err=${errMsg(error, "unknown")}`,
        170,
      ),
    });
    throw error;
  }
  const pendingSwapId = asString(created.swap_id);
  const paymentHashStr = asString(created.payment_hash_hex);
  const invoice = asString(created.invoice);
  if (created.ok !== true || !pendingSwapId || !invoice) {
    emitTrace({
      atMs: Date.now(),
      op: "ln_receive_create",
      status: "failed",
      detail: `stage=create_server_receive_invoice err=malformed_response ok=${created.ok === true ? 1 : 0} swap_id=${pendingSwapId ? 1 : 0} invoice=${invoice ? 1 : 0}`,
    });
    throw new Error("arkade create invoice returned malformed response");
  }
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_create",
    status: "server_reverse_swap_ok",
    id: pendingSwapId || paymentHashStr || undefined,
    detail: `durMs=${Date.now() - createStartMs}`,
  });

  const id = pendingSwapId || paymentHashStr;
  const prefix = assertInvoicePrefixForNetwork(invoice, network, "create");
  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_create",
    status: "created",
    id: id || undefined,
    detail: `prefix=${prefix} network=${network} sats=${Math.trunc(amountSats)} payment_hash=${paymentHashStr || "n/a"} owner=server`,
  });

  emitTrace({
    atMs: Date.now(),
    op: "ln_receive_claim",
    status: "watching",
    id: id || undefined,
    detail: "owner=server_receive_sync auto_actions=1",
  });

  console.log(
    `🔐 [${shortTime()} ArkadeLightningReceiveService.createInvoice] amount=${Math.trunc(amountSats)} id=${id || "n/a"} prefix=${prefix} network=${network} owner=server_receive`,
  );

  const expiresAtMs = Number(created.expires_at_ms || 0);
  const expirySeconds =
    Number.isFinite(expiresAtMs) && expiresAtMs > createdAtMs
      ? Math.max(1, Math.trunc((expiresAtMs - createdAtMs) / 1000))
      : 0;

  return {
    invoice,
    id: id || undefined,
    paymentHash: paymentHashStr || undefined,
    expirySeconds: Number.isFinite(expirySeconds) && expirySeconds > 0 ? expirySeconds : undefined,
    expiresAtMs: expiresAtMs > 0 ? expiresAtMs : undefined,
    restore: created.restore || null,
  };
}
