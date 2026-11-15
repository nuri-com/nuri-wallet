// Runs a card withdrawal straight onchain when the Wirex route is down (#1956).
//
// The owner's wallet signs both steps of the card account's delayed withdrawal
// and sends each one itself through EntryPoint v0.7 `handleOps`. Gas comes from
// the app's Base gas dripper; the card account pays nothing (zero-fee
// operations, see lib/wirex/directWithdraw.ts).
//
// Money moves only in the FINAL step, so that step alone gets a durable record,
// written right before its transaction is broadcast. Until that record is
// settled from the chain, the card's shared withdrawal lock stays held. A
// request on its own moves nothing: an interrupted one leaves a schedule that
// the next attempt for the same amount finds and finishes instead of asking
// for a second.
//
// Every chain and key access comes in through `deps`, so the flow is testable
// without the device key store, the RPC or the Wirex service.

import { getAddress, keccak256, type Address, type Hex, type LocalAccount } from "viem";
import { entryPoint07Abi, type UserOperation } from "viem/account-abstraction";
import { ENTRY_POINT } from "../../lib/wirex/aaSelfhostClient";
import {
  buildDirectWithdrawContext,
  handleOpsCallData,
  hasSettlementTransfer,
  prepareDirectFinal,
  prepareDirectRequest,
  readWithdrawSchedule,
  signedUserOperation,
  userOperationOutcome,
  type ChainReceipt,
  type DirectWithdrawAsset,
  type DirectWithdrawRecord,
} from "../../lib/wirex/directWithdraw";

export type GasReadiness = "sufficient" | "insufficient" | "unknown";

export type DirectWithdrawDeps = {
  publicClient: any;
  chainId: number;
  registry: Address;
  /** Unlocks the wallet key once; the account signs one step's hash and transaction. */
  loadAccount: () => Promise<LocalAccount>;
  /** The Base gas dripper: tops the wallet up to `minWei` when it can. */
  ensureGas: (address: Address, minWei: bigint) => Promise<GasReadiness>;
  writeRecord: (record: DirectWithdrawRecord) => Promise<void>;
  clearRecord: () => Promise<void>;
  /** The error for an outcome that is not known yet: never retried, the lock stays. */
  unconfirmed: () => Error;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  trace?: (label: string, data?: unknown) => void;
};

export type DirectWithdrawResult = {
  amount: string;
  asset: DirectWithdrawAsset;
  /** The request step's transaction; empty when an existing schedule was finished. */
  firstTxHash: string;
  finalTxHash: string;
};

const RECEIPT_POLL_MS = 2_000;
const REQUEST_RECEIPT_TIMEOUT_MS = 90_000;
const FINAL_RECEIPT_TIMEOUT_MS = 120_000;
const RECONCILE_RECEIPT_TIMEOUT_MS = 30_000;
const SCHEDULE_READ_TIMEOUT_MS = 30_000;
/** A schedule closer than this to closing is not worth finishing; a new one is requested. */
const SCHEDULE_MIN_REMAINING_MS = 60_000;
/** The delay policy compares against the block time, which trails the clock a little. */
const VALID_AFTER_MARGIN_MS = 3_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A node that answered and refused the transaction: it is not in any mempool
// and never will be. Anything else (timeouts, dropped connections, "already
// known", "nonce too low" after a resend) may still have reached the chain.
const DEFINITE_REJECTION =
  /insufficient funds|intrinsic gas too low|underpriced|fee cap|less than block base fee|exceeds block gas limit/i;

function errorText(error: unknown): string {
  const e = error as { shortMessage?: unknown; details?: unknown; message?: unknown } | null;
  return [e?.shortMessage, e?.details, e?.message].filter(Boolean).map(String).join(" ");
}

export function isDefiniteBroadcastRejection(error: unknown): boolean {
  return DEFINITE_REJECTION.test(errorText(error));
}

async function readReceipt(publicClient: any, hash: Hex): Promise<ChainReceipt | null> {
  try {
    return (await publicClient.getTransactionReceipt({ hash })) as ChainReceipt;
  } catch {
    return null;
  }
}

