import { ripemd160 } from "@noble/hashes/legacy";
import { base64, hex } from "@scure/base";
import {
  ArkAddress,
  CSVMultisigTapscript,
  ConditionWitness,
  SingleKey,
  Transaction,
  VHTLC,
  buildOffchainTx,
  setArkPsbtField,
} from "@arkade-os/sdk";
import { bytesToHex, sha256, zeroize } from "../../lib/crypto";
import { LOG_EMOJI, logWithId } from "../../lib/OperationLogUtils";
import {
  materializeSwapKitHtlcPreimage,
  materializeSwapKitHtlcSwapKey,
} from "./SwapKitHtlcSecretService";
import {
  arkTxidCreditedAtScript,
  decideVhtlcSpend,
  planVhtlcSpend,
  recoverSpentVhtlcVtxos,
  resolveVhtlcAddressVtxos,
  vhtlcCheckpointUnrollCandidates,
} from "./swapKitVhtlcPendingRecovery";
import { isVhtlcRefundable } from "./vhtlcRefundTiming";
import {
  settleSweptVhtlcRefund,
  sweptUnspentVtxos,
  toSweptVhtlcCoin,
  type SweptVhtlcVtxo,
} from "./swapKitVhtlcBatchRefund";
import { vhtlcScriptClass } from "./vhtlcScriptVersion";
import { getOrCreateWallet } from "../arkade/internal/walletCache";

export { isVhtlcRefundable };

/**
 * Provider-neutral Arkade VHTLC claim for SwapKit `arkade_vhtlc_v1` actions
 * (server contract: nuri-mcp-bitcoin-swapkit src/arkade-wallet-contract.mjs,
 * release v0.6.18). The server prepares every VHTLC parameter; this adapter:
 *
 *   1. derives the swap key + preimage from keyRef (SwapKitHtlcSecretService),
 *   2. verifies SHA256(preimage) === keyRef.preimageHash and
 *      RIPEMD160(SHA256(preimage)) === request.vhtlc.hashLock,
 *   3. reconstructs the VHTLC script and REQUIRES its address to equal
 *      request.vhtlc.address — a single wrong parameter fails closed here,
 *   4. spends the VTXO(s) via the claim tapleaf to request.destinationAddress
 *      using the Ark offchain-tx flow, parameterized entirely by the
 *      server-supplied VHTLC,
 *   5. returns the public arkTxid.
 *
 * The offchain flow builds the claim tx and its checkpoints locally. We do not
 * re-verify the server's signatures on the final tx — the ark server cannot
 * spend the claim leaf without our signature, so the worst case of a bad server
 * response is a failed claim, not lost funds.
 */

const SOURCE = "services/swapkit/SwapKitArkadeVhtlcService.ts";
const VTXO_RETRY_ATTEMPTS = 10;
const VTXO_RETRY_DELAY_MS = 3_000;

export type SwapKitArkadeVhtlcParams = {
  address: string;
  amountSats: number;
  hashLock: string;
  senderPublicKey: string;
  receiverPublicKey: string;
  arkadeServerPublicKey: string;
  refundLocktime: number;
  unilateralClaimDelay: number;
  unilateralRefundDelay: number;
  unilateralRefundWithoutReceiverDelay: number;
  network?: string;
  /**
   * Which vHTLC script the provider locked to: 0 the original, 1 the strict one
   * whose preimage leaves carry a length check. Satora requires the strict
   * script on its Arkade corridor since 2026-08-21; the two compile to
   * different bytes and therefore to different addresses, so the wrong choice
   * cannot claim or refund what the right one funded. Absent means 0 — every
   * order created before the field existed is an original-script order.
   */
  scriptVersion?: number;
};

function fail(reason: string): never {
  throw new Error(`SwapKit Arkade VHTLC rejected: ${reason}`);
}

const stripHex = (value: unknown): string =>
  String(value || "")
    .trim()
    .replace(/^0x/i, "")
    .toLowerCase();

