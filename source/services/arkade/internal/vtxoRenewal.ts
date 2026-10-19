// VTXO renewal before batch expiry (#1635), run from the unlock modal.
//
// Settles the VTXOs whose batch expires within ARKADE_VTXO_RENEWAL_THRESHOLD_DAYS
// into a fresh batch, back to the wallet's own Ark address. It signs through
// the same production cosigner path every outgoing settle uses —
// `withOutgoingBrowserApproval` arms the identity's spend approval, the SDK's
// `wallet.settle` asks the identity to sign, and the identity runs the Nuri
// `/api/arkade/send/prepare` → passkey → `/send/cosign` round
// (ArkadeSpendApprovalFlow; an `arkade_settle` approval registers a server
// `ark_settle` intent bound to the destination output). Nothing here signs on
// its own: no passkey touch, no renewal.
import { ArkAddress, Estimator } from "@arkade-os/sdk";
import { bytesToHex } from "../../../lib/bytes";
import { EventBus } from "../../events/AppEventBusService";
import { arkadeServerConfigService } from "../ArkadeServerConfigService";
import type { ArkadeServerDecayPolicyParams } from "../ArkadeServerDecayPolicy";
import type { ArkadeWalletSummary } from "../types/wallet";
import { withOutgoingBrowserApproval } from "./browserApproval";
import { emitTrace, logArkadeWalletSignTrace } from "./logging";
import { fetchArkNodeInfoWithRetry } from "./network";
import { assertArkadeRecoveryCsvCompatible } from "./recovery";
import {
  getArkadeClientRecoveryContractParamsForTimelock,
  type ArkadeRecoveryDefaultWallet,
} from "./recoveryDefaults";
import { settleWithBatchCommitment } from "./settleWithCommitment";
import { truncateForLog } from "./utils";
import {
  ARKADE_VTXO_RENEWAL_THRESHOLD_MS,
  assertArkadeRenewalDestinationHasDecayLeaves,
  capArkadeVtxoRenewalCoins,
  selectArkadeVtxoRenewalCandidates,
} from "./vtxoRenewalPolicy";
import { getOrCreateWallet } from "./walletCache";
import { loadArkadeWalletSummary } from "./walletSummary";

type RenewalCoin = {
  txid: string;
  vout: number;
  value: number;
  isSwept?: boolean;
  createdAt?: Date;
  expiresAt?: Date;
};

type RenewalWallet = ArkadeRecoveryDefaultWallet & {
  getAddress(): Promise<string>;
  getSpendableVtxos(filter?: { withRecoverable?: boolean }): Promise<RenewalCoin[]>;
  offchainTapscript?: {
    scripts?: Uint8Array[];
    options?: { csvTimelock?: ArkadeServerDecayPolicyParams["arkadeCsvTimelock"] };
  };
  settle(
    params?: { inputs: RenewalCoin[]; outputs: Array<{ address: string; amount: bigint }> },
    eventCallback?: (event: { type?: unknown; unsignedCommitmentTx?: unknown }) => void,
  ): Promise<string>;
};

export type ArkadeVtxoRenewalPlan = {
  inputs: RenewalCoin[];
  address: string;
  amountSats: bigint;
  inputSats: number;
};

/**
 * Price the selected coins the way the SDK's own renewal does (VtxoManager
 * `priceSettlementInputs` + `deductOffchainOutputFee`): drop a coin worth less
 * than its intent fee, then take the output fee off the total.
 */
function priceRenewal(
  coins: RenewalCoin[],
  address: string,
  intentFee: ConstructorParameters<typeof Estimator>[0],
): { inputs: RenewalCoin[]; amountSats: bigint; inputSats: number } {
  const estimator = new Estimator(intentFee ?? {});
  const inputs: RenewalCoin[] = [];
  let net = 0n;
  let inputSats = 0;
  for (const coin of coins) {
    const fee = estimator.evalOffchainInput({
      amount: BigInt(coin.value),
      type: coin.isSwept ? "recoverable" : "vtxo",
      weight: 0,
      birth: coin.createdAt,
      expiry: coin.expiresAt,
    }).satoshis;
    if (fee >= coin.value) continue;
    inputs.push(coin);
    net += BigInt(coin.value - fee);
    inputSats += coin.value;
  }
  if (estimator.config.offchainOutput && net > 0n) {
    const script = bytesToHex(ArkAddress.decode(address).pkScript);
    net -= BigInt(estimator.evalOffchainOutput({ amount: net, script }).satoshis);
  }
  return { inputs, amountSats: net, inputSats };
}

/**
 * Everything checked before the passkey is asked for: the due coins, the
 * destination's three decay leaves, and the priced amount. Throws rather than
 * returning a plan that would renew into the wrong script or below dust.
 */