async function waitForReceipt(
  deps: DirectWithdrawDeps,
  hash: Hex,
  raw: Hex,
  timeoutMs: number,
): Promise<ChainReceipt | null> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    const receipt = await readReceipt(deps.publicClient, hash);
    if (receipt) return receipt;
    if (now() >= deadline) return null;
    // The very same signed transaction again, never a replacement: it either
    // lands once or not at all.
    if (attempt > 0 && attempt % 5 === 0) {
      await deps.publicClient.sendRawTransaction({ serializedTransaction: raw }).catch(() => {});
    }
    await sleep(RECEIPT_POLL_MS);
  }
}

type SignedSend = { hash: Hex; raw: Hex };

/**
 * Signs the wallet's `handleOps` transaction for one operation, after making
 * sure the wallet can pay for it. Estimated with a plain eth_estimateGas (no
 * fee fields), so an empty wallet still gets a gas figure to ask the dripper
 * for.
 */
async function signHandleOps(
  deps: DirectWithdrawDeps,
  account: LocalAccount,
  userOp: UserOperation<"0.7">,
): Promise<SignedSend> {
  const { publicClient } = deps;
  const data = handleOpsCallData(userOp, account.address);
  const estimate = BigInt(
    await publicClient.request({
      method: "eth_estimateGas",
      params: [{ from: account.address, to: ENTRY_POINT.address, data }],
    }),
  );
  const gas = (estimate * 12n) / 10n;
  const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
  const readiness = await deps.ensureGas(account.address, gas * maxFeePerGas);
  deps.trace?.("direct withdraw gas", { gas: gas.toString(), readiness });
  if (readiness === "insufficient") throw new Error("direct_withdraw_no_gas");
  const nonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const raw = (await account.signTransaction({
    chainId: deps.chainId,
    type: "eip1559",
    to: ENTRY_POINT.address,
    data,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    value: 0n,
  })) as Hex;
  return { hash: keccak256(raw), raw };
}

/** Signs one step: the operation hash first, then the transaction that carries it. One key unlock. */
async function signStep(
  deps: DirectWithdrawDeps,
  wallet: Address,
  phase: "request" | "final",
  userOp: UserOperation<"0.7">,
  userOpHash: Hex,
): Promise<SignedSend> {
  const account = await deps.loadAccount();
  if (getAddress(account.address) !== wallet) throw new Error("direct_withdraw_signer_mismatch");
  const signature = await account.signMessage({ message: { raw: userOpHash } });
  const signingCtx = await buildDirectWithdrawContext(
    deps.publicClient,
    wallet,
    deps.registry,
    signature,
  );
  const signed = await signedUserOperation(signingCtx, phase, userOp, signature);
  return signHandleOps(deps, account, signed);
}

async function waitForSchedule(
  deps: DirectWithdrawDeps,
  delayPolicyAddress: Address,
  key: Parameters<typeof readWithdrawSchedule>[2],
) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + SCHEDULE_READ_TIMEOUT_MS;
  for (;;) {
    const schedule = await readWithdrawSchedule(deps.publicClient, delayPolicyAddress, key).catch(
      (): null => null,
    );
    if (schedule?.scheduled) return schedule;
    if (now() >= deadline) throw new Error("direct_withdraw_schedule_missing");
    await sleep(RECEIPT_POLL_MS);
  }
}

