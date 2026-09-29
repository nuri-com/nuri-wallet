import * as btc from "@scure/btc-signer";
import { blockchainService } from "../../services/bitcoin/BlockchainService";
import { bytesToBase64, hexToBytes } from "../bytes";

const DUST_SATS = BigInt(546);
const TAP_MERKLE_ROOT_LEN = 32;

// The transaction this module builds, in vbytes: 10.5 of overhead (4 version,
// 4 locktime, 1 input count, 1 output count and 0.5 for the segwit marker and
// flag), 57.5 per P2TR key-path input (41 base bytes plus a 66-weight-unit
// witness carrying one schnorr signature) and 43 per output. The change sink is
// the P2TR funding address and 43 is the largest any output script gets, so no
// recipient makes this size a spend too small.
const TX_OVERHEAD_VBYTES = 10.5;
const P2TR_INPUT_VBYTES = 57.5;
const OUTPUT_VBYTES = 43;

/** Taproot key material of the funding address. The arkade cosigner re-derives
 * the MuSig2 tweak as taggedHash("TapTweak", tapInternalKey ‖ tapMerkleRoot)
 * from what it reads in the PSBT, so both values must be carried per input —
 * a missing merkle root yields a tweak mismatch and an invalid signature. */
export type BitcoinSendPsbtSource = {
  address: string;
  tapInternalKey: Uint8Array | string;
  tapMerkleRoot: Uint8Array | string;
};

type BuildBitcoinSendPsbtCommon = {
  toAddress: string;
  /** Funding address + its taproot key material. Passed in rather than derived
   * here, so the key material is guaranteed to be the wallet's own for the
   * address the UTXOs actually sit on — a mismatch yields a tweak the co-signer
   * refuses to sign against. */
  from: BitcoinSendPsbtSource;
  /** Change sink in "amount" mode. Default: `from.address`. */
  changeAddress?: string;
};

export type BuildBitcoinSendPsbtParams = BuildBitcoinSendPsbtCommon &
  (
    | {
        mode?: "amount";
        /** Recipient amount in sats, fee on top. For a max-send, the caller computes
         * `balance − estimatedFee` and passes that — same pattern as BitcoinSendScreen. */
        amountSats: number;
      }
    | {
        /** Spend every UTXO to `toAddress` minus fee, no change output. */
        mode: "drain";
        amountSats?: never;
      }
  );

export type BuildBitcoinSendPsbtResult = {
  psbtB64: string;
  /** Recipient amount in sats (= toAddress receives this exact amount). */
  sats: number;
  /** Fee paid by the tx, in sats. */
  fee: bigint;
};

function toBytes(value: Uint8Array | string, field: string): Uint8Array {
  const bytes = typeof value === "string" ? hexToBytes(value) : value;
  if (bytes.length === 0) throw new Error(`buildBitcoinSendPsbt: empty ${field}`);
  return bytes;
}

/** The tweak mismatch this guards against is silent — the network rejects the
 * broadcast, not the build — so fail here instead. */
function assertTapMerkleRoots(tx: btc.Transaction): void {
  for (let i = 0; i < tx.inputsLength; i++) {
    const root = tx.getInput(i).tapMerkleRoot;
    if (!root || root.length !== TAP_MERKLE_ROOT_LEN) {
      throw new Error(
        `buildBitcoinSendPsbt: input ${i} is missing a ${TAP_MERKLE_ROOT_LEN}-byte tapMerkleRoot`,
      );
    }
  }
}

/** The rate every build here pays. Stated once so a caller sizing fee headroom
 * cannot drift from what the build will charge it. */
async function feeRateSatsPerVb(): Promise<number> {
  const feeEstimates = await blockchainService.getFeeEstimates();
  return Number(feeEstimates.fastestFee) || 4;
}

/**
 * What a spend of `inputCount` UTXOs into a recipient output plus change will
 * cost in miner fee, at the rate the build reads.
 *
 * For the caller that has to leave headroom: the amount passed to the builder is
 * what the RECIPIENT receives and the fee comes out of the same wallet on top,
 * so a send of the whole balance has no room to pay it. Sizing on the wallet's
 * full UTXO set makes this a ceiling — that is what a max-send spends, and
 * anything smaller costs less.
 */
