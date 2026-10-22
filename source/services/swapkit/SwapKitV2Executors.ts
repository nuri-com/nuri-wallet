import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
// SwapKit v2 wallet executors — the concrete wiring of the wallet's existing
// signing/sending primitives into the SwapKitV2ActionService executor seam.
//
// The dispatcher validated the bound request BEFORE any executor runs; each
// executor here adds only the checks that need wallet context (own EOA, own
// Arkade key, preimage↔hashLock binding) and then executes the exact bound
// request. Nothing here recomputes amounts, fees or routes — the server's
// bound request is the sole authority.
//
// WALLET SOVEREIGNTY (contract v2.1.0, swapkit PR #288): the wallet mints an
// OPAQUE `walletKeyRef` in its htlc_material response; the server stores and
// echoes it byte-for-byte and never parses it. Only this wallet can resolve
// it — here it encodes the provider + the keyIndex allocated by the EXISTING
// v1 key machinery (SwapKitHtlcKeyService), so no new derivation scheme and
// no server-defined math exists anywhere. Every resolution is verified by
// re-deriving the preimage and matching keyRef.preimageHash; anything this
// wallet did not mint fails closed before a secret is touched.
import { bytesToHex, sha256, zeroize } from "../../lib/crypto";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { payArkadeLightningInvoice } from "../arkade/ArkadeLightningSendService";
import { decodeBolt11Facts } from "../../lib/bitcoin/lightning";
import {
  sendArkadeToArk,
  fundArkadeIntentsOutpoint,
  warmArkadeSend,
} from "../arkade/ArkadeSendService";
import { setV2FundingWarmup } from "./SwapKitV2FundingWarmup";
import { getArkadeReceiveAddress } from "../arkade/ArkadeAddressService";
import { deriveSwapKitHtlcMaterial } from "./SwapKitHtlcKeyService";
import { approvalCeiling } from "./SwapKitV2ApprovalBounds";
import { materializeSwapKitHtlcPreimage } from "./SwapKitHtlcSecretService";
import { claimSwapKitArkadeVhtlc } from "./SwapKitArkadeVhtlcService";
import type { SwapKitArkadeVhtlcParams } from "./SwapKitArkadeVhtlcService";
import {
  rebuildLockupPkScript,
  parseLockupParams,
  refundArkadeIntentsLockup,
  deriveArkadeIntentsRefundMaterial,
  isArkadeIntentsRefundKeyRef,
} from "./SwapKitArkadeIntentsActionService";
import { parseSwapActionTx } from "./SwapKitService";
import { SWAPKIT_V2_ACTION_KINDS } from "./SwapKitV2Service";
import {
  assertTypedDataBoundToRoute,
  type SwapKitV2EvmRouteBinding,
  type SwapKitV2SettleBinding,
} from "./SwapKitV2EvmRouteBinding";
import type { SwapKitAction } from "./SwapKitService";
import type { ParsedSwapActionTx } from "./SwapKitService";
import { signAndBroadcastSwapKitEvmTx } from "./SwapKitEvmSigner";
import { executeSwapKitHtlcAction } from "./SwapKitHtlcActionService";
import type { SwapKitV2ActionContext, SwapKitV2Executors } from "./SwapKitV2ActionService";
import { noteV2MoveStep } from "./SwapKitV2MoveStatus";
import { setV2CommitRefundMaterialSource } from "./SwapKitV2CommitRefundMaterial";
import { SwapKitV2Error } from "./SwapKitV2Service";

/** Chains this wallet will EIP-712 sign on — Base (CoW) and Arbitrum. Mirrors
 * the v1 HTLC guardian's SUPPORTED_CHAIN_IDS so a bound sign_typed_data whose
 * domain names an unsupported chain is refused before signing. */
const SWAPKIT_V2_SIGNABLE_CHAIN_IDS = new Set<number>([8453, 42161]);

// ── walletKeyRef: minted here, resolved only here ───────────────────
//
// Format is PRIVATE to this wallet (the server treats it as an opaque string).
// It names the v1 allocation that produced the material: provider + keyIndex.
// Changing this format never needs server coordination — old refs stay
// resolvable as long as the parser accepts them.

const WALLET_KEY_REF_PREFIX = "nuri-htlc-v1";

function mintWalletKeyRef(provider: string, keyIndex: number): string {
  return `${WALLET_KEY_REF_PREFIX}:${provider}:${keyIndex}`;
}

function parseWalletKeyRef(raw: string): { provider: string; keyIndex: number } | null {
  const parts = String(raw || "").split(":");
  if (parts.length !== 3 || parts[0] !== WALLET_KEY_REF_PREFIX) return null;
  const keyIndex = Number(parts[2]);
  if (!parts[1] || !Number.isSafeInteger(keyIndex) || keyIndex < 0) return null;
  return { provider: parts[1], keyIndex };
}

type V2KeyRef = { provider: string; walletKeyRef: string; preimageHash: string };

/** Read a v2.1.0 keyRef. A keyRef carrying only the deprecated server-derived
 * `keyIndex` is refused: this wallet never persisted v2.0.0 material orders
 * (the kinds were blocked), so no read-compatibility path exists or is safe. */