export async function runDirectWithdraw(
  deps: DirectWithdrawDeps,
  {
    wallet: walletInput,
    amount,
    asset,
    onRequestApproved,
    onSubmitted,
  }: {
    wallet: string;
    amount: string;
    asset: DirectWithdrawAsset;
    onRequestApproved?: () => void;
    onSubmitted?: () => void;
  },
): Promise<DirectWithdrawResult> {
  const { publicClient, chainId, registry } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const trace = deps.trace ?? (() => {});
  const wallet = getAddress(walletInput);

  const ctx = await buildDirectWithdrawContext(publicClient, wallet, registry);
  const request = await prepareDirectRequest(publicClient, ctx, {
    amount,
    asset,
    chainId,
    registry,
  });
  const scheduleKey = {
    kernelAddress: ctx.kernelAddress,
    executionCallData: request.executionCallData,
    executionNonce: request.executionNonce,
  };
  trace("direct withdraw prepared", { kind: ctx.kind, card: ctx.kernelAddress, asset, amount });

  // An earlier attempt for this exact withdrawal may have scheduled it already.
  // Finish that one: its final step has the same nonce, so only one can run.
  let schedule = await readWithdrawSchedule(publicClient, ctx.delayPolicyAddress, scheduleKey);
  const reusable =
    schedule.scheduled &&
    (schedule.validUntilMs === 0 || schedule.validUntilMs - now() > SCHEDULE_MIN_REMAINING_MS);
  let firstTxHash = "";
  if (reusable) {
    trace("direct withdraw: finishing the existing schedule");
  } else {
    const sent = await signStep(deps, wallet, "request", request.userOp, request.userOpHash);
    try {
      await publicClient.sendRawTransaction({ serializedTransaction: sent.raw });
    } catch (error) {
      // Nothing moves without the final step, so a refused request is a plain failure.
      if (isDefiniteBroadcastRejection(error)) throw new Error("direct_withdraw_request_rejected");
      trace("direct withdraw request broadcast unanswered", { message: errorText(error) });
    }
    trace("direct withdraw request sent", { tx: sent.hash });
    const receipt = await waitForReceipt(deps, sent.hash, sent.raw, REQUEST_RECEIPT_TIMEOUT_MS);
    if (!receipt) throw new Error("direct_withdraw_request_unconfirmed");
    if (
      userOperationOutcome(receipt, {
        userOpHash: request.userOpHash,
        sender: ctx.kernelAddress,
      }) !== "succeeded"
    ) {
      throw new Error("direct_withdraw_request_failed");
    }
    firstTxHash = sent.hash;
    schedule = await waitForSchedule(deps, ctx.delayPolicyAddress, scheduleKey);
  }
  try {
    onRequestApproved?.();
  } catch {}

  const waitMs = schedule.validAfterMs - now() + VALID_AFTER_MARGIN_MS;
  if (waitMs > 0) {
    trace("direct withdraw waiting for the delay", { ms: waitMs });
    await sleep(waitMs);
  }
  if (schedule.validUntilMs > 0 && now() >= schedule.validUntilMs) {
    throw new Error("direct_withdraw_schedule_expired");
  }

  const final = await prepareDirectFinal(ctx, request.executionCallData, chainId);
  if (final.userOp.nonce !== request.executionNonce) {
    // The scheduled call already ran (or another one took its nonce).
    throw new Error("direct_withdraw_schedule_spent");
  }
  const sent = await signStep(deps, wallet, "final", final.userOp, final.userOpHash);
  const record: DirectWithdrawRecord = {
    kind: "direct",
    at: now(),
    wallet,
    kernelAddress: ctx.kernelAddress,
    asset,
    amount: amount.trim(),
    baseToken: request.base.address,
    baseAmount: request.baseAmount.toString(),
    requestTxHash: firstTxHash as Hex | "",
    finalTxHash: sent.hash,
    finalRawTx: sent.raw,
    finalUserOpHash: final.userOpHash,
    finalOpNonce: final.userOp.nonce.toString(),
    validUntilMs: schedule.validUntilMs,
  };
  // The point of no return: the record exists before the transaction can.
  await deps.writeRecord(record);
  try {
    await publicClient.sendRawTransaction({ serializedTransaction: sent.raw });
  } catch (error) {
    if (isDefiniteBroadcastRejection(error)) {
      await deps.clearRecord();
      throw new Error("direct_withdraw_final_rejected");
    }
    trace("direct withdraw final broadcast unanswered", { message: errorText(error) });
  }
  trace("direct withdraw final sent", { tx: sent.hash });
  try {
    onSubmitted?.();
  } catch {}

  const settled = await settleFinal(deps, record, FINAL_RECEIPT_TIMEOUT_MS);
  if (settled.status === "failed") throw new Error("direct_withdraw_failed");
  // It ran and cannot run again, but whether it paid is only in the balances.
  if (settled.status === "ran") throw deps.unconfirmed();
  return { ...settled.result, firstTxHash };
}