export async function estimateBitcoinSendFeeSats(inputCount: number): Promise<number> {
  const inputs = Math.max(1, Math.trunc(Number(inputCount)) || 0);
  const vbytes = TX_OVERHEAD_VBYTES + inputs * P2TR_INPUT_VBYTES + 2 * OUTPUT_VBYTES;
  return Math.ceil((await feeRateSatsPerVb()) * vbytes);
}

export async function buildBitcoinSendPsbt(
  params: BuildBitcoinSendPsbtParams,
): Promise<BuildBitcoinSendPsbtResult> {
  const toAddress = params.toAddress.trim();
  if (!toAddress) throw new Error("buildBitcoinSendPsbt: missing toAddress");

  const fromAddress = params.from.address.trim();
  if (!fromAddress) throw new Error("buildBitcoinSendPsbt: missing from.address");

  const tapInternalKey = toBytes(params.from.tapInternalKey, "from.tapInternalKey");
  const tapMerkleRoot = toBytes(params.from.tapMerkleRoot, "from.tapMerkleRoot");
  if (tapMerkleRoot.length !== TAP_MERKLE_ROOT_LEN) {
    throw new Error(
      `buildBitcoinSendPsbt: from.tapMerkleRoot must be ${TAP_MERKLE_ROOT_LEN} bytes`,
    );
  }

  try {
    await blockchainService.sync(fromAddress);
  } catch {}

  const utxos = await blockchainService.fetchUTXOs(fromAddress);
  if (utxos.length === 0) throw new Error("buildBitcoinSendPsbt: no UTXOs at fromAddress");

  const feeRate = BigInt(await feeRateSatsPerVb());

  const btcUtxos = await Promise.all(
    utxos.map(async (utxo) => {
      const prevTx = await blockchainService.getTransaction(utxo.txid);
      const prevOut = prevTx.vout[utxo.vout];
      const scriptPubKey = hexToBytes(prevOut.scriptpubkey);
      if (scriptPubKey.length !== 34 || scriptPubKey[0] !== 0x51 || scriptPubKey[1] !== 0x20) {
        throw new Error(`buildBitcoinSendPsbt: UTXO ${utxo.txid}:${utxo.vout} is not p2tr`);
      }
      return {
        txid: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { script: scriptPubKey, amount: BigInt(utxo.value) },
        tapInternalKey,
        tapMerkleRoot,
      };
    }),
  );

  const drain = params.mode === "drain";
  const requestedAmount = drain ? 0n : BigInt(params.amountSats);
  if (!drain && requestedAmount <= 0n) {
    throw new Error("buildBitcoinSendPsbt: amountSats must be > 0");
  }

  // Drain is the library's consolidation shape: no outputs, "all" inputs, and the
  // destination as change sink — selectUTXO then sizes the single output itself.
  const selected = btc.selectUTXO(
    btcUtxos,
    drain ? [] : [{ address: toAddress, amount: requestedAmount }],
    drain ? "all" : "default",
    {
      changeAddress: drain ? toAddress : params.changeAddress?.trim() || fromAddress,
      feePerByte: feeRate,
      bip69: true,
      createTx: true,
      // @ts-expect-error @scure/btc-signer@2.0.1 types say number, runtime requires bigint
      dust: DUST_SATS,
    },
  );

  if (!selected?.tx) {
    throw new Error("buildBitcoinSendPsbt: could not build PSBT (insufficient funds for fee)");
  }
  if (drain && selected.tx.outputsLength !== 1) {
    throw new Error("buildBitcoinSendPsbt: drain produced no spendable output (balance is dust)");
  }

  assertTapMerkleRoots(selected.tx);

  const psbtB64 = bytesToBase64(selected.tx.toPSBT());
  const fee = selected.fee ?? 0n;
  const sats = drain ? (selected.tx.getOutput(0).amount ?? 0n) : requestedAmount;

  return { psbtB64, sats: Number(sats), fee };
}
