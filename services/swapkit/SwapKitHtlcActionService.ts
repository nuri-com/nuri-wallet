import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { bytesToHex, sha256, utf8ToBytes, zeroize } from "../../lib/crypto";
import { getEthereumAddress, getPrivateKey } from "../../lib/secureKeyStorage";
import { BASE_VIEM_CHAIN, getBaseViemTransport } from "../../lib/rpc/baseRpc";
import { getCacheValue, setCacheValue } from "../balance/TransactionCacheService";
import { deriveSwapKitHtlcMaterial } from "./SwapKitHtlcKeyService";
import { materializeSwapKitHtlcPreimage } from "./SwapKitHtlcSecretService";
import { submitSwapKitWalletAction } from "./SwapKitService";

/**
 * Generic executor for SwapKit `htlc_signing_v2` wallet actions
 * (nuri-mcp-bitcoin-swapkit docs/HTLC-WALLET-CONTRACT.md and
 * src/interactive-evm-signer.mjs — the shapes here mirror that source).
 *
 * The wallet never branches on provider internals and never constructs
 * provider calldata: it validates the exact server-prepared request, signs or
 * broadcasts it with the active EOA, journals the PUBLIC result idempotently,
 * and returns only {signature} | {authorization} | {txHash} | material.
 */

export const HTLC_SIGNING_CAPABILITY = "htlc_signing_v2";
const REQUEST_ENCODING = "eip712-canonical-v1";
const PREIMAGE_MARKER = "$htlcPreimage";
const PREIMAGE_HEX_MARKER = "$htlcPreimageHex";
// v2 contract: Base mainnet and Arbitrum One only.
const SUPPORTED_CHAIN_IDS = new Set([8453, 42161]);

export type SwapKitHtlcKeyRef = {
  provider: string;
  keyIndex: number;
  preimageHash: string;
};

export type SwapKitHtlcWalletAction = {
  version?: number;
  actionId?: string;
  type?: string;
  capability?: string;
  requestEncoding?: string;
  provider?: string;
  operation?: string;
  externalId?: string;
  keyRef?: SwapKitHtlcKeyRef;
  request?: Record<string, unknown> & { kind?: string; fromAddress?: string };
  requestFingerprint?: string;
  needsPreimage?: boolean;
  /** derive_material only (v0.6.21): server-requested allocation floor. */
  derivation?: { minimumKeyIndex?: number; [key: string]: unknown };
  [key: string]: unknown;
};

export type SwapKitHtlcResult =
  | { signature: string }
  | { authorization: Record<string, unknown> }
  | { txHash: string };

const RESULT_STORAGE_KEY = "swapkit:htlc-results:v1";

type ResultJournal = Record<string, SwapKitHtlcResult>;

let journal: ResultJournal | null = null;
let journalChain: Promise<unknown> = Promise.resolve();

async function loadJournal(): Promise<ResultJournal> {
  if (journal) return journal;
  let parsed: unknown = null;
  try {
    parsed = await getCacheValue<unknown>(RESULT_STORAGE_KEY);
  } catch {}
  journal = parsed && typeof parsed === "object" ? { ...(parsed as ResultJournal) } : {};
  return journal;
}

async function journalResult(actionId: string, result: SwapKitHtlcResult): Promise<void> {
  const write = journalChain.then(async () => {
    const current = await loadJournal();
    current[actionId] = result;
    await setCacheValue(RESULT_STORAGE_KEY, current);
  });
  journalChain = write.catch(() => {});
  await write;
}

/** Replay-safe lookup: a completed actionId always returns its stored result. */
export async function getJournaledHtlcResult(actionId: string): Promise<SwapKitHtlcResult | null> {
  const current = await loadJournal();
  return current[actionId] ?? null;
}

// ── Canonical JSON + fingerprint (byte-for-byte port of the server's
//    jsonValue/fingerprint in src/interactive-evm-signer.mjs) ────────────────

function canonicalJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalJsonValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function computeHtlcRequestFingerprint(
  kind: string,
  request: Record<string, unknown>,
): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonicalJsonValue({ kind, request })))));
}

// Port of the server's materializeHtlcPreimage: replace ONLY the two markers,
// everywhere they appear as string content — never any other text.
function materializeMarkers(value: unknown, preimageHex: string): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll(PREIMAGE_HEX_MARKER, preimageHex)
      .replaceAll(PREIMAGE_MARKER, `0x${preimageHex}`);
  }
  if (Array.isArray(value)) return value.map((item) => materializeMarkers(item, preimageHex));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        materializeMarkers(child, preimageHex),
      ]),
    );
  }
  return value;
}

