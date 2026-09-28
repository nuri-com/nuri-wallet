/**
 * Permissionless recovery of stuck Satora HTLC swaps.
 *
 * A Satora EVM->BTC swap locks the BTC-pegged token (tBTC/WBTC) in an
 * HTLCCoordinator, funded by the user's Permit2 signature. When the BTC side
 * never claims and the swap record is lost (dropped client row, wallet-keyless
 * server), the funds sit in the coordinator until the timelock passes — after
 * which `refundTo` is PERMISSIONLESS and always pays the recorded depositor,
 * regardless of who broadcasts it.
 *
 * The swapkit server (`swap_sweep` -> `refundable[]`) detects these locks by
 * scanning the chain and hands us the on-chain fields. This service takes those
 * fields, re-verifies them against the coordinator's own `deposits` mapping (so
 * we never sign for a lock that would pay someone else), and broadcasts the
 * refund from the depositor wallet. Only gas on the lock's chain is needed.
 *
 * Generalized from the retired one-shot debug/SatoraCollabRefundService.ts:
 * every address is a parameter — there are multiple Satora deployments
 * (different HTLC/coordinator per generation), so NOTHING is hardcoded.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { bytesToHex, zeroize } from "../../lib/crypto";
import { getChainFallbackRpcUrl, getChainRpcUrl } from "../../lib/rpc/chainRpc";
import { getEthereumAddress, getPrivateKey } from "../../lib/secureKeyStorage";
import { getSweepViemChain } from "./SwapKitEvmSigner";

/** One refundable HTLC lock, as surfaced by the server's swap_sweep `refundable[]`. */
export type SatoraRefundableLock = {
  /**
   * SwapCreated `preimageHash` — the FIRST argument `refundTo` takes. The
   * coordinator derives the swap key from it and pays the depositor recorded
   * under that key. This is NOT the swap key the event carries in its data tail:
   * passing the key derives a key nobody deposited under and the call reverts
   * `UnknownHtlc` (0xbd697b55) — the bug that kept the live lock unrefundable.
   */
  preimageHash: string;
  /**
   * SwapCreated `key` (keccak of all six lock fields), which the HTLC's `swaps`
   * mapping and the coordinator's `deposits` mapping are keyed by. We derive it
   * ourselves for the deposits check and only use this to cross-check the server.
   */
  key?: string;
  chainId: number;
  /** HTLCCoordinator that holds the deposit and exposes refundTo. */
  coordinatorAddress: string;
  /** BTC-pegged token locked (tBTC/WBTC). */
  token: string;
  /** The satora server address the lock claims to (SwapCreated claimAddress). */
  claimAddress: string;
  /** Locked amount, raw units, as a decimal string. */
  amountRaw: string;
  /** Unix seconds; refundTo reverts until now >= timelock. */
  timelock: number;
  /** True once now >= timelock. */
  refundable?: boolean;
};

const same = (a: unknown, b: unknown): boolean =>
  String(a || "").toLowerCase() === String(b || "").toLowerCase();

/**
 * Trusted Satora HTLC coordinator deployments, per chainId. The coordinator
 * address arrives inside the untrusted server response, and we sign a state-
 * changing `refundTo` to it — so the `deposits(key)` owner check alone is not a
 * trust anchor (a compromised server could return a look-alike contract whose
 * `deposits` returns this wallet and whose `refundTo` does something else, and
 * simulation only proves that contract's own code succeeds). We therefore only
 * ever sign to a coordinator whose deployment we already know. This mirrors the
 * server's canonical `DEFAULT_REFUNDABLE_COORDINATOR_ADDRESSES`; extend it when
 * a new Satora generation is deployed and reviewed. Per-lock fields (preimageHash,
 * amount, token, claimAddress, timelock) stay fully parameterized — only the
 * coordinator deployment is pinned.
 */
const TRUSTED_COORDINATORS: Readonly<Record<number, readonly string[]>> = {
  // Arbitrum One
  42161: [
    "0xdb76F29f1d04D1202f56a34549869b070DFcBfF0", // current generation
    "0x5B7cDa892cF870156bcb9a710249830Fa1Fc67Be", // prior deployment (debug/collab)
  ],
};

export const isTrustedSatoraCoordinator = (chainId: number, coordinator: string): boolean =>
  (TRUSTED_COORDINATORS[chainId] ?? []).some((a) => same(a, coordinator));