function requireKeyRef(request: Record<string, unknown>): V2KeyRef {
  const keyRef = (request.keyRef ?? {}) as Record<string, unknown>;
  const provider = String(keyRef.provider || "");
  const walletKeyRef = String(keyRef.walletKeyRef || "");
  const preimageHash = String(keyRef.preimageHash || "");
  if (!provider || !walletKeyRef || !/^0x[0-9a-fA-F]{64}$/.test(preimageHash)) {
    throw new SwapKitV2Error(
      "v2 action keyRef is missing provider/walletKeyRef/preimageHash (contract v2.1.0)",
    );
  }
  return { provider, walletKeyRef, preimageHash };
}

/** Resolve a keyRef to the wallet's own allocation, verified by re-deriving
 * the preimage and matching the bound hash. Fails closed on: a ref this
 * wallet did not mint, a provider mismatch, or a hash mismatch. */
async function resolveOwnKeyRef(keyRef: V2KeyRef): Promise<{ provider: string; keyIndex: number }> {
  const parsed = parseWalletKeyRef(keyRef.walletKeyRef);
  if (!parsed) {
    throw new SwapKitV2Error("v2 keyRef was not minted by this wallet — refusing to sign");
  }
  if (parsed.provider !== keyRef.provider) {
    throw new SwapKitV2Error("v2 keyRef provider does not match its wallet reference");
  }
  const preimage = await materializeSwapKitHtlcPreimage(parsed.provider, parsed.keyIndex);
  try {
    const hash = `0x${bytesToHex(sha256(preimage))}`;
    if (hash.toLowerCase() !== keyRef.preimageHash.toLowerCase()) {
      throw new SwapKitV2Error("v2 keyRef.preimageHash does not match this wallet's derivation");
    }
  } finally {
    zeroize(preimage);
  }
  return parsed;
}

// ── send_asset (flow-funded BTC deposit) ────────────────────────────
//
// The ONLY executor that sends the wallet's own funds to a server-named
// address, so it is never in the standard set — a flow builds it explicitly
// with the exact bound expectations and its own funder. Used by the on-chain
// BTC rail of btc→stable / card top-up: the server binds a BTC deposit address
// and amount; the wallet validates both, then funds via the injected sender
// (Arkade offboard or on-chain MuSig2). Evidence is the funding tx id.

export function makeV2SendAsset(options: {
  /** The asset this flow is allowed to fund (e.g. "BTC"). */
  expectedAsset: string;
  /** The exact sats the accepted quote bound; a bound amount above this is
   * refused before anything moves (never overpay a server-named address). */
  boundSats: number;
  /** Validate the server-named destination is a real address of the expected
   * kind (mainnet BTC), returning false to refuse. */
  validateDestination: (address: string) => boolean;
  /** Move exactly `sats` to `address`; return the origin-rail transfer id.
   *
   * `onBeforeBroadcast` MUST be invoked immediately before the funds leave —
   * after every preflight and after the user's approval. It records the
   * action as STARTED, so a crash between broadcast and evidence journaling is
   * treated as "may have funded" and never funds the deposit a second time,
   * while a refusal that moved nothing leaves no marker and stays retryable. */
  fund: (address: string, sats: number, onBeforeBroadcast: () => Promise<void>) => Promise<string>;
}) {
  return async (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ): Promise<{ txHash: string }> => {
    const asset = String(request.asset || "").toUpperCase();
    if (asset !== options.expectedAsset.toUpperCase()) {
      throw new SwapKitV2Error(
        `v2 send_asset asset ${asset || "(empty)"} is not this flow's ${options.expectedAsset}`,
      );
    }
    const to = String(request.to || "");
    if (!options.validateDestination(to)) {
      throw new SwapKitV2Error("v2 send_asset destination failed this flow's address check");
    }
    // The bound amount is decimal BTC (canonical unit); convert and require it
    // equals the sats the user accepted. A server that binds more than quoted
    // is refused rather than silently funded.
    const amount = Number(request.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new SwapKitV2Error("v2 send_asset has an invalid amount");
    }
    const boundSats = Math.round(amount * 100_000_000);
    if (boundSats !== options.boundSats) {
      throw new SwapKitV2Error(
        `v2 send_asset binds ${boundSats} sats; the accepted quote was ${options.boundSats}`,
      );
    }
    const txHash = await options.fund(to, boundSats, async () => {
      await ctx.markStarted?.();
    });
    return { txHash };
  };
}

// ── htlc_material ───────────────────────────────────────────────────

/** Derive order-scoped HTLC material through the EXISTING v1 key service
 * (allocation keyed by the v2 actionId — replay returns byte-identical
 * material) and return ONLY public data plus the wallet-minted opaque
 * reference. The server stores/echoes `walletKeyRef` verbatim. */