// ── Validation ───────────────────────────────────────────────────────────────

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BYTES = /^0x[0-9a-fA-F]*$/;

// Redacted requests carry preimage markers where hex will be materialized.
// For FORMAT checks, substitute them with placeholder hex of the real width —
// a marker placed where it could not materialize into valid hex still fails.
const hexForFormatCheck = (value: string): string =>
  value
    .replaceAll(PREIMAGE_HEX_MARKER, "ab".repeat(32))
    .replaceAll(PREIMAGE_MARKER, `0x${"ab".repeat(32)}`);

// `account` and `chain` appear because the server builds requests through a
// viem wallet interface (its provider code passes `account: signer.account,
// chain: null` on every call — verified in the server source at the deployed
// commit). Both are BOUND below, never ignored: account must be the active
// EOA; chain must be null or a supported chain matching chainId.
const ALLOWED_REQUEST_KEYS: Record<string, Set<string>> = {
  sign_typed_data: new Set([
    "kind",
    "account",
    "chain",
    "domain",
    "types",
    "primaryType",
    "message",
  ]),
  sign_message: new Set(["kind", "account", "chain", "raw"]),
  sign_authorization: new Set([
    "kind",
    "account",
    "chain",
    "address",
    "contractAddress",
    "chainId",
    "nonce",
  ]),
  send_transaction: new Set([
    "kind",
    "account",
    "chain",
    "chainId",
    "from",
    "to",
    "data",
    "value",
    "nonce",
    "gas",
    "authorizationList",
  ]),
};

function fail(reason: string): never {
  throw new Error(`SwapKit HTLC action rejected: ${reason}`);
}

function requireChainId(value: unknown, label: string): 8453 | 42161 {
  const chainId = Number(value);
  if (!SUPPORTED_CHAIN_IDS.has(chainId))
    fail(`${label} chain ${value ?? "missing"} is not supported`);
  return chainId as 8453 | 42161;
}

export type ValidatedHtlcAction = {
  actionId: string;
  provider: string;
  operation: string;
  externalId?: string;
  keyRef: SwapKitHtlcKeyRef | null;
  kind: string | null;
  request: Record<string, unknown>;
  needsPreimage: boolean;
};

/**
 * Strict fail-closed gate. Everything the contract lists is checked BEFORE the
 * key signs: version/capability, provider/keyRef binding (the preimage hash is
 * recomputed from our own derivation — a foreign keyRef can never pass), the
 * active EOA, supported chain, per-kind field allow-list and the exact request
 * fingerprint.
 */