function hexBytes(value: unknown, field: string, byteLength?: number): Uint8Array {
  const clean = stripHex(value);
  if (!/^[0-9a-f]*$/.test(clean) || clean.length === 0 || clean.length % 2 !== 0) {
    fail(`${field} is not valid hex`);
  }
  const bytes = hex.decode(clean);
  if (byteLength != null && bytes.length !== byteLength) {
    fail(`${field} must be ${byteLength} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** x-only (32-byte) key from a compressed (33-byte) or x-only server value. */
function xOnly(value: unknown, field: string): Uint8Array {
  const bytes = hexBytes(value, field);
  if (bytes.length === 33) return bytes.slice(1);
  if (bytes.length === 32) return bytes;
  fail(`${field} must be a 32- or 33-byte public key`);
}

// Same convention the Ark stack uses for CSV values (see the SDK's sweep
// tapscript): >= 512 encodes seconds, below that block count.
const relativeTimelock = (value: unknown, field: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${field} must be a positive integer`);
  return { type: n >= 512 ? ("seconds" as const) : ("blocks" as const), value: BigInt(n) };
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function log(message: string, data?: Record<string, unknown>, action = "claim"): void {
  logWithId(`${LOG_EMOJI.bitcoin} SwapKitArkadeVhtlc`, message, data, {
    source: `${SOURCE}#${action}SwapKitArkadeVhtlc`,
    event: "FLOW",
    action,
  });
}

/**
 * Reconstruct the VHTLC script from the server's parameters and prove it by
 * address equality: one wrong key, hash or timelock and this fails BEFORE any
 * signing. Shared by claim and refund — both stand or fall on this check.
 */
async function reconstructVhtlc(vhtlc: SwapKitArkadeVhtlcParams, destination: string) {
  const serverXOnly = xOnly(vhtlc.arkadeServerPublicKey, "vhtlc.arkadeServerPublicKey");
  const ScriptForVersion = vhtlcScriptClass(vhtlc.scriptVersion);
  const script = new ScriptForVersion({
    sender: xOnly(vhtlc.senderPublicKey, "vhtlc.senderPublicKey"),
    receiver: xOnly(vhtlc.receiverPublicKey, "vhtlc.receiverPublicKey"),
    server: serverXOnly,
    preimageHash: hexBytes(vhtlc.hashLock, "vhtlc.hashLock", 20),
    refundLocktime: BigInt(Number(vhtlc.refundLocktime)),
    unilateralClaimDelay: relativeTimelock(vhtlc.unilateralClaimDelay, "unilateralClaimDelay"),
    unilateralRefundDelay: relativeTimelock(vhtlc.unilateralRefundDelay, "unilateralRefundDelay"),
    unilateralRefundWithoutReceiverDelay: relativeTimelock(
      vhtlc.unilateralRefundWithoutReceiverDelay,
      "unilateralRefundWithoutReceiverDelay",
    ),
  });

  const wallet = await getOrCreateWallet();
  if (
    script.address(wallet.network.hrp, serverXOnly).encode() !== String(vhtlc.address || "").trim()
  ) {
    fail("reconstructed VHTLC address does not match vhtlc.address");
  }
  const destinationDecoded = ArkAddress.decode(destination);
  if (destinationDecoded.hrp !== wallet.network.hrp) {
    fail("destinationAddress is on the wrong Arkade network");
  }
  return { script, wallet, destinationDecoded };
}

/**
 * Spend every unspent VTXO at the VHTLC via `tapLeafScript` to `outputScript`
 * using the Ark offchain-tx flow, and return the last arkTxid. `sign` is the
 * caller's identity wrapper (the claim attaches a preimage witness, the refund
 * signs plainly). CLTV leaves need no special handling: buildOffchainTx reads
 * the absolute timelock off the tapscript and sets nLockTime/sequence itself.
 */
async function spendVhtlcVtxos(args: {
  script: InstanceType<typeof VHTLC.Script>;
  wallet: Awaited<ReturnType<typeof reconstructVhtlc>>["wallet"];
  tapLeafScript: ReturnType<InstanceType<typeof VHTLC.Script>["claim"]>;
  outputScript: Uint8Array;
  sign: (tx: Transaction, inputIndexes?: number[]) => Promise<Transaction>;
  action: string;
  /** Preimage for a claim leaf, needed on the proof input of the recovery path. */
  witness?: Uint8Array[];
  /**
   * Called the instant the ASP accepts a submit, so a crash before the action
   * completes still leaves the arkTxid written down. It marks the action as
   * PENDING: only the caller's post-call journal write completes it, because a
   * single finalized VTXO out of several is not a finished action.
   */
  onSubmittedArkTxid?: (arkTxid: string) => Promise<void>;
  /** The txid a previous run journaled at submit; the result to report when the
   * inputs are already spent and nothing is pending (the finalize→journal crash). */
  previouslySubmittedArkTxid?: string;
}): Promise<string> {
  const { script, wallet, tapLeafScript, outputScript, sign, action } = args;

  // Find the funded VTXO(s). The action may arrive before the lockup is
  // indexed — retry briefly; the swap loop re-presents the action anyway.
  const scriptHex = hex.encode(script.pkScript);
  const { seen } = await resolveVhtlcAddressVtxos({
    queryVtxos: async () =>
      (await wallet.indexerProvider.getVtxos({ scripts: [scriptHex] }))?.vtxos ?? [],
    retryAttempts: VTXO_RETRY_ATTEMPTS,
    retryDelayMs: VTXO_RETRY_DELAY_MS,
    wait,
  });
  const arkInfo = await wallet.arkProvider.getInfo();
  const serverUnrollScript = CSVMultisigTapscript.decode(
    hex.decode(String(arkInfo.checkpointTapscript)),
  );
  const unrollCandidates = vhtlcCheckpointUnrollCandidates(String(arkInfo.checkpointTapscript));

  const plan = planVhtlcSpend(seen);
  const unspent = plan.toSpend;

  // A coin that reads spent is either genuinely spent or the input of a spend
  // that was submitted and never finalized. Recover that FIRST, even when other
  // coins at this address are still spendable: spending only the rest would
  // return success and leave the interrupted input pending forever.
  const recovery = await recoverSpentVhtlcVtxos({
    provider: wallet.arkProvider,
    spentCoins: plan.toRecover,
    unrollCandidates,
    sign,
    ...(args.onSubmittedArkTxid ? { onSubmittedArkTxid: args.onSubmittedArkTxid } : {}),
    toCoin: (vtxo) => ({
      txid: String(vtxo.txid),
      vout: vtxo.vout,
      value: vtxo.value,
      tapTree: script.encode(),
      intentTapLeafScript: tapLeafScript,
      extraWitness: args.witness,
    }),
  });
  if (recovery.txid) {
    log(
      `${action}ed VHTLC vtxo after an interrupted submit — finalized ${recovery.txid}`,
      { arkTxid: recovery.txid },
      action,
    );
  }

  // A journaled txid is only proof of a *submitted* spend, and a finalize that
  // was rejected leaves the same state as one whose response was lost. Ask the
  // indexer whether the outputs were actually credited before using it.
  const previousTxid = String(args.previouslySubmittedArkTxid || "").trim();
  const previousCredited = previousTxid
    ? await arkTxidCreditedAtScript({
        indexerProvider: wallet.indexerProvider,
        arkTxid: previousTxid,
        outputScriptHex: hex.encode(outputScript),
      }).catch(() => false)
    : false;
  if (previousTxid && !previousCredited) {
    log(
      `VHTLC ${action} journaled txid ${previousTxid} is not credited at the destination — refusing to report it as done`,
      { arkTxid: previousTxid },
      action,
    );
  }
  const decision = decideVhtlcSpend({
    plan,
    recovery,
    previouslySubmittedArkTxid: previousCredited ? previousTxid : undefined,
  });
  switch (decision.kind) {
    case "deliver-unindexed":
      fail("no spendable VTXO found at the VHTLC address yet");
      break;
    case "abort-recovery-failed":
      // Fail closed. Spending the remaining coins here would return success
      // while a known-pending input is still out there, and nothing would ever
      // come back for it.
      log(
        `VHTLC pending-tx recovery did not complete for ${action} — retrying later`,
        undefined,
        action,
      );
      fail("VHTLC pending-tx recovery did not complete");
      break;
    case "return-recovered":
    case "return-previous":
      return decision.txid;
    case "rejected-already-spent":
      fail("VHTLC is already spent");
      break;
    default:
      break;
  }

  let lastTxid = "";
  for (const vtxo of unspent) {
    const input = { ...vtxo, tapLeafScript, tapTree: script.encode() };
    const output = { amount: BigInt(vtxo.value), script: outputScript };
    const { arkTx, checkpoints } = buildOffchainTx([input], [output], serverUnrollScript);
    const signedArkTx = await sign(arkTx);
    const { arkTxid, signedCheckpointTxs } = await wallet.arkProvider.submitTx(
      base64.encode(signedArkTx.toPSBT()),
      checkpoints.map((checkpoint) => base64.encode(checkpoint.toPSBT())),
    );
    await args.onSubmittedArkTxid?.(arkTxid);
    const finalCheckpoints = await Promise.all(
      signedCheckpointTxs.map(async (checkpoint, index) => {
        const tx = Transaction.fromPSBT(base64.decode(checkpoint));
        // The ASP chose this blob. Sign only the checkpoint we built for this
        // coin: a substituted one with the same script would otherwise take a
        // signature (and the claim's preimage witness) for a different spend.
        const expected = checkpoints[index];
        if (!expected || tx.id !== expected.id) {
          fail(`${action} refused: server checkpoint ${index} does not match the local checkpoint`);
        }
        const signed = await sign(tx, [0]);
        return base64.encode(signed.toPSBT());
      }),
    );
    await wallet.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
    lastTxid = arkTxid;
    // Ids in the sentence, not in a data field the console never renders (#872).
    log(
      `${action}ed VHTLC vtxo ${vtxo.txid} — ${vtxo.value} sats, arkTxid ${arkTxid}`,
      { arkTxid, sats: vtxo.value, vtxo: String(vtxo.txid) },
      action,
    );
  }
  if (!lastTxid) fail(`${action} produced no transaction`);
  return lastTxid;
}

/**
 * Claim a SwapKit-prepared Arkade VHTLC and return the public arkTxid.
 * Everything is verified fail-closed BEFORE the key signs anything.
 */
export async function claimSwapKitArkadeVhtlc(args: {
  provider: string;
  keyIndex: number;
  /** keyRef.preimageHash — 32-byte SHA256(preimage), 0x-hex. */
  preimageHash: string;
  /**
   * Phase B (server-owned preimage): the action carries the 32-byte preimage
   * itself. When present the witness is built from it instead of the wallet
   * derivation — the hashLock/preimageHash bindings below still gate it, and
   * the wallet still signs with its own swap key. This is what unhooks the
   * claim from local key-index state (the Arkade-spinner root cause).
   */
  serverPreimageHex?: string;
  vhtlc: SwapKitArkadeVhtlcParams;
  destinationAddress: string;
  /** Journal hook: called once the ASP accepts a submit. */
  onSubmittedArkTxid?: (arkTxid: string) => Promise<void>;
  /** The txid this action journaled on an earlier run, if any. */
  previouslySubmittedArkTxid?: string;
}): Promise<string> {
  const { provider, keyIndex, vhtlc } = args;
  const destination = String(args.destinationAddress || "").trim();
  if (!destination) fail("destinationAddress is missing");
  const amountSats = Number(vhtlc?.amountSats);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    fail("vhtlc.amountSats must be positive integer sats");
  }

  // 1+2: obtain and bind the secret material to the server's commitments.
  // Server preimage (Phase B) wins over local derivation; either way nothing
  // signs until every hash binding below holds.
  const preimage = args.serverPreimageHex
    ? hexBytes(args.serverPreimageHex, "action.preimage", 32)
    : await materializeSwapKitHtlcPreimage(provider, keyIndex);
  const swapKey = await materializeSwapKitHtlcSwapKey(provider, keyIndex);
  try {
    const sha = sha256(preimage);
    // keyRef.preimageHash is mandatory for wallet-derived material; in
    // server-preimage mode it may be absent (hashLock is the binding that
    // secures the claim), but when present it must still agree.
    if (stripHex(args.preimageHash)) {
      if (bytesToHex(sha) !== stripHex(args.preimageHash)) {
        fail("keyRef.preimageHash does not match the claim preimage");
      }
    } else if (!args.serverPreimageHex) {
      fail("keyRef.preimageHash is missing");
    }
    if (bytesToHex(ripemd160(sha)) !== stripHex(vhtlc.hashLock)) {
      fail("vhtlc.hashLock is not RIPEMD160(SHA256(preimage)) of this wallet's preimage");
    }

    const identity = SingleKey.fromPrivateKey(swapKey);
    const ourXOnly = await identity.xOnlyPublicKey();
    const receiverXOnly = xOnly(vhtlc.receiverPublicKey, "vhtlc.receiverPublicKey");
    if (bytesToHex(ourXOnly) !== bytesToHex(receiverXOnly)) {
      fail("vhtlc.receiverPublicKey is not this wallet's swap key — refusing to claim");
    }

    // 3: reconstruct the script; the address equality proves EVERY parameter
    // (keys, hashLock, all four timelocks and their type encoding) at once.
    const { script, wallet, destinationDecoded } = await reconstructVhtlc(vhtlc, destination);

    // 4+5: spend the claim leaf, revealing the preimage as the condition
    // witness on every signed input, exactly as the VHTLC claim identity
    // requires.
    return await spendVhtlcVtxos({
      script,
      wallet,
      tapLeafScript: script.claim(),
      outputScript: destinationDecoded.pkScript,
      action: "claim",
      witness: [preimage],
      onSubmittedArkTxid: args.onSubmittedArkTxid,
      previouslySubmittedArkTxid: args.previouslySubmittedArkTxid,
      sign: async (tx: Transaction, inputIndexes?: number[]) => {
        const signed = await identity.sign(tx.clone(), inputIndexes);
        const rebuilt = Transaction.fromPSBT(signed.toPSBT());
        const indexes = inputIndexes ?? Array.from({ length: rebuilt.inputsLength }, (_, i) => i);
        for (const inputIndex of indexes) {
          setArkPsbtField(rebuilt, inputIndex, ConditionWitness, [preimage]);
        }
        return rebuilt;
      },
    });
  } finally {
    zeroize(preimage);
    zeroize(swapKey);
  }
}

/**
 * Refund a SwapKit-prepared Arkade VHTLC back to the swap's bound refund
 * address and return the public arkTxid.
 *
 * Takes the `refundWithoutReceiver` leaf — CLTV(refundLocktime) + multisig of
 * [sender, server]. The RECEIVER (the swap provider) is deliberately not a
 * signer there, which is exactly why this path works when the provider has
 * gone silent mid-swap: our wallet key plus the ark server is enough. No
 * preimage is involved; a refund is the swap NOT happening.
 *
 * Fail-closed like the claim: same address reconstruction, and our key must be
 * the VHTLC's `sender` (in the arkade→EVM direction the user funds the VHTLC,
 * so the user is the sender, not the receiver).
 *
 * Callers must only invoke this once `refundLocktime` has passed — before that
 * the leaf is unspendable by consensus. See isVhtlcRefundable().
 */
export async function refundSwapKitArkadeVhtlc(args: {
  provider: string;
  keyIndex: number;
  vhtlc: SwapKitArkadeVhtlcParams;
  destinationAddress: string;
  /** Journal hook: called once the ASP accepts a submit. */
  onSubmittedArkTxid?: (arkTxid: string) => Promise<void>;
  /** The txid this action journaled on an earlier run, if any. */
  previouslySubmittedArkTxid?: string;
}): Promise<string> {
  const { provider, keyIndex, vhtlc } = args;
  const destination = String(args.destinationAddress || "").trim();
  if (!destination) fail("destinationAddress is missing");

  if (!isVhtlcRefundable(vhtlc)) {
    fail(`refundLocktime ${Number(vhtlc?.refundLocktime)} has not passed yet`);
  }

  const swapKey = await materializeSwapKitHtlcSwapKey(provider, keyIndex);
  try {
    const identity = SingleKey.fromPrivateKey(swapKey);
    const ourXOnly = await identity.xOnlyPublicKey();
    if (
      bytesToHex(ourXOnly) !== bytesToHex(xOnly(vhtlc.senderPublicKey, "vhtlc.senderPublicKey"))
    ) {
      fail("vhtlc.senderPublicKey is not this wallet's swap key — refusing to refund");
    }

    const { script, wallet, destinationDecoded } = await reconstructVhtlc(vhtlc, destination);

    // A lock the operator already swept cannot be spent offchain any more
    // (VTXO_RECOVERABLE), whatever is retried. It can only leave in a batch,
    // through the same refund leaf and the same swap key (#1472).
    const scriptHex = hex.encode(script.pkScript);
    const previous = String(args.previouslySubmittedArkTxid || "").trim();
    if (
      previous &&
      (await arkTxidCreditedAtScript({
        indexerProvider: wallet.indexerProvider,
        arkTxid: previous,
        outputScriptHex: hex.encode(destinationDecoded.pkScript),
      }).catch(() => false))
    ) {
      return previous;
    }
    const indexed = ((await wallet.indexerProvider.getVtxos({ scripts: [scriptHex] }))?.vtxos ??
      []) as SweptVhtlcVtxo[];
    const swept = sweptUnspentVtxos(indexed);
    if (swept.length > 0) {
      const refundLeaf = script.refundWithoutReceiver();
      const coins = swept.map((vtxo) =>
        toSweptVhtlcCoin(vtxo, { pkScriptHex: scriptHex, tapTree: script.encode(), refundLeaf }),
      );
      const session = identity.signerSession();
      const commitmentTxid = await settleSweptVhtlcRefund(
        {
          coins,
          destinationAddress: destination,
          destinationScript: destinationDecoded.pkScript,
        },
        {
          provider: wallet.arkProvider as never,
          sign: (tx: Transaction, inputIndexes?: number[]) => identity.sign(tx, inputIndexes),
          session,
          createBatchHandler: (intentId, inputs, recipients, batchSession) =>
            wallet.createBatchHandler(
              intentId,
              inputs as never,
              recipients,
              batchSession as ReturnType<typeof identity.signerSession>,
            ),
          onCommitment: async (txid) => {
            await args.onSubmittedArkTxid?.(txid);
          },
        },
      );
      log(
        `refunded swept VHTLC in batch — ${coins.reduce((sum, coin) => sum + coin.value, 0)} sats, commitment ${commitmentTxid}`,
        { commitmentTxid },
        "refund",
      );
      return commitmentTxid;
    }

    // No condition witness here: the refundWithoutReceiver leaf is a plain
    // CLTV multisig, so a straight signature is the whole witness.
    return await spendVhtlcVtxos({
      script,
      wallet,
      tapLeafScript: script.refundWithoutReceiver(),
      outputScript: destinationDecoded.pkScript,
      action: "refund",
      sign: (tx: Transaction, inputIndexes?: number[]) => identity.sign(tx, inputIndexes),
      onSubmittedArkTxid: args.onSubmittedArkTxid,
      previouslySubmittedArkTxid: args.previouslySubmittedArkTxid,
    });
  } finally {
    zeroize(swapKey);
  }
}