export async function executeV2HtlcMaterial(
  request: Record<string, unknown>,
  ctx: SwapKitV2ActionContext,
): Promise<{
  paymentHash: string;
  claimPublicKey: string;
  refundPublicKey: string;
  walletKeyRef: string;
}> {
  const role = String(request.role || "receiver");
  // Today's only wallet-material corridor rides the satora HTLC root; a second
  // provider adapter will name itself via keyRef.provider on later actions.
  const provider = "satora";
  // Allocation is keyed by the v2 action id — the same replay-stable contract
  // v1's derive_material uses (a re-presented action returns the same index,
  // never burns a second one).
  const material = await deriveSwapKitHtlcMaterial(provider, `v2:${ctx.orderId}:${ctx.actionId}`);
  const swapPub = material.publicKey.replace(/^0x/, "");
  const userPub = material.userId.replace(/^0x/, "");
  // Role decides which key claims and which refunds: receiver ⇒ our swap key
  // claims (EVM→Arkade); sender ⇒ our swap key refunds (Arkade→EVM).
  const claimPublicKey = role === "receiver" ? swapPub : userPub;
  const refundPublicKey = role === "receiver" ? userPub : swapPub;
  // sender role: the paymentHash is bound by the counterparty; we return OUR
  // derived hash only when the wallet owns the preimage.
  const boundHash = String(request.paymentHash || "");
  return {
    paymentHash:
      role === "sender" && boundHash ? boundHash : material.preimageHash.replace(/^0x/, ""),
    claimPublicKey,
    refundPublicKey,
    walletKeyRef: mintWalletKeyRef(provider, material.keyIndex),
  };
}

// ── execute_evm_call ────────────────────────────────────────────────

/** Sign + broadcast the exact bound calldata through the proven v1 EVM signer
 * (own-EOA binding, preflight, mined-tuple readback). A `$htlcPreimageHex`
 * redaction is materialized in RAM just-in-time from the wallet's OWN
 * allocation, resolved via the wallet-minted keyRef. */
export function makeV2ExecuteEvmCall(options?: {
  allowedChains?: readonly number[];
  allowedApprovalTokens?: readonly string[];
  maxApprovalUnits?: bigint;
  requireApprovalBound?: boolean;
  route?: SwapKitV2EvmRouteBinding;
  onBroadcast?: (hash: `0x${string}`) => void | Promise<void>;
}) {
  return async (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ): Promise<{ txHash: string }> => {
    let data = String(request.data || "");
    if (request.needsPreimage === true) {
      const resolved = await resolveOwnKeyRef(requireKeyRef(request));
      const preimage = await materializeSwapKitHtlcPreimage(resolved.provider, resolved.keyIndex);
      try {
        data = data.replaceAll("$htlcPreimageHex", bytesToHex(preimage));
      } finally {
        zeroize(preimage);
      }
    }
    // Reuse the v1 fail-closed parser: chain allowlist, zero value, address
    // and calldata shape, approval binding. The server's bound approval and
    // the signer address MUST reach the parser — they carry the approval
    // ceiling and the from-binding the signer verifies; dropping them makes a
    // bounded-approval flow reject as unbounded and loses the signer check.
    const parsed: ParsedSwapActionTx = parseSwapActionTx(
      {
        type: "sign_and_broadcast_evm_tx",
        chainId: Number(request.chainId),
        ...(request.approval ? { approval: request.approval as SwapKitAction["approval"] } : {}),
        tx: {
          chainId: Number(request.chainId),
          to: String(request.to),
          data,
          value: String(request.value ?? "0"),
          ...(request.from ? { from: String(request.from) } : {}),
          ...(request.gasHint ? { gasLimit: String(request.gasHint) } : {}),
        },
      },
      options?.allowedChains,
      options?.allowedApprovalTokens,
    );
    const { hash } = await signAndBroadcastSwapKitEvmTx(parsed, {
      ...(options?.maxApprovalUnits != null ? { maxApprovalUnits: options.maxApprovalUnits } : {}),
      ...(options?.requireApprovalBound ? { requireApprovalBound: true } : {}),
      ...(options?.route ? { route: options.route } : {}),
      ...(options?.onBroadcast ? { onBroadcast: options.onBroadcast } : {}),
      // The pill names the step the wallet is on. "Approving…" only when an
      // allowance tx is actually sent (the signer decides that, after reading
      // the live allowance); "Executing…" once the route call itself goes out.
      onApproving: () => noteV2MoveStep(ctx.orderId, "approving"),
      // THE irreversible boundary for an EVM call: the signer fires this
      // immediately before sendTransaction. Everything earlier (chain
      // allowlist, approval/spend bounds, simulation) can still refuse
      // harmlessly, so the action stays retryable until exactly here.
      onBeforeBroadcast: async () => {
        noteV2MoveStep(ctx.orderId, "executing");
        await ctx.markStarted?.();
      },
    });
    return { txHash: hash };
  };
}

// ── sign_typed_data ─────────────────────────────────────────────────

/** Sign the bound EIP-712 payload with the wallet EOA via the HTLC action
 * executor's signer path (journaled per actionId → replay-safe). Preimage
 * bindings resolve through the wallet-minted keyRef; the v1 executor
 * receives OUR OWN {provider, keyIndex, preimageHash} — wallet-internal
 * coordinates, never a server-supplied ordinal. */
