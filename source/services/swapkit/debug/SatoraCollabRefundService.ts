/**
 * TEMPORARY one-shot recovery tool — delete once the stuck swap is settled.
 *
 * Swap `sk_ff4eb2ba-25b5-4cff-8f7b-ad0ed4aa40e0` (10 EURC -> BTC_ARKADE) has
 * 0.000180166570070933 tBTC locked in the Arbitrum HTLC. The swapkit server
 * cannot surface `authorize_refund` (it holds a stale `fund_evm` action it
 * refuses to adopt, because the funding tx was relayed by the gas sponsor and
 * not by this wallet), so the client signs the collaborative refund itself.
 *
 * Mirrors the server implementation: nuri-mcp-bitcoin-swapkit
 * `src/providers/satora.mjs:794-846` (build) and `:1241-1260` (relay).
 * Satora's own signer broadcasts the refund — we only sign and hand it over.
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbiItem,
  parseSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { bytesToHex, zeroize } from "../../../lib/crypto";
import { getEthereumAddress, getPrivateKey } from "../../../lib/secureKeyStorage";

const SATORA_BASE = "https://api.satora.io";
const SWAP_ID = "f72415c8-f78c-424e-af0c-6a528b2058fc";
const REFUND_MODE = "swap-back";

/** The funding tx that locked the tBTC (`SwapCreated` log source of truth). */
const FUNDING_TX_HASH = "0xa6d0f17fe7d9a108d3eaaf7a20591bf94915b9ad61f52bd3e3750284b4ec4057";
const HTLC_ADDRESS = "0x13572c930A5Bbb3d0d46d567D71a9Ad962f85D18";

/** Pinned to the incident brief — anything else and we refuse to sign. */
const EXPECTED_CHAIN_ID = 42161;
const EXPECTED_PREIMAGE_HASH = "0xbefac106eeb85866ad2bb3f975d13d41b6378194786793f243d302da953f19ee";
const EXPECTED_COORDINATOR = "0x5B7cDa892cF870156bcb9a710249830Fa1Fc67Be";
const EXPECTED_OWNER = "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B";