/**
 * In-flight refund journal. A broadcast refund whose receipt read failed (or
 * that is still pending) leaves the lock on-chain until it confirms, so the
 * server scan keeps offering it — without a durable record of the hash, the
 * next tap broadcasts a duplicate nonce transaction. Keyed by chainId:preimageHash,
 * holds the network-assigned tx hash from the moment writeContract returns.
 */
export type InFlightRefund = {
  txHash: string;
  broadcastAtMs: number;
  /** Explicit nonce used by the refund; required to prove a missing tx was dropped/replaced. */
  nonce?: number;
  from?: string;
};

export type RefundRetryDecision = "rebroadcast" | "skip-in-flight" | "already-claimed";

/**
 * Pure decision for a lock with a prior broadcast record: reverted → fresh
 * attempt; still pending OR unavailable from this RPC → do NOT duplicate;
 * confirmed → the lock is consumed, nothing to do. Elapsed time alone is never
 * evidence that an EVM transaction was dropped — a receipt lookup has the same
 * empty/error result for a live mempool transaction and an RPC/indexing failure.
 */
export function decideRefundRetry(opts: {
  record?: InFlightRefund | null;
  receipt?: { status: string } | null;
  /** True only after both configured RPCs prove hash absent and nonce no longer pending. */
  conclusivelyDroppedOrReplaced?: boolean;
}): RefundRetryDecision {
  const { record, receipt, conclusivelyDroppedOrReplaced = false } = opts;
  if (!record) return "rebroadcast";
  if (receipt?.status === "success") return "already-claimed";
  if (receipt?.status === "reverted" || conclusivelyDroppedOrReplaced) return "rebroadcast";
  return "skip-in-flight";
}

const IN_FLIGHT_STORAGE_KEY = "nuri.txcache.swapkit.satoraRefundInFlight.v1";
const inFlightMemory = new Map<string, InFlightRefund>();

/** keccak of the lock's six fields: the swap key the HTLC's `swaps` mapping and the coordinator's
 * `deposits` mapping are keyed by, and therefore the lock's real identity. */
function swapKeyFor(lock: SatoraRefundableLock): `0x${string}` {
  return computeHtlcKey({
    preimageHash: lock.preimageHash as `0x${string}`,
    amount: BigInt(lock.amountRaw),
    token: lock.token as `0x${string}`,
    coordinatorAddress: lock.coordinatorAddress as `0x${string}`,
    claimAddress: lock.claimAddress as `0x${string}`,
    timelock: BigInt(lock.timelock),
  });
}

/**
 * The refund journal's identity for one lock: chain + the full swap key.
 *
 * Deliberately NOT the preimage hash. The contract lets any number of distinct locks share one
 * preimage hash as long as amount, token, claim address, coordinator or timelock differ — each then
 * has its own swap key and its own deposit record. Keyed by the preimage hash, the second such lock
 * reads the first one's in-flight record and reports "pending" or "confirmed" without ever being
 * refunded. The swap key commits to all six fields (coordinator included), so chain + key is the
 * complete identity.
 */
export function refundJournalKey(lock: SatoraRefundableLock): string {
  return `${lock.chainId}:${swapKeyFor(lock).toLowerCase()}`;
}