/**
 * sign_typed_data, bound to the committed route.
 *
 * The signature is a spend authorisation in its own right (a CoW order sells
 * the deposit; a permit grants an allowance), so it is held to the same
 * binding as a raw EVM call: only a CoW Order whose every money field matches
 * the order the user accepted, or an EIP-2612 Permit on the source token to a
 * route contract for at most the accepted deposit, may be signed.
 * Without a binding the executor refuses outright — there is no unbound
 * signing path.
 */
export function makeV2SignTypedData(bounds: {
  chainId?: number | null;
  sourceToken?: `0x${string}` | null;
  ceiling?: bigint | null;
  settle: SwapKitV2SettleBinding | null;
}) {
  return async (
    request: Record<string, unknown>,
    ctx: SwapKitV2ActionContext,
  ): Promise<{ signature: string }> => {
    const domain = (request.domain ?? {}) as Record<string, unknown>;
    const domainChainId = Number(domain.chainId);
    if (!SWAPKIT_V2_SIGNABLE_CHAIN_IDS.has(domainChainId)) {
      throw new SwapKitV2Error(
        `v2 sign_typed_data domain chain ${domain.chainId ?? "missing"} is not a signable chain`,
      );
    }
    try {
      const wallet = (await getEthereumAddress()) as `0x${string}` | null;
      assertTypedDataBoundToRoute(request, { ...bounds, wallet });
    } catch (error) {
      throw new SwapKitV2Error(
        `v2 sign_typed_data refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return signV2TypedData(request, ctx);
  };
}

async function signV2TypedData(
  request: Record<string, unknown>,
  ctx: SwapKitV2ActionContext,
): Promise<{ signature: string }> {
  const needsPreimage = request.needsPreimage === true;
  const resolved = needsPreimage ? await resolveOwnKeyRef(requireKeyRef(request)) : null;
  const result = await executeSwapKitHtlcAction({
    actionId: `v2:${ctx.orderId}:${ctx.actionId}`,
    provider: resolved?.provider ?? "satora",
    operation: "sign",
    keyRef: resolved
      ? {
          provider: resolved.provider,
          keyIndex: resolved.keyIndex,
          preimageHash: requireKeyRef(request).preimageHash,
        }
      : null,
    kind: "sign_typed_data",
    request: {
      kind: "sign_typed_data",
      domain: request.domain,
      types: request.types,
      primaryType: request.primaryType,
      message: request.message,
    },
    needsPreimage,
  });
  if (!("signature" in result)) {
    throw new SwapKitV2Error("v2 sign_typed_data produced no signature");
  }
  return { signature: result.signature };
}

// ── pay_lightning_invoice ───────────────────────────────────────────

export async function executeV2PayLightningInvoice(
  request: Record<string, unknown>,
  ctx: SwapKitV2ActionContext,
): Promise<{ paymentHash: string; preimage?: string }> {
  const invoice = String(request.invoice);
  const amountSats = Number(request.amountSats);
  // FAIL CLOSED. Every input below decides how much money leaves, so an
  // unreadable one is a refusal, not a zero. Treating a decode failure as
  // `encoded = 0` (and a missing amountSats or a missing persisted consent as
  // "unbounded") meant the guards below silently stopped guarding on exactly
  // the malformed responses they exist to catch.
  let invoiceSats = 0;
  try {
    invoiceSats = decodeBolt11Facts(invoice).amountSats;
  } catch (error) {
    throw new SwapKitV2Error(
      `v2 pay_lightning_invoice could not decode the bound invoice: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Number.isFinite(invoiceSats) || invoiceSats <= 0) {
    throw new SwapKitV2Error(
      "v2 pay_lightning_invoice was bound an invoice with no payable amount",
    );
  }
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new SwapKitV2Error("v2 pay_lightning_invoice action states no valid amountSats");
  }
  // The invoice is what actually gets funded, so it must equal what the action
  // claims: a small amountSats beside a large invoice would spend the larger.
  if (invoiceSats !== amountSats) {
    throw new SwapKitV2Error(
      `v2 pay_lightning_invoice amount mismatch: invoice encodes ${invoiceSats} sats but the action bound ${amountSats}`,
    );
  }

  // The user's consent, not the server's action, is the ceiling. It is
  // persisted on the order at commit and must exist for an order that spends —
  // its absence is a broken record, not permission.
  const stored = SwapKitV2OrderStore.get(ctx.orderId);
  const acceptedSats = Number(stored?.acceptedDeposit);
  if (!Number.isFinite(acceptedSats) || acceptedSats <= 0) {
    throw new SwapKitV2Error(
      "v2 pay_lightning_invoice has no persisted accepted deposit to bound the spend",
    );
  }
  const ceiling = Math.round(acceptedSats);
  if (invoiceSats > ceiling) {
    throw new SwapKitV2Error(
      `v2 pay_lightning_invoice exceeds the accepted deposit: ${invoiceSats} sats against an accepted ${ceiling}`,
    );
  }

  // STARTED is marked by the send primitive at its real boundary: after its
  // own funding-ceiling check, the invoice-expiry re-check and the passkey
  // approval, immediately before the lockup is funded. Marking here stranded
  // the action whenever any of those refused.
  const paid = await payArkadeLightningInvoice({
    invoice,
    amountSats,
    onBeforeBroadcast: async () => {
      await ctx.markStarted?.();
    },
  });
  const paymentHash = String(paid.paymentHash || request.paymentHash || "");
  if (!/^[0-9a-fA-F]{64}$/.test(paymentHash)) {
    throw new SwapKitV2Error("v2 pay_lightning_invoice yielded no payment hash");
  }
  return {
    paymentHash,
    ...(paid.preimage && /^[0-9a-fA-F]{64}$/.test(paid.preimage)
      ? { preimage: paid.preimage }
      : {}),
  };
}

// ── arkade_send ─────────────────────────────────────────────────────

export async function executeV2ArkadeSend(
  request: Record<string, unknown>,
  ctx: SwapKitV2ActionContext,
): Promise<{ arkTxid: string }> {
  const amountSats = Number(request.amountSats);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new SwapKitV2Error("v2 arkade_send action states no valid amountSats");
  }
  // The user's consent, not the server's action, is the ceiling. It is
  // persisted on the order at commit; its absence is a broken record, not
  // permission, so a spend with no stored ceiling is refused outright.
  const stored = SwapKitV2OrderStore.get(ctx.orderId);
  const acceptedSats = Number(stored?.acceptedDeposit);
  if (!Number.isFinite(acceptedSats) || acceptedSats <= 0) {
    throw new SwapKitV2Error("v2 arkade_send has no persisted accepted deposit to bound the spend");
  }
  if (amountSats > Math.round(acceptedSats)) {
    throw new SwapKitV2Error(
      `v2 arkade_send exceeds the accepted deposit: ${amountSats} sats against an accepted ${Math.round(acceptedSats)}`,
    );
  }
  // STARTED is marked by the send primitive itself, AFTER its preflight and
  // the user's approval and immediately before `wallet.send`. Marking here, up
  // front, stranded the action on a failed preflight or a cancelled approval.
  const arkTxid = await sendArkadeToArk({
    address: String(request.to),
    amountSats,
    onBeforeBroadcast: async () => {
      await ctx.markStarted?.();
    },
  });
  return { arkTxid };
}