const COLLAB_REFUND_TYPES = {
  CollabRefund: [
    { name: "preimageHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "token", type: "address" },
    { name: "claimAddress", type: "address" },
    { name: "timelock", type: "uint256" },
    { name: "caller", type: "address" },
    { name: "sweepToken", type: "address" },
    { name: "minAmountOut", type: "uint256" },
    { name: "callsHash", type: "bytes32" },
  ],
} as const;

export type SatoraCollabRefundParams = {
  chain_id: number;
  preimage_hash: string;
  coordinator_address: string;
  amount: string;
  token: string;
  claim_address: string;
  timelock: string;
  server_signer_address: string;
  sweep_token: string;
  min_amount_out: string;
  calls_hash: string;
  mode?: string;
};

export const SATORA_REFUND_SWAP_ID = SWAP_ID;
export const SATORA_REFUND_OWNER = EXPECTED_OWNER;

const same = (a: unknown, b: unknown): boolean =>
  String(a || "").toLowerCase() === String(b || "").toLowerCase();

/** Step 1: raw params straight from Satora — also the liveness probe. */
export async function fetchSatoraCollabRefundParams(): Promise<unknown> {
  const url = `${SATORA_BASE}/api/swap/${encodeURIComponent(SWAP_ID)}/collab-refund-evm/params?mode=${REFUND_MODE}`;
  const response = await fetch(url);
  const body = await response.text();
  let parsed: unknown = body;
  try {
    parsed = JSON.parse(body);
  } catch {}
  if (!response.ok) {
    throw new Error(`GET collab-refund-evm/params -> ${response.status} ${body.slice(0, 800)}`);
  }
  return parsed;
}

/** Step 2: fail closed unless the params describe exactly the stuck HTLC. */
export function validateSatoraCollabRefundParams(raw: unknown): SatoraCollabRefundParams {
  const params = (raw ?? {}) as Record<string, unknown>;
  if (Number(params.chain_id) !== EXPECTED_CHAIN_ID) {
    throw new Error(`chain_id ${String(params.chain_id)} is not ${EXPECTED_CHAIN_ID}`);
  }
  if (!same(params.preimage_hash, EXPECTED_PREIMAGE_HASH)) {
    throw new Error(`preimage_hash ${String(params.preimage_hash)} does not match the locked HTLC`);
  }
  if (!same(params.coordinator_address, EXPECTED_COORDINATOR)) {
    throw new Error(
      `coordinator_address ${String(params.coordinator_address)} does not match the locked HTLC`,
    );
  }
  const required = [
    "amount",
    "token",
    "claim_address",
    "timelock",
    "server_signer_address",
    "sweep_token",
    "min_amount_out",
    "calls_hash",
  ] as const;
  for (const key of required) {
    if (params[key] == null || params[key] === "") throw new Error(`params.${key} is missing`);
  }
  return {
    chain_id: Number(params.chain_id),
    preimage_hash: String(params.preimage_hash),
    coordinator_address: String(params.coordinator_address),
    amount: String(params.amount),
    token: String(params.token),
    claim_address: String(params.claim_address),
    timelock: String(params.timelock),
    server_signer_address: String(params.server_signer_address),
    sweep_token: String(params.sweep_token),
    min_amount_out: String(params.min_amount_out),
    calls_hash: String(params.calls_hash),
    mode: params.mode == null ? undefined : String(params.mode),
  };
}

/**
 * Step 3 + 4: sign the CollabRefund EIP-712 message with the swap's owner key
 * and hand v/r/s to Satora's relay. Returns their broadcast tx hash. Only the
 * signature leaves the device — never the key or any preimage.
 */
export async function signAndRelaySatoraCollabRefund(
  params: SatoraCollabRefundParams,
  onProgress?: (step: string) => void,
): Promise<string> {
  const eoa = await getEthereumAddress();
  if (!same(eoa, EXPECTED_OWNER)) {
    throw new Error(`this wallet (${eoa ?? "none"}) is not the swap owner ${EXPECTED_OWNER}`);
  }

  onProgress?.("signing CollabRefund");
  const keyBytes = await getPrivateKey("ethereum");
  let signature: `0x${string}`;
  try {
    const account = privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`);
    if (!same(account.address, EXPECTED_OWNER)) {
      throw new Error("derived signer does not match the swap owner");
    }
    signature = await account.signTypedData({
      domain: {
        name: "HTLCCoordinator",
        version: "3",
        chainId: params.chain_id,
        verifyingContract: params.coordinator_address as `0x${string}`,
      },
      types: COLLAB_REFUND_TYPES,
      primaryType: "CollabRefund",
      message: {
        preimageHash: params.preimage_hash as `0x${string}`,
        amount: BigInt(params.amount),
        token: params.token as `0x${string}`,
        claimAddress: params.claim_address as `0x${string}`,
        timelock: BigInt(params.timelock),
        caller: params.server_signer_address as `0x${string}`,
        sweepToken: params.sweep_token as `0x${string}`,
        minAmountOut: BigInt(params.min_amount_out),
        callsHash: params.calls_hash as `0x${string}`,
      },
    });
  } finally {
    zeroize(keyBytes);
  }

  const parsed = parseSignature(signature);
  // viem omits `v` when the serialized signature ends in 00/01.
  const v = Number(parsed.v ?? BigInt((parsed.yParity ?? 0) + 27));

  onProgress?.("relaying to Satora");
  const response = await fetch(
    `${SATORA_BASE}/api/swap/${encodeURIComponent(SWAP_ID)}/collab-refund-evm`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        v,
        r: parsed.r,
        s: parsed.s,
        depositor_address: EXPECTED_OWNER.toLowerCase(),
        mode: params.mode || REFUND_MODE,
        sweep_token: params.sweep_token,
        min_amount_out: params.min_amount_out,
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`POST collab-refund-evm -> ${response.status} ${body.slice(0, 800)}`);
  }
  let txHash = "";
  try {
    txHash = String((JSON.parse(body) as { tx_hash?: unknown }).tx_hash ?? "");
  } catch {}
  if (!/^0x[0-9a-f]{64}$/i.test(txHash)) {
    throw new Error(`refund relay returned no transaction hash: ${body.slice(0, 800)}`);
  }
  return txHash;
}

// ── Satora-independent exit: permissionless refundTo after the timelock ──────
//
// HTLCCoordinator.refundTo (verified source on Arbiscan/Blockscout): "Permissionless
// — anyone can trigger this after timelock expiry. Tokens always go to the depositor
// regardless of who calls." Every argument comes from the funding tx's SwapCreated
// log and the coordinator's own `deposits` mapping, so this path needs nothing from
// Satora — only gas on Arbitrum. It returns tBTC, not swapped-back USDC.

const SWAP_CREATED_EVENT = parseAbiItem(
  "event SwapCreated(bytes32 indexed preimageHash, address indexed refundAddress, address indexed claimAddress, address token, uint256 amount, uint256 timelock)",
);

const COORDINATOR_ABI = [
  {
    name: "deposits",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ name: "depositor", type: "address" }],
  },
] as const;

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

type SwapCreatedArgs = {
  preimageHash: `0x${string}`;
  refundAddress: `0x${string}`;
  claimAddress: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  timelock: bigint;
};

export type SatoraOnchainLock = {
  preimageHash: `0x${string}`;
  amount: bigint;
  token: `0x${string}`;
  claimAddress: `0x${string}`;
  timelock: bigint;
  /** `deposits[key]` — refundTo pays exactly this address. */
  depositor: `0x${string}`;
  /** Native ETH on Arbitrum, i.e. whether we can pay for the call. */
  gasBalance: bigint;
};

const arbitrumClient = () => createPublicClient({ chain: arbitrum, transport: http() });

/** HTLCErc20._key — keccak of the six lock fields, refundAddress = coordinator. */
function computeHtlcKey(lock: {
  preimageHash: `0x${string}`;
  amount: bigint;
  token: `0x${string}`;
  refundAddress: `0x${string}`;
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
        lock.preimageHash,
        lock.amount,
        lock.token,
        lock.refundAddress,
        lock.claimAddress,
        lock.timelock,
      ],
    ),
  );
}

/** Reads the locked HTLC from chain — the funding receipt is the only input. */
export async function loadSatoraOnchainLock(): Promise<SatoraOnchainLock> {
  const client = arbitrumClient();
  const receipt = await client.getTransactionReceipt({
    hash: FUNDING_TX_HASH as `0x${string}`,
  });

  let decoded: SwapCreatedArgs | null = null;
  for (const log of receipt.logs) {
    if (!same(log.address, HTLC_ADDRESS)) continue;
    try {
      const event = decodeEventLog({
        abi: [SWAP_CREATED_EVENT],
        data: log.data,
        topics: (log as unknown as { topics: [`0x${string}`, ...`0x${string}`[]] }).topics,
      }) as unknown as { args: SwapCreatedArgs };
      decoded = event.args;
      break;
    } catch {}
  }
  if (!decoded) throw new Error("no SwapCreated log in the funding transaction");
  if (!same(decoded.preimageHash, EXPECTED_PREIMAGE_HASH)) {
    throw new Error(`funding log preimage hash ${decoded.preimageHash} is not the tracked swap`);
  }
  if (!same(decoded.refundAddress, EXPECTED_COORDINATOR)) {
    throw new Error(`funding log refund address ${decoded.refundAddress} is not the coordinator`);
  }

  const key = computeHtlcKey(decoded);
  // `simulateContract` rather than `readContract`: this repo's viem types reject
  // the latter's parameter object (it demands an `authorizationList`).
  const [deposits, gasBalance] = await Promise.all([
    client.simulateContract({
      address: EXPECTED_COORDINATOR as `0x${string}`,
      abi: COORDINATOR_ABI,
      functionName: "deposits",
      args: [key],
    }),
    client.getBalance({ address: EXPECTED_OWNER as `0x${string}` }),
  ]);
  const depositor = deposits.result;

  return {
    preimageHash: decoded.preimageHash,
    amount: decoded.amount,
    token: decoded.token,
    claimAddress: decoded.claimAddress,
    timelock: decoded.timelock,
    depositor,
    gasBalance,
  };
}

/**
 * Broadcast `refundTo` ourselves. Refuses unless the coordinator still records
 * this wallet as the depositor — otherwise the tBTC would land elsewhere.
 * Simulates first, so an unexpired timelock costs nothing.
 */
export async function sendSatoraOnchainRefund(
  lock: SatoraOnchainLock,
  onProgress?: (step: string) => void,
): Promise<string> {
  if (!same(lock.depositor, EXPECTED_OWNER)) {
    throw new Error(`coordinator pays ${lock.depositor}, not this wallet — refusing`);
  }
  const eoa = await getEthereumAddress();
  if (!same(eoa, EXPECTED_OWNER)) {
    throw new Error(`this wallet (${eoa ?? "none"}) is not the depositor ${EXPECTED_OWNER}`);
  }

  const client = arbitrumClient();
  const keyBytes = await getPrivateKey("ethereum");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`);
  } finally {
    zeroize(keyBytes);
  }
  if (!same(account.address, EXPECTED_OWNER)) {
    throw new Error("derived signer does not match the depositor");
  }

  const args = [
    lock.preimageHash,
    lock.amount,
    lock.token,
    lock.claimAddress,
    lock.timelock,
  ] as const;

  onProgress?.("simulating refundTo");
  const { request } = await client.simulateContract({
    account,
    address: EXPECTED_COORDINATOR as `0x${string}`,
    abi: REFUND_TO_ABI,
    functionName: "refundTo",
    args,
  });

  onProgress?.("broadcasting refundTo");
  const wallet = createWalletClient({ account, chain: arbitrum, transport: http() });
  const txHash = await wallet.writeContract(request);

  onProgress?.("waiting for confirmation");
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`refundTo reverted: ${txHash}`);
  return txHash;
}