/**
 * Where the recorded final operation stands without its receipt, from the
 * chain alone: "ran" once the card account's nonce for it has moved on (it ran
 * in this transaction or another and can never run again; its outcome is in
 * the balances), "expired" once the schedule has closed by the chain's own
 * clock with the nonce unspent (it can no longer validate, nothing moved),
 * otherwise "open". Any read that fails answers "open": only evidence
 * releases the lock.
 */
async function finalStanding(
  deps: DirectWithdrawDeps,
  record: DirectWithdrawRecord,
): Promise<"open" | "ran" | "expired"> {
  try {
    const opNonce = BigInt(record.finalOpNonce);
    const block = await deps.publicClient.getBlock({ blockTag: "latest" });
    const current: bigint = await deps.publicClient.readContract({
      address: ENTRY_POINT.address,
      abi: entryPoint07Abi,
      functionName: "getNonce",
      args: [record.kernelAddress, opNonce >> 64n],
      blockNumber: block.number,
    });
    if (current > opNonce) return "ran";
    const chainTimeMs = Number(block.timestamp) * 1000;
    return record.validUntilMs > 0 && chainTimeMs > record.validUntilMs ? "expired" : "open";
  } catch {
    return "open";
  }
}

type FinalOutcome =
  | { status: "paid"; result: DirectWithdrawResult }
  | { status: "failed" }
  | { status: "ran" };

/**
 * The final step's outcome from the chain, record cleared once it is settled:
 * "paid" with the payout in its receipt, "failed" when it failed or can
 * provably never run, "ran" when it can never run again but its receipt is
 * not readable. Throws `unconfirmed` while it may still run. Age is never an
 * answer: a signed transaction can land at any time.
 */
async function settleFinal(
  deps: DirectWithdrawDeps,
  record: DirectWithdrawRecord,
  timeoutMs: number,
): Promise<FinalOutcome> {
  const receipt = await waitForReceipt(deps, record.finalTxHash, record.finalRawTx, timeoutMs);
  if (!receipt) {
    const standing = await finalStanding(deps, record);
    if (standing === "open") throw deps.unconfirmed();
    deps.trace?.("direct withdraw final can no longer run: releasing", {
      tx: record.finalTxHash,
      standing,
    });
    await deps.clearRecord();
    return standing === "ran" ? { status: "ran" } : { status: "failed" };
  }
  let outcome: "succeeded" | "failed";
  try {
    outcome = userOperationOutcome(receipt, {
      userOpHash: record.finalUserOpHash,
      sender: record.kernelAddress,
    });
  } catch {
    throw deps.unconfirmed();
  }
  if (outcome === "failed") {
    await deps.clearRecord();
    return { status: "failed" };
  }
  const paid = hasSettlementTransfer(receipt, {
    token: record.baseToken,
    from: record.kernelAddress,
    to: record.wallet,
    amount: BigInt(record.baseAmount),
  });
  // The step ran but the payout is not where it should be: not a completion.
  if (!paid) throw deps.unconfirmed();
  await deps.clearRecord();
  return {
    status: "paid",
    result: {
      amount: record.amount,
      asset: record.asset,
      firstTxHash: record.requestTxHash,
      finalTxHash: record.finalTxHash,
    },
  };
}

/** Settles a direct withdrawal left behind by an earlier run (restart, lost answer). Never signs. */
export async function reconcileDirectWithdraw(
  deps: DirectWithdrawDeps,
  record: DirectWithdrawRecord,
  { once = false }: { once?: boolean } = {},
): Promise<DirectWithdrawResult | null> {
  // The app may have stopped between writing the record and broadcasting.
  // Sending the very same signed transaction again is harmless either way.
  await deps.publicClient
    .sendRawTransaction({ serializedTransaction: record.finalRawTx })
    .catch(() => {});
  const settled = await settleFinal(deps, record, once ? 0 : RECONCILE_RECEIPT_TIMEOUT_MS);
  return settled.status === "paid" ? settled.result : null;
}