export async function validateSwapKitHtlcAction(
  action: SwapKitHtlcWalletAction,
  context: { eoa: string },
): Promise<ValidatedHtlcAction> {
  if (Number(action.version) !== 2) fail("version must be 2");
  if (action.type !== HTLC_SIGNING_CAPABILITY || action.capability !== HTLC_SIGNING_CAPABILITY) {
    fail("not an htlc_signing_v2 action");
  }
  const actionId = String(action.actionId || "").trim();
  if (!actionId) fail("actionId is missing");
  const provider = String(action.provider || "");
  const operation = String(action.operation || "");

  if (operation === "derive_material") {
    const fromAddress = String(action.request?.fromAddress || "");
    if (fromAddress.toLowerCase() !== context.eoa.toLowerCase()) {
      fail("derive_material is not bound to this wallet's EOA");
    }
    return {
      actionId,
      provider,
      operation,
      externalId: action.externalId ? String(action.externalId) : undefined,
      keyRef: null,
      kind: null,
      request: action.request ?? {},
      needsPreimage: false,
    };
  }

  if (action.requestEncoding !== REQUEST_ENCODING) {
    fail(`requestEncoding ${action.requestEncoding ?? "missing"} is not ${REQUEST_ENCODING}`);
  }
  const keyRef = action.keyRef;
  if (!keyRef || keyRef.provider !== provider) fail("keyRef does not match the action provider");
  // Recompute the preimage commitment from our own derivation. A match means a
  // legacy wallet-owned-preimage route. A MISMATCH is the Phase B server-owned
  // preimage (server v0.6.48, reverse Arkade): keyRef.preimageHash is the
  // server's deterministic hash, which the wallet cannot reproduce by design.
  // That mode is allowed — every signed byte is still bound by the guards
  // below (own EOA, chain + field allow-lists, exact request fingerprint,
  // foreign-signer check), and the money-critical binding moved to the claim:
  // the server-handed preimage must hash to the funded VHTLC lock and the
  // receiver key must be this wallet's (both enforced in the Arkade adapter).
  const preimage = await materializeSwapKitHtlcPreimage(provider, Number(keyRef.keyIndex));
  const derivedHash = `0x${bytesToHex(sha256(preimage))}`;
  zeroize(preimage);
  const serverOwnedPreimage = derivedHash !== String(keyRef.preimageHash || "").toLowerCase();
  if (serverOwnedPreimage && action.needsPreimage === true) {
    // The EVM-side preimage-reveal path materializes the LOCAL derivation —
    // with a server-owned hash that would broadcast a wrong preimage. Only the
    // Arkade claim (which carries request.preimage) may reveal server secrets.
    fail("needsPreimage action cannot use a server-owned preimage hash");
  }

  const request = action.request;
  if (!request || typeof request !== "object") fail("request is missing");
  const kind = String(request.kind || "");
  const allowed = ALLOWED_REQUEST_KEYS[kind];
  if (!allowed) fail(`unsupported request kind: ${kind || "missing"}`);
  const unexpected = Object.keys(request).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(`unexpected request field(s): ${unexpected.join(", ")}`);
  // Signer binding: a request naming an account must name OUR account. The
  // viem account object serializes as {address, ...}; accept both shapes.
  const requestAccount = (request as { account?: unknown }).account;
  if (requestAccount != null) {
    const accountAddress = String(
      typeof requestAccount === "object"
        ? ((requestAccount as { address?: unknown }).address ?? "")
        : requestAccount,
    );
    if (accountAddress.toLowerCase() !== context.eoa.toLowerCase()) {
      fail("request account is not this wallet's EOA");
    }
  }
  // Chain binding: viem passes `chain: null` (use the client's chain) or a
  // chain object; anything non-null must be a supported chain.
  const requestChain = (request as { chain?: unknown }).chain;
  if (requestChain != null) {
    const id = Number(
      typeof requestChain === "object"
        ? ((requestChain as { id?: unknown }).id ?? Number.NaN)
        : requestChain,
    );
    if (!SUPPORTED_CHAIN_IDS.has(id)) fail("request chain is not supported");
  }

  // The exact request fingerprint binds what we sign to what the server
  // persisted — recomputed locally with the same canonicalization.
  const { kind: _kind, ...rest } = request;
  const fingerprint = computeHtlcRequestFingerprint(kind, rest);
  if (fingerprint !== String(action.requestFingerprint || "").toLowerCase()) {
    fail("request fingerprint mismatch");
  }

  if (kind === "sign_message") {
    const raw = hexForFormatCheck(String(request.raw || ""));
    if (!HEX_BYTES.test(raw) || raw.length < 4) {
      fail("sign_message raw bytes are not canonical hex");
    }
  }
  if (kind === "sign_typed_data") {
    const domain = (request.domain ?? {}) as Record<string, unknown>;
    requireChainId(domain.chainId, "typed-data domain");
  }
  if (kind === "sign_authorization") {
    requireChainId(request.chainId, "authorization");
    const target = String(request.address ?? request.contractAddress ?? "");
    if (!EVM_ADDRESS.test(target)) fail("authorization target address is invalid");
  }
  if (kind === "send_transaction") {
    requireChainId(request.chainId, "transaction");
    if (!EVM_ADDRESS.test(String(request.to || ""))) fail("transaction `to` is invalid");
    if (!HEX_BYTES.test(hexForFormatCheck(String(request.data ?? "0x")))) {
      fail("transaction calldata is invalid");
    }
    const from = request.from == null ? null : String(request.from);
    if (from && from.toLowerCase() !== context.eoa.toLowerCase()) {
      fail("transaction is bound to a foreign signer");
    }
  }

  return {
    actionId,
    provider,
    operation,
    externalId: action.externalId ? String(action.externalId) : undefined,
    keyRef,
    kind,
    request,
    needsPreimage: action.needsPreimage === true,
  };
}

// ── Execution ────────────────────────────────────────────────────────────────