// ── arkade_intents_fund ─────────────────────────────────────────────
//
// Fund the exact Arkade Intents covenant lockup and return the EXACT created
// VTXO outpoint. Unlike arkade_send this is NOT a generic send: the server
// verifies the returned {txid, vout} against the indexer (script rebuilds the
// covenant, amount matches), so the wallet must report the real created vout —
// fundArkadeIntentsOutpoint resolves it from the indexer rather than assuming 0.
/** The covenant fields a funding action carries (server contract, all or none). */
const ARKADE_FUND_COVENANT = [
  "rfqId",
  "destinationAddress",
  "refundLocktime",
  "lockupParams",
] as const;

/**
 * Prove the address we are about to fund is this order's own covenant.
 *
 * Fails closed on a partial bundle: the server emits all four or none, so a
 * subset is a contract violation and must never be read as "no covenant, carry
 * on". Absence of ALL four is the legacy path — an order created before the
 * covenant travelled with the funding action — and stays fundable.
 */
function assertArkadeIntentsFundingDestination(request: Record<string, unknown>): void {
  const present = ARKADE_FUND_COVENANT.filter((field) => request[field] !== undefined);
  if (present.length === 0) return; // pre-covenant order
  if (present.length !== ARKADE_FUND_COVENANT.length) {
    throw new SwapKitV2Error(
      `v2 arkade_intents_fund carries a partial covenant (${present.join(", ")}) — refusing to fund an address it cannot prove`,
    );
  }
  const to = String(request.to || "").trim();
  if (!to) throw new SwapKitV2Error("v2 arkade_intents_fund names no destination");
  let params: ReturnType<typeof parseLockupParams>;
  try {
    params = parseLockupParams((request.lockupParams ?? {}) as Record<string, unknown>);
  } catch (error) {
    throw new SwapKitV2Error(
      `v2 arkade_intents_fund has unreadable covenant parameters: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!rebuildLockupPkScript(params, to)) {
    throw new SwapKitV2Error(
      "v2 arkade_intents_fund destination does not rebuild from its own covenant — refusing to fund it",
    );
  }
}

export async function executeV2ArkadeIntentsFund(
  request: Record<string, unknown>,
  ctx: SwapKitV2ActionContext,
): Promise<{ arkTxid: string; outpoint: { txid: string; vout: number } }> {
  // A resumed send must still be payable. Reconciliation of an already-started
  // action is allowed after expiry: it reports the existing spend, never pays again.
  const stored = SwapKitV2OrderStore.get(ctx.orderId);
  if (!ctx.previouslyStarted) {
    // EVERY fresh funding attempt is held to the user's consent, whatever the
    // destination. The cap used to apply only to BTC_LN orders, so an
    // arkade_intents_fund on BTC_ARKADE→stable or BTC_LN→BTC could request any
    // amountSats. `acceptedDepositAmount` is the committed decimal-BTC deposit
    // on every Arkade-source flow; a row without a readable one is refused,
    // never treated as unbounded.
    const amountSats = Number(request.amountSats);
    const capSats = Math.round(Number(stored?.acceptedDepositAmount) * 1e8);
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      throw new SwapKitV2Error("v2 arkade_intents_fund states no valid amountSats");
    }
    if (!Number.isFinite(capSats) || capSats <= 0) {
      throw new SwapKitV2Error(
        "v2 arkade_intents_fund has no persisted accepted deposit to bound the spend",
      );
    }
    if (amountSats > capSats) {
      throw new SwapKitV2Error(
        `v2 arkade_intents_fund exceeds the accepted deposit: ${amountSats} sats against an accepted ${capSats}`,
      );
    }
    if (stored?.to === "BTC_LN") {
      const facts = decodeBolt11Facts(stored.settleTarget);
      if (facts.expiresAt <= Date.now() / 1000)
        throw new SwapKitV2Error("Lightning invoice has expired.");
    }
  }
  // The destination must be THIS order's covenant, not merely an ark1 address.
  //
  // The server names the lockup to fund. Until the funding action carried the
  // covenant's public parameters (server #346) the wallet had nothing to check
  // that name against: it bounded the AMOUNT by the user's accepted deposit and
  // then paid wherever it was told. So it rebuilds the covenant here and
  // requires it to derive the exact address it was asked to fund — the same
  // gate, from the same function, the refund path has always applied.
  //
  // A covenant-less request is an order created BEFORE that change, whose
  // stored action must still be fundable; the server refuses to emit one for a
  // live order, so absence here means age, not a missing proof. A PARTIAL
  // bundle never reaches the wallet for the same reason, but is refused anyway
  // rather than treated as absent.
  if (!ctx.previouslyStarted) {
    assertArkadeIntentsFundingDestination(request);
  }
  // A reconciling call reports an EXISTING spend and never pays again, so it is
  // not a second irreversible act. Only the funding path marks the boundary.
  // The funding path marks STARTED inside sendArkadeToArk, after its preflight
  // and approval; the reconciling path never calls it and never marks.
  return fundArkadeIntentsOutpoint({
    lockupAddress: String(request.to),
    amountSats: Number(request.amountSats),
    reconcileOnly: ctx.previouslyStarted === true,
    onBeforeBroadcast: async () => {
      await ctx.markStarted?.();
    },
  });
}

// ── arkade_claim ────────────────────────────────────────────────────

/** Claim the bound VHTLC to THIS wallet's own Arkade address — the bound
 * destination must equal our derived address; a claim to any other address is
 * refused before signing (v1 rule: never claim to a server-named address).
 * Wallet material resolves through the wallet-minted keyRef; a server-owned
 * preimage (Phase B) is allowed — the VHTLC hashLock binding still gates it. */
export async function executeV2ArkadeClaim(
  request: Record<string, unknown>,
  _ctx: SwapKitV2ActionContext,
): Promise<{ arkTxid: string }> {
  if (request.outpoint != null) {
    throw new SwapKitV2Error(
      "v2 arkade_claim outpoint form is not wired for this wallet; expected the provider VHTLC descriptor form",
    );
  }
  const keyRef = requireKeyRef(request);
  const localAddress = await getArkadeReceiveAddress();
  const destination = String(request.destinationAddress || "");
  if (destination !== localAddress) {
    throw new SwapKitV2Error("v2 arkade_claim destination is not this wallet's own Arkade address");
  }
  const serverPreimage = String(request.preimage || "");
  // Wallet-owned preimage path verifies our derivation; server-owned preimage
  // (Phase B) still needs OUR swap key for the claim signature, so the ref
  // must be ours either way — only the hash check differs (the claim service
  // binds the server preimage to the VHTLC hashLock before signing).
  const parsed = parseWalletKeyRef(keyRef.walletKeyRef);
  if (!parsed || parsed.provider !== keyRef.provider) {
    throw new SwapKitV2Error("v2 keyRef was not minted by this wallet — refusing to claim");
  }
  if (!serverPreimage) await resolveOwnKeyRef(keyRef);
  const arkTxid = await claimSwapKitArkadeVhtlc({
    provider: parsed.provider,
    keyIndex: parsed.keyIndex,
    preimageHash: keyRef.preimageHash,
    ...(serverPreimage ? { serverPreimageHex: serverPreimage } : {}),
    vhtlc: request.vhtlc as SwapKitArkadeVhtlcParams,
    destinationAddress: destination,
  });
  return { arkTxid };
}

// ── arkade_refund_material ──────────────────────────────────────────

// The same material, sent with the commit when the server takes it (swapkit #421).
setV2CommitRefundMaterialSource((scope) => deriveArkadeIntentsRefundMaterial(scope));
// What the Arkade funding send waits for, read while the server commits.
setV2FundingWarmup(() => warmArkadeSend());

/** Provide the PUBLIC material a server needs to build an Arkade Intents lockup
 * covenant: the x-only sender public key plus a wallet-minted opaque keyRef.
 * Pure material exchange — no money moves, no consent tap.
 *
 * The sender key MUST be the one the refund can actually sign with. An Arkade
 * Intents covenant is spent through the Arkade `contractSigner`, whose key is
 * the wallet's deterministic `provisionRefundKey(wallet)` (for Nuri's
 * static-descriptor wallet this is a pure function of the passkey-bound
 * identity — stable across calls and across a full wipe). Deriving the sender
 * from the EVM satora HTLC scalar instead (`deriveSwapKitHtlcMaterial`) would
 * bind a key the refund core can never reproduce, leaving a funded covenant
 * permanently unrefundable. So bind the Arkade key here and mint an opaque
 * Arkade-scoped ref; the refund resolves the same wallet key locally. */
export async function executeV2ArkadeRefundMaterial(
  request: Record<string, unknown>,
  _ctx: SwapKitV2ActionContext,
): Promise<{ senderPublicKey: string; walletKeyRef: string }> {
  const scope = String(request.scope || "");
  const { senderPublicKey, walletKeyRef } = await deriveArkadeIntentsRefundMaterial(scope);
  return { senderPublicKey, walletKeyRef };
}

// ── arkade_intents_refund ───────────────────────────────────────────

/** Refund a funded Arkade Intents lockup after its bound timelock, reusing the
 * v1 refund core verbatim (SwapKitArkadeIntentsActionService#refundArkadeIntentsLockup):
 * it binds the refund to a swap THIS wallet funded, refuses a substituted
 * lockup/destination/sender-key/payout-script, rebuilds the covenant from the
 * bound `lockupParams` and confirms it rebuilds to the funded lockup address,
 * then signs `refundWithoutReceiver` with the key provisioned at payment time.
 * The bound `refundLocktime` gates it: a not-yet-mature refund is surfaced as a
 * fail-closed error the tracker treats as blocked, never a spurious success. No
 * new derivation or crypto — the wallet resolves its own material locally. */
export async function executeV2ArkadeIntentsRefund(
  request: Record<string, unknown>,
  ctx: SwapKitV2ActionContext,
): Promise<{ arkTxid: string }> {
  // The wallet-owned ref must be one this wallet minted (fail closed on a
  // foreign ref) before any covenant material is touched. Two mint shapes are
  // this wallet's own: the Arkade Intents ref from arkade_refund_material
  // (`nuri-arkade-intents-v1:*`) and — for older orders — the htlc keyRef.
  // The refund core resolves the actual signer from the wallet's deterministic
  // provisionRefundKey, so the ref only carries provenance.
  const walletKeyRef = String(request.walletKeyRef || "");
  if (!isArkadeIntentsRefundKeyRef(walletKeyRef) && !parseWalletKeyRef(walletKeyRef)) {
    throw new SwapKitV2Error(
      "v2 arkade_intents_refund walletKeyRef was not minted by this wallet — refusing to refund",
    );
  }
  const { arkTxid } = await refundArkadeIntentsLockup(
    {
      rfqId: String(request.rfqId || "").trim(),
      lockupAddress: String(request.lockupAddress || "").trim(),
      destinationAddress: String(request.destinationAddress || "").trim(),
      params: parseLockupParams((request.lockupParams ?? {}) as Record<string, unknown>),
    },
    {
      opId: `v2:${ctx.orderId}:${ctx.actionId}`,
      // Contract 2.2.0 binds `refundLocktime`; block a premature refund rather
      // than push a spend the covenant leaf cannot yet confirm.
      nowSeconds: () => Math.floor(Date.now() / 1000),
    },
  );
  return { arkTxid };
}

// ── Executor sets per flow ──────────────────────────────────────────

/** The standard order-flow executor set: everything the wallet can do EXCEPT
 * send_asset — normal flows must never send funds to a server-named address
 * (v1 rule; sweep flows add their own bounded funder). */
/**
 * Bounded loop options for a Base-stable source leg.
 *
 * Every EVM-source flow (direct stable↔stable, stable→BTC) and the resume-time
 * rebuild need the IDENTICAL pair: EVM calls restricted to the source chain,
 * and an allowance ceiling at the accepted deposit, unchanged. Deriving them in one
 * place is what keeps a resumed order's ceiling equal to the live one — when
 * these drifted apart, a restarted order installed unbounded executors and its
 * approval-bearing call could never be signed.
 */
/**
 * The executors an EVM-SOURCE order may use.
 *
 * An order funded from a Base stablecoin must never be able to debit the ARKADE
 * wallet — a different pot of money the user never put up for this order. The
 * universal set armed `pay_lightning_invoice`, `arkade_send` and
 * `arkade_intents_fund`, so a server response (or a mistaken route) asking for
 * one would have been honoured. Those three FUNDING kinds are removed here.
 *
 * The receive-side kinds stay: `arkade_claim`, `htlc_material` and both refunds
 * move the wallet's own money HOME (a settled claim, or a timelocked refund) and
 * a stable→BTC route can legitimately need them.
 */
const EVM_SOURCE_FORBIDDEN_KINDS = [
  "pay_lightning_invoice",
  "arkade_send",
  "arkade_intents_fund",
] as const;

/** Capabilities an EVM-source order may advertise — exactly the kinds it can
 * execute. Derived from the same list the executors are, so the two cannot
 * drift: advertising a kind with no executor stalls the order at that action. */
export const SWAPKIT_V2_EVM_SOURCE_CAPABILITIES = SWAPKIT_V2_ACTION_KINDS.filter(
  (kind) =>
    kind !== "send_asset" && !(EVM_SOURCE_FORBIDDEN_KINDS as readonly string[]).includes(kind),
);

export function standardEvmLoopOptions(
  chainId: number,
  acceptedDeposit: number,
  decimals: number,
  sourceToken: `0x${string}`,
  settle: SwapKitV2SettleBinding | null,
): { executors: SwapKitV2Executors; allowedEvmChains: readonly number[] } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(sourceToken || ""))) {
    // Without the source token nothing can be bound to the route; an unbound
    // EVM-source order is exactly what this builder exists to prevent.
    throw new Error("standard_evm order has no source token to bind its calls to");
  }
  const executors = makeStandardV2Executors({
    allowedEvmChains: [chainId],
    maxApprovalUnits: approvalCeiling(acceptedDeposit, decimals),
    // Every call is bound to the accepted order: approve only a route
    // provider on THIS token, and a LI.FI call must pay the committed
    // recipient. Amounts are the server's; the only one checked is the
    // accepted deposit itself.
    route: { chainId, sourceToken, settle },
  });
  for (const kind of EVM_SOURCE_FORBIDDEN_KINDS) delete executors[kind];
  return { executors, allowedEvmChains: [chainId] };
}

/**
 * The ONLY executors a row with no reconstructable consent may use.
 *
 * An order re-adopted from swap_list after a reinstall has no accepted quote,
 * route or amount on this device. Every kind here moves value back to THIS
 * wallet (a claim to its own derived address, a timelocked refund, the refund
 * public key); nothing funds, signs a spend, or authorises an allowance. A
 * ready funding action on such a row stops the loop and surfaces to the user.
 */
export function makeRecoveryOnlyV2Executors(): SwapKitV2Executors {
  return {
    arkade_claim: executeV2ArkadeClaim,
    arkade_refund_material: executeV2ArkadeRefundMaterial,
    arkade_intents_refund: executeV2ArkadeIntentsRefund,
  };
}

export function makeStandardV2Executors(options?: {
  allowedEvmChains?: readonly number[];
  allowedApprovalTokens?: readonly string[];
  maxApprovalUnits?: bigint;
  requireApprovalBound?: boolean;
  route?: SwapKitV2EvmRouteBinding;
  onEvmBroadcast?: (hash: `0x${string}`) => void | Promise<void>;
}): SwapKitV2Executors {
  // Raw EVM execution is offered ONLY to an EVM-source order carrying its
  // committed route, where every call is bound (known targets, decoded
  // selectors, recipient and settlement). Anywhere else — including the
  // sweep, whose approval ceiling caps an amount but not a target — the
  // signer would sign server-chosen calldata, so the kind is not installed.
  const evmBound = options?.route != null;
  return {
    ...(evmBound
      ? {
          execute_evm_call: makeV2ExecuteEvmCall({
            allowedChains: options?.allowedEvmChains,
            allowedApprovalTokens: options?.allowedApprovalTokens,
            maxApprovalUnits: options?.maxApprovalUnits,
            ...(options?.requireApprovalBound ? { requireApprovalBound: true } : {}),
            ...(options?.route ? { route: options.route } : {}),
            onBroadcast: options?.onEvmBroadcast,
          }),
        }
      : {}),
    // Signing is route-bound: without a committed route there is nothing to
    // bind a signature to, so the kind is simply not offered.
    ...(options?.route
      ? {
          sign_typed_data: makeV2SignTypedData({
            chainId: options.route.chainId,
            sourceToken: options.route.sourceToken,
            ceiling: options.maxApprovalUnits ?? null,
            settle: options.route.settle,
          }),
        }
      : {}),
    pay_lightning_invoice: executeV2PayLightningInvoice,
    htlc_material: executeV2HtlcMaterial,
    arkade_send: executeV2ArkadeSend,
    arkade_intents_fund: executeV2ArkadeIntentsFund,
    arkade_claim: executeV2ArkadeClaim,
    // Both refund kinds are safe in the standard set: they move the wallet's
    // OWN funds home after a timelock, never funding a server-named address.
    arkade_refund_material: executeV2ArkadeRefundMaterial,
    arkade_intents_refund: executeV2ArkadeIntentsRefund,
  };
}

/** Sanity gate for callers that pass an owner address into quote/commit: the
 * owner must be this wallet's own EOA. */
export async function assertOwnerIsWalletEoa(owner: string): Promise<void> {
  const eoa = await getEthereumAddress();
  if (!eoa || eoa.toLowerCase() !== String(owner || "").toLowerCase()) {
    throw new SwapKitV2Error("v2 owner is not this wallet's EOA");
  }
}