async function readInFlightJournal(): Promise<Record<string, InFlightRefund>> {
  let durable: Record<string, InFlightRefund> = {};
  try {
    const raw = await AsyncStorage.getItem(IN_FLIGHT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        durable = parsed as Record<string, InFlightRefund>;
      }
    }
  } catch (e) {
    // Reads may fail transiently; the process-local map still guards every hash
    // broadcast in this session.
    console.log(
      `[SatoraHtlcRefund] failed to read refund journal: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const [id, record] of inFlightMemory) durable[id] = record;
  return durable;
}

async function getInFlightRefund(lock: SatoraRefundableLock): Promise<InFlightRefund | null> {
  return (await readInFlightJournal())[refundJournalKey(lock)] ?? null;
}

/**
 * Keep the process guard before touching storage, then use AsyncStorage directly
 * (its web implementation rejects quota/unavailable localStorage) and read back
 * the exact hash. Unlike TransactionCacheService.web, failures are observable.
 */
async function recordInFlightRefund(
  lock: SatoraRefundableLock,
  record: InFlightRefund,
): Promise<boolean> {
  const id = refundJournalKey(lock);
  inFlightMemory.set(id, record);
  try {
    const journal = await readInFlightJournal();
    journal[id] = record;
    await AsyncStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(journal));
    const persisted = await AsyncStorage.getItem(IN_FLIGHT_STORAGE_KEY);
    const readBack = persisted
      ? (JSON.parse(persisted) as Record<string, InFlightRefund>)[id]
      : null;
    if (readBack?.txHash !== record.txHash) throw new Error("refund journal read-back mismatch");
    return true;
  } catch (e) {
    console.log(
      `[SatoraHtlcRefund] refund hash is guarded in memory but durable journal failed hash=${record.txHash}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

async function clearInFlightRefund(lock: SatoraRefundableLock): Promise<void> {
  const id = refundJournalKey(lock);
  inFlightMemory.delete(id);
  try {
    const journal = await readInFlightJournal();
    if (id in journal) {
      delete journal[id];
      await AsyncStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(journal));
    }
  } catch (e) {
    // A stale durable record is safe: next reconciliation reads the confirmed or
    // reverted receipt and attempts this cleanup again.
    console.log(
      `[SatoraHtlcRefund] failed to clear refund journal: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

const REFUND_TO_ABI = [
  {
    name: "refundTo",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "preimageHash", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "claimAddress", type: "address" },
      { name: "timelock", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const COORDINATOR_DEPOSITS_ABI = [
  {
    name: "deposits",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ name: "depositor", type: "address" }],
  },
] as const;

/**
 * HTLCErc20._key — keccak of the six lock fields. `refundAddress` is the
 * coordinator itself (the SwapCreated refundAddress), NOT the user; the
 * coordinator records the real depositor in `deposits[key]`.
 */
function computeHtlcKey(params: {
  preimageHash: `0x${string}`;
  amount: bigint;
  token: `0x${string}`;
  coordinatorAddress: `0x${string}`;
  claimAddress: `0x${string}`;
  timelock: bigint;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        params.preimageHash,
        params.amount,
        params.token,
        params.coordinatorAddress,
        params.claimAddress,
        params.timelock,
      ],
    ),
  );
}

function publicClientForUrl(chainId: number, rpc?: string) {
  const chain = getSweepViemChain(chainId);
  if (!chain) throw new Error(`unsupported refund chain ${chainId}`);
  return createPublicClient({ chain, transport: http(rpc || undefined) });
}

function publicClientFor(chainId: number) {
  return publicClientForUrl(
    chainId,
    getChainRpcUrl(chainId as Parameters<typeof getChainRpcUrl>[0]),
  );
}

export type RefundTxProbe = {
  txVisible: boolean | null;
  pendingNonce: number | null;
  latestNonce: number | null;
  receipt: { status: string } | null;
};

/**
 * Missing from one RPC is not proof. A drop/replacement is conclusive only when
 * both independent configured RPCs can answer, both cannot find the hash, and
 * each either sees that nonce already mined or sees no pending nonce above it.
 */
export function isConclusiveRefundDrop(
  record: InFlightRefund,
  probes: readonly RefundTxProbe[],
): boolean {
  const nonce = record.nonce;
  if (!Number.isSafeInteger(nonce) || nonce === undefined || probes.length < 2) {
    return false;
  }
  return probes.every(
    (probe) =>
      probe.txVisible === false &&
      probe.pendingNonce !== null &&
      probe.latestNonce !== null &&
      (probe.latestNonce > nonce || probe.pendingNonce <= nonce),
  );
}

async function probeRefundTransaction(
  chainId: number,
  rpc: string,
  record: InFlightRefund,
): Promise<RefundTxProbe> {
  const client = publicClientForUrl(chainId, rpc);
  const hash = record.txHash as `0x${string}`;
  const from = record.from as `0x${string}`;
  const receipt = await client
    .getTransactionReceipt({ hash })
    .then((r) => ({ status: r.status }))
    .catch((): null => null);
  const txVisible = await client
    .getTransaction({ hash })
    .then(() => true)
    .catch((e: unknown): boolean | null =>
      e instanceof Error &&
      /TransactionNotFound|could not be found|not found/i.test(`${e.name} ${e.message}`)
        ? false
        : null,
    );
  if (!from) return { receipt, txVisible, pendingNonce: null, latestNonce: null };
  const [pendingNonce, latestNonce] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: "pending" }).catch((): null => null),
    client.getTransactionCount({ address: from, blockTag: "latest" }).catch((): null => null),
  ]);
  return { receipt, txVisible, pendingNonce, latestNonce };
}

export type SatoraRefundVerification = {
  /** The address the coordinator will pay — must equal the wallet to proceed. */
  depositor: `0x${string}`;
  ownsIt: boolean;
  /** Native gas balance of the wallet on the lock's chain. */
  gasBalance: bigint;
};

/**
 * Read the coordinator's `deposits[key]` for this lock and confirm it pays the
 * given wallet. refundTo pays this depositor no matter who calls, so this is the
 * one check that matters before we spend gas.
 */
export async function verifySatoraRefundable(
  lock: SatoraRefundableLock,
  wallet: string,
): Promise<SatoraRefundVerification> {
  const client = publicClientFor(lock.chainId);
  const key = swapKeyFor(lock);
  if (lock.key && !same(key, lock.key)) {
    // The server's key and our own derivation disagree, so one of the six fields we
    // were handed is not the lock the coordinator deposited under. Refusing here is
    // what keeps a wrong lock from spending gas on a revert.
    throw new Error(
      `refundable lock key mismatch: deposits key ${key} but the server sent ${lock.key}`,
    );
  }
  const [deposits, gasBalance] = await Promise.all([
    // simulateContract, not readContract: this repo's viem types reject the
    // latter's parameter object (it demands authorizationList).
    client.simulateContract({
      address: lock.coordinatorAddress as `0x${string}`,
      abi: COORDINATOR_DEPOSITS_ABI,
      functionName: "deposits",
      args: [key],
    }),
    client.getBalance({ address: wallet as `0x${string}` }),
  ]);
  const depositor = deposits.result as `0x${string}`;
  return { depositor, ownsIt: same(depositor, wallet), gasBalance };
}

export type SatoraRefundExecutionResult = {
  txHash: string;
  /** Only `confirmed` means the lock was recovered; `pending` must not be counted as success. */
  status: "confirmed" | "pending";
};

/**
 * Broadcast `refundTo` from the depositor wallet. Simulates first (so an
 * unexpired timelock or a wrong-depositor lock costs nothing), then sends. The
 * private key never leaves the device and is zeroized right after the account
 * is derived. Returns the tx hash plus an explicit confirmation state.
 */
export async function executeSatoraRefund(
  lock: SatoraRefundableLock,
  onProgress?: (step: string) => void,
): Promise<SatoraRefundExecutionResult> {
  const eoa = await getEthereumAddress();
  if (!eoa) throw new Error("Ethereum wallet address is missing.");

  // The coordinator target comes from the untrusted server. Never sign a
  // state-changing call to a contract we don't already know, even if its
  // deposits/simulation look right (see TRUSTED_COORDINATORS).
  if (!isTrustedSatoraCoordinator(lock.chainId, lock.coordinatorAddress)) {
    throw new Error(
      `coordinator ${lock.coordinatorAddress} on chain ${lock.chainId} is not an allowlisted Satora deployment — refusing`,
    );
  }

  // In-flight journal BEFORE the ownership check: a lock we already refunded
  // reads depositor=zero once consumed, which would surface as a misleading
  // "pays someone else" refusal. Reconcile the prior broadcast first.
  const prior = await getInFlightRefund(lock);
  if (prior) {
    const chainId = lock.chainId as Parameters<typeof getChainRpcUrl>[0];
    const rpcs = [getChainRpcUrl(chainId), getChainFallbackRpcUrl(chainId)].filter(
      (rpc, index, all): rpc is string => Boolean(rpc) && all.indexOf(rpc) === index,
    );
    const probes = await Promise.all(
      rpcs.map((rpc) => probeRefundTransaction(lock.chainId, rpc, prior)),
    );
    const priorReceipt = probes.find((probe) => probe.receipt)?.receipt ?? null;
    const conclusivelyDroppedOrReplaced = isConclusiveRefundDrop(prior, probes);
    const decision = decideRefundRetry({
      record: prior,
      receipt: priorReceipt,
      conclusivelyDroppedOrReplaced,
    });
    if (decision === "already-claimed") {
      console.log(
        `[SatoraHtlcRefund] ${lock.preimageHash.slice(0, 12)}… already refunded in ${prior.txHash} — nothing to do`,
      );
      await clearInFlightRefund(lock);
      return { txHash: prior.txHash, status: "confirmed" };
    }
    if (decision === "skip-in-flight") {
      console.log(
        `[SatoraHtlcRefund] ${lock.preimageHash.slice(0, 12)}… refund ${prior.txHash} still pending — not duplicating`,
      );
      return { txHash: prior.txHash, status: "pending" };
    }
    // A proven revert, or absence proven independently by both RPCs together
    // with nonce state, leaves the lock eligible for a fresh attempt. A mere
    // missing receipt never reaches here.
    await clearInFlightRefund(lock);
  }

  onProgress?.("verifying lock");
  const verified = await verifySatoraRefundable(lock, eoa);
  if (!verified.ownsIt) {
    throw new Error(`coordinator pays ${verified.depositor}, not this wallet — refusing`);
  }
  if (verified.gasBalance <= 0n) {
    throw new Error("no gas on the lock's chain to broadcast the refund");
  }

  const client = publicClientFor(lock.chainId);
  const chain = getSweepViemChain(lock.chainId);
  const keyBytes = await getPrivateKey("ethereum");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`);
  } finally {
    zeroize(keyBytes);
  }
  if (!same(account.address, eoa)) {
    throw new Error("derived signer does not match the wallet");
  }

  const args = [
    lock.preimageHash as `0x${string}`,
    BigInt(lock.amountRaw),
    lock.token as `0x${string}`,
    lock.claimAddress as `0x${string}`,
    BigInt(lock.timelock),
  ] as const;

  onProgress?.("simulating refundTo");
  const { request } = await client.simulateContract({
    account,
    address: lock.coordinatorAddress as `0x${string}`,
    abi: REFUND_TO_ABI,
    functionName: "refundTo",
    args,
  });

  onProgress?.("broadcasting refundTo");
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(
      getChainRpcUrl(lock.chainId as Parameters<typeof getChainRpcUrl>[0]) || undefined,
    ),
  });
  const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  const txHash = await walletClient.writeContract({ ...request, nonce });
  // Guard in memory first, then persist + read back using observable storage.
  // `durablyJournaled=false` is reported in the pending log if receipt polling
  // fails; the in-memory guard still prevents duplicates for this app session.
  const durablyJournaled = await recordInFlightRefund(lock, {
    txHash,
    nonce,
    from: account.address,
    broadcastAtMs: Date.now(),
  });

  onProgress?.("waiting for confirmation");
  try {
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      // A revert consumed the gas but not the lock; drop the record so the next
      // attempt can rebroadcast.
      await clearInFlightRefund(lock);
      throw new Error(`refundTo reverted: ${txHash}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("refundTo reverted:")) {
      throw error;
    }
    // writeContract already returned the network-assigned hash. A public RPC may
    // lag or time out reading the receipt; throwing here would make the caller
    // record no refund while the tx is still pending, so the chain scan could
    // offer the same lock again and a second broadcast would waste gas or stall
    // the nonce. Keep the hash — the refund is in flight, and re-scanning sees
    // the lock consumed once it confirms.
    console.log(
      `[SatoraHtlcRefund] receipt unavailable after broadcast hash=${txHash} durablyJournaled=${durablyJournaled} err=${error instanceof Error ? error.message : String(error)}`,
    );
    return { txHash, status: "pending" };
  }
  return { txHash, status: "confirmed" };
}

/** Parse the server's swap_sweep `refundable[]` into typed locks, dropping malformed entries. */
export function parseRefundableLocks(raw: unknown): SatoraRefundableLock[] {
  if (!Array.isArray(raw)) return [];
  const out: SatoraRefundableLock[] = [];
  for (const entry of raw) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const preimageHash = String(r.preimageHash ?? "");
    const key = r.key == null ? "" : String(r.key);
    const coordinatorAddress = String(r.coordinatorAddress ?? "");
    const token = String(r.token ?? "");
    const claimAddress = String(r.claimAddress ?? "");
    const amountRaw = String(r.amountRaw ?? "");
    const chainId = Number(r.chainId);
    const timelock = Number(r.timelock);
    if (
      !/^0x[0-9a-f]{64}$/i.test(preimageHash) ||
      (key !== "" && !/^0x[0-9a-f]{64}$/i.test(key)) ||
      // The swap key and the preimage hash are different values for a real lock: a payload that
      // sends the same 32 bytes for both is the pre-0.6.127 confusion, and refundTo would take the
      // key as its preimageHash.
      (key !== "" && key.toLowerCase() === preimageHash.toLowerCase()) ||
      !/^0x[0-9a-f]{40}$/i.test(coordinatorAddress) ||
      !/^0x[0-9a-f]{40}$/i.test(token) ||
      !/^0x[0-9a-f]{40}$/i.test(claimAddress) ||
      !/^\d+$/.test(amountRaw) ||
      BigInt(amountRaw) <= 0n ||
      !Number.isSafeInteger(chainId) ||
      chainId <= 0 ||
      !Number.isSafeInteger(timelock) ||
      timelock <= 0
    ) {
      continue;
    }
    out.push({
      preimageHash,
      ...(key ? { key } : {}),
      chainId,
      coordinatorAddress,
      token,
      claimAddress,
      amountRaw,
      timelock,
      refundable: r.refundable === true,
    });
  }
  return out;
}