async function loadSignerAccount(): Promise<ReturnType<typeof privateKeyToAccount>> {
  const keyBytes = await getPrivateKey("ethereum");
  try {
    return privateKeyToAccount(`0x${bytesToHex(keyBytes)}` as `0x${string}`);
  } finally {
    zeroize(keyBytes);
  }
}

function clientsFor(chainId: 8453 | 42161) {
  const chain = chainId === 8453 ? BASE_VIEM_CHAIN : arbitrum;
  // Base uses the app's configured transport; Arbitrum One rides viem's
  // default public RPC — canary traffic only, swap in a dedicated RPC when
  // these routes carry volume.
  const transport = chainId === 8453 ? getBaseViemTransport() : http();
  return {
    publicClient: createPublicClient({ chain, transport }),
    walletClient: (account: ReturnType<typeof privateKeyToAccount>) =>
      createWalletClient({ chain, transport, account }),
  };
}

const asBigInt = (value: unknown): bigint | undefined =>
  value == null ? undefined : BigInt(value as string | number | bigint);

/**
 * Execute a validated non-derive action and return ONLY its public result.
 * Idempotent by actionId: a journaled result is returned as-is and nothing is
 * signed or broadcast a second time.
 */
export async function executeSwapKitHtlcAction(
  validated: ValidatedHtlcAction,
): Promise<SwapKitHtlcResult> {
  const replay = await getJournaledHtlcResult(validated.actionId);
  if (replay) return replay;

  // Materialize the preimage markers in RAM only, just-in-time.
  let request = validated.request;
  if (validated.needsPreimage) {
    if (!validated.keyRef) fail("needsPreimage without a keyRef");
    const preimage = await materializeSwapKitHtlcPreimage(
      validated.keyRef.provider,
      Number(validated.keyRef.keyIndex),
    );
    const preimageHex = bytesToHex(preimage);
    zeroize(preimage);
    request = materializeMarkers(request, preimageHex) as Record<string, unknown>;
  }

  const account = await loadSignerAccount();
  let result: SwapKitHtlcResult;
  switch (validated.kind) {
    case "sign_typed_data": {
      const { kind: _k, ...typedData } = request;
      const signature = await account.signTypedData(
        typedData as Parameters<typeof account.signTypedData>[0],
      );
      result = { signature };
      break;
    }
    case "sign_message": {
      const signature = await account.signMessage({
        message: { raw: String(request.raw) as `0x${string}` },
      });
      result = { signature };
      break;
    }
    case "sign_authorization": {
      const signed = await account.signAuthorization({
        contractAddress: String(request.address ?? request.contractAddress) as `0x${string}`,
        chainId: Number(request.chainId),
        nonce: Number(request.nonce),
      });
      result = {
        authorization: {
          address: String(request.address ?? request.contractAddress).toLowerCase(),
          chainId: Number(request.chainId),
          nonce: Number(request.nonce),
          r: signed.r,
          s: signed.s,
          yParity: signed.yParity,
        },
      };
      break;
    }
    case "send_transaction": {
      const chainId = requireChainId(request.chainId, "transaction");
      const { publicClient, walletClient } = clientsFor(chainId);
      // HTLC actions only ever execute contract calldata: the token amount lives
      // in `data` (an ERC20 transfer/approve is value=0). A non-zero native
      // `value` would spend the wallet's ETH gas balance on Base/Arbitrum, so
      // fail closed on it — matching the non-HTLC SwapKit action guard.
      const value = asBigInt(request.value) ?? 0n;
      if (value !== 0n) fail(`send_transaction carries a non-zero value (${value})`);
      const tx = {
        to: String(request.to) as `0x${string}`,
        data: String(request.data ?? "0x") as `0x${string}`,
        value,
        nonce: request.nonce == null ? undefined : Number(request.nonce),
        gas: asBigInt(request.gas),
        authorizationList: request.authorizationList as
          | Parameters<ReturnType<typeof walletClient>["sendTransaction"]>[0]["authorizationList"]
          | undefined,
      };
      // Preflight the exact call; a revert here signs nothing and the swap
      // loop re-polls for a rebuilt action. Surface the revert selector — it
      // is the only clue which contract condition failed, and viem's generic
      // "unknown reason" hides it.
      try {
        await publicClient.call({
          account: account.address,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          // Mirror the broadcast tuple: an EIP-7702 action's delegation must be
          // applied in the simulation too, else a valid authorization-backed
          // call reverts in preflight after funds are already committed.
          ...(tx.authorizationList ? { authorizationList: tx.authorizationList } : {}),
        });
      } catch (error) {
        let revertData = "";
        let cursor: unknown = error;
        for (let depth = 0; depth < 8 && cursor; depth++) {
          const data = (cursor as { data?: unknown }).data;
          if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
            revertData = data.slice(0, 10);
            break;
          }
          cursor = (cursor as { cause?: unknown }).cause;
        }
        fail(
          `preflight reverted${revertData ? ` selector=${revertData}` : " (no revert data)"} to=${tx.to}`,
        );
      }
      const hash = await walletClient(account).sendTransaction(
        tx as unknown as Parameters<ReturnType<typeof walletClient>["sendTransaction"]>[0],
      );
      // Journal the broadcast hash IMMEDIATELY: once the tx is on the wire, a
      // re-presented actionId must replay THIS hash (executeSwapKitHtlcAction
      // returns a journaled result as-is), never broadcast a second tx. A
      // transient receipt/readback RPC failure below must not lose it.
      result = { txHash: hash };
      await journalResult(validated.actionId, result);
      // Confirm the receipt FIRST, on its own, so a CONFIRMED revert stays
      // terminal even if the later tx-tuple read fails: only a failure of the
      // receipt read ITSELF is a transient RPC error (non-terminal — the hash is
      // journaled and the server rechecks).
      let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash });
      } catch {
        break;
      }
      if (receipt.status !== "success") fail(`transaction reverted onchain: ${hash}`);
      // Receipt says success. Read back the mined tuple — chain/from/to/value/
      // data plus any supplied nonce/gas (the server independently repeats this).
      // A failure of THIS read is non-terminal; only a CONFIRMED mismatch fails.
      let mined: Awaited<ReturnType<typeof publicClient.getTransaction>>;
      try {
        mined = await publicClient.getTransaction({ hash });
      } catch {
        break;
      }
      const mismatch =
        String(mined.to || "").toLowerCase() !== tx.to.toLowerCase() ||
        String(mined.from || "").toLowerCase() !== account.address.toLowerCase() ||
        String(mined.input || "").toLowerCase() !== tx.data.toLowerCase() ||
        BigInt(mined.value ?? 0) !== tx.value ||
        (tx.nonce != null && Number(mined.nonce) !== tx.nonce) ||
        (tx.gas != null && BigInt(mined.gas) !== tx.gas);
      if (mismatch) fail("mined transaction does not match the signed tuple");
      break;
    }
    default:
      fail(`unsupported request kind: ${validated.kind}`);
  }

  // Journal BEFORE returning so a repeated actionId replays this exact public
  // result instead of signing or broadcasting twice.
  await journalResult(validated.actionId, result);
  return result;
}