export async function planArkadeVtxoRenewal(wallet: RenewalWallet): Promise<ArkadeVtxoRenewalPlan> {
  // Same read the SDK's renewVtxos uses: skips intent-locked, gated and
  // deprecated-signer coins that a raw getVtxos would offer.
  const vtxos = await wallet.getSpendableVtxos({ withRecoverable: false });
  const { candidates } = selectArkadeVtxoRenewalCandidates(vtxos, ARKADE_VTXO_RENEWAL_THRESHOLD_MS);
  if (candidates.length === 0) {
    throw new Error("vtxo renewal: no vtxos due");
  }
  // Renewal keeps the same script: the settle pays the wallet's current Ark
  // address, so that address must still be exactly the decay-policy script.
  const address = await wallet.getAddress();
  const params = await getArkadeClientRecoveryContractParamsForTimelock(
    wallet,
    wallet.offchainTapscript?.options?.csvTimelock,
  );
  assertArkadeRenewalDestinationHasDecayLeaves({
    destinationPkScript: ArkAddress.decode(address).pkScript,
    destinationLeafScripts: wallet.offchainTapscript?.scripts ?? [],
    params,
  });
  const info = await fetchArkNodeInfoWithRetry(
    arkadeServerConfigService.getArkadeNodeUrl().replace(/\/+$/, ""),
  );
  // One output may not exceed the node's VTXO maximum, or the settle is
  // refused on every retry.
  const capped = capArkadeVtxoRenewalCoins(candidates, Number(info.vtxoMaxAmount ?? -1));
  if (capped.length === 0) {
    throw new Error(
      `vtxo renewal: every due coin exceeds vtxoMaxAmount=${String(info.vtxoMaxAmount)}`,
    );
  }
  const priced = priceRenewal(capped, address, info.fees?.intentFee ?? {});
  if (priced.inputs.length === 0 || priced.amountSats < BigInt(info.dust ?? 0n)) {
    throw new Error(
      `vtxo renewal: amount below dust net=${priced.amountSats} dust=${String(info.dust)}`,
    );
  }
  return {
    inputs: priced.inputs,
    address,
    amountSats: priced.amountSats,
    inputSats: priced.inputSats,
  };
}

/** Unlock-modal step: one passkey touch, one settle into a fresh batch. */
export async function renewArkadeExpiringVtxosManual(): Promise<ArkadeWalletSummary> {
  const startedAtMs = Date.now();
  const wallet = (await getOrCreateWallet()) as unknown as RenewalWallet;
  await assertArkadeRecoveryCsvCompatible(
    wallet as unknown as Parameters<typeof assertArkadeRecoveryCsvCompatible>[0],
    "vtxo_renewal",
  );
  const plan = await planArkadeVtxoRenewal(wallet);
  const amountSats = Number(plan.amountSats);
  logArkadeWalletSignTrace("vtxo_renewal_plan", {
    status: "approval_required",
    vtxos: plan.inputs.length,
    input_sats: plan.inputSats,
    output_sats: amountSats,
    threshold_ms: ARKADE_VTXO_RENEWAL_THRESHOLD_MS,
    expected_next: "arkade_settle_send_prepare_then_passkey",
  });
  try {
    const txid = await withOutgoingBrowserApproval(
      {
        kind: "arkade_settle",
        title: "Approve Arkade Settle",
        amountSats,
        recipient: plan.address,
        note: "Renew Arkade VTXOs before their batch expires.",
        source: "vtxo_renewal",
        approvalScope: "direct_session",
      },
      () =>
        settleWithBatchCommitment(wallet, {
          inputs: plan.inputs,
          outputs: [{ address: plan.address, amount: plan.amountSats }],
        }),
      { detail: `flow=arkade.vtxo_renewal vtxos=${plan.inputs.length} sats=${amountSats}` },
    );
    emitTrace({
      atMs: Date.now(),
      op: "ark_vtxo_renewal",
      status: "ok",
      id: String(txid || "") || undefined,
      detail: `vtxos=${plan.inputs.length} sats=${amountSats} txid=${String(txid || "n/a")} durMs=${Date.now() - startedAtMs}`,
    });
  } catch (error: unknown) {
    emitTrace({
      atMs: Date.now(),
      op: "ark_vtxo_renewal",
      status: "failed",
      detail: `vtxos=${plan.inputs.length} err=${truncateForLog(error instanceof Error ? error.message : String(error || "unknown"), 170)}`,
    });
    throw error;
  }
  const summary = await loadArkadeWalletSummary({
    scheduleAutoClaim: false,
    scheduleAutoRecover: false,
    scheduleAutoSettle: false,
    scheduleAutoBoardingSweep: false,
    forceFresh: true,
  });
  try {
    EventBus.emit("bitcoin:refresh");
    EventBus.emit("transactions:refresh");
  } catch {}
  return summary;
}