/**
 * The one entry point the swap loop calls for an htlc_signing_v2 action:
 * validate strictly, derive or execute, submit the public result via
 * swap_wallet_submit. Fully idempotent per actionId on both sides.
 */
export async function handleSwapKitHtlcAction(
  action: SwapKitHtlcWalletAction,
  context: { txId: string },
): Promise<void> {
  const eoa = await getEthereumAddress();
  if (!eoa) fail("Ethereum wallet address is missing");
  const validated = await validateSwapKitHtlcAction(action, { eoa });
  if (validated.operation === "derive_material") {
    // v0.6.21 fast-forward: honor the server's allocation floor so one derive
    // jumps past provider-known material instead of advancing index by index.
    const minimumKeyIndex = Number(action.derivation?.minimumKeyIndex) || 0;
    const material = await deriveSwapKitHtlcMaterial(
      validated.provider,
      validated.actionId,
      minimumKeyIndex,
    );
    // Ground truth for duplicate-material incidents: which index the wallet
    // actually submitted vs. what the server asked for (public data only).
    console.log(
      `[SwapKitHtlc] derive ${validated.provider} keyIndex=${material.keyIndex} minimum=${minimumKeyIndex} action=${validated.actionId.slice(0, 11)}`,
    );
    await submitSwapKitWalletAction({
      txId: context.txId,
      actionId: validated.actionId,
      provider: validated.provider,
      externalId: validated.externalId,
      material,
    });
    return;
  }
  const result = await executeSwapKitHtlcAction(validated);
  await submitSwapKitWalletAction({
    txId: context.txId,
    actionId: validated.actionId,
    provider: validated.provider,
    externalId: validated.externalId,
    result: result as Record<string, unknown>,
    ...("txHash" in result ? { txHash: result.txHash } : {}),
  });
}
