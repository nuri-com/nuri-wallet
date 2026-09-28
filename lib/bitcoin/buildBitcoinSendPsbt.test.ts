import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  fetchUTXOs: vi.fn(),
  getFeeEstimates: vi.fn(),
  getTransaction: vi.fn(),
  stripTapMerkleRoot: false,
}));

vi.mock("../../services/bitcoin/BlockchainService", () => ({
  blockchainService: {
    sync: mocks.sync,
    fetchUTXOs: mocks.fetchUTXOs,
    getFeeEstimates: mocks.getFeeEstimates,
    getTransaction: mocks.getTransaction,
  },
}));

// Drops the merkle root on its way into the library, which is the only way to
// reach the builder's own guard from outside.
vi.mock("@scure/btc-signer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scure/btc-signer")>();
  return {
    ...actual,
    selectUTXO: (
      inputs: Parameters<typeof actual.selectUTXO>[0],
      ...rest: [
        Parameters<typeof actual.selectUTXO>[1],
        Parameters<typeof actual.selectUTXO>[2],
        Parameters<typeof actual.selectUTXO>[3],
      ]
    ) =>
      actual.selectUTXO(
        mocks.stripTapMerkleRoot
          ? inputs.map(({ tapMerkleRoot: _dropped, ...input }) => input)
          : inputs,
        ...rest,
      ),
  };
});

import * as btc from "@scure/btc-signer";
import { base64ToBytes, bytesToHex } from "../bytes";
import { buildBitcoinSendPsbt } from "./buildBitcoinSendPsbt";

const FROM = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(1)));
const TO = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(2)));
const OTHER = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(3)));

const TAP_INTERNAL_KEY = btc.utils.pubSchnorr(new Uint8Array(32).fill(4));
const TAP_MERKLE_ROOT = new Uint8Array(32).fill(7);

const UTXOS = [
  { txid: "aa".repeat(32), vout: 0, value: 100_000 },
  { txid: "bb".repeat(32), vout: 1, value: 60_000 },
];
const TOTAL = BigInt(UTXOS[0].value + UTXOS[1].value);

const from = {
  address: FROM.address as string,
  tapInternalKey: TAP_INTERNAL_KEY,
  tapMerkleRoot: TAP_MERKLE_ROOT,
};

function addressOfOutput(tx: btc.Transaction, index: number): string {
  const script = tx.getOutput(index).script;
  if (!script) throw new Error("output without script");
  return btc.Address().encode(btc.OutScript.decode(script));
}

function parse(psbtB64: string) {
  return btc.Transaction.fromPSBT(base64ToBytes(psbtB64));
}

describe("buildBitcoinSendPsbt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stripTapMerkleRoot = false;
    mocks.sync.mockResolvedValue(null);
    mocks.fetchUTXOs.mockResolvedValue(UTXOS);
    mocks.getFeeEstimates.mockResolvedValue({ fastestFee: 2 });
    mocks.getTransaction.mockImplementation(async (txid: string) => {
      const utxo = UTXOS.find((u) => u.txid === txid);
      if (!utxo) throw new Error(`unexpected txid ${txid}`);
      const vout = Array.from({ length: utxo.vout + 1 }, () => ({
        scriptpubkey: bytesToHex(FROM.script),
      }));
      return { vout };
    });
  });

  it("sets tapMerkleRoot and tapInternalKey on every input", async () => {
    const { psbtB64 } = await buildBitcoinSendPsbt({
      toAddress: TO.address as string,
      from,
      amountSats: 50_000,
    });

    const tx = parse(psbtB64);
    expect(tx.inputsLength).toBeGreaterThan(0);
    for (let i = 0; i < tx.inputsLength; i++) {
      expect(tx.getInput(i).tapMerkleRoot).toEqual(TAP_MERKLE_ROOT);
      expect(tx.getInput(i).tapInternalKey).toEqual(TAP_INTERNAL_KEY);
    }
  });

  it("throws when an input reaches the PSBT without a tapMerkleRoot", async () => {
    mocks.stripTapMerkleRoot = true;

    await expect(
      buildBitcoinSendPsbt({ toAddress: TO.address as string, from, amountSats: 50_000 }),
    ).rejects.toThrow(/input 0 is missing a 32-byte tapMerkleRoot/);
  });

  it("rejects a from.tapMerkleRoot that is not 32 bytes", async () => {
    await expect(
      buildBitcoinSendPsbt({
        toAddress: TO.address as string,
        from: { ...from, tapMerkleRoot: new Uint8Array(31) },
        amountSats: 50_000,
      }),
    ).rejects.toThrow(/from\.tapMerkleRoot must be 32 bytes/);
  });

  it("amount mode pays the recipient exactly and returns change to from.address", async () => {
    const result = await buildBitcoinSendPsbt({
      toAddress: TO.address as string,
      from,
      amountSats: 50_000,
    });

    expect(result.sats).toBe(50_000);
    const tx = parse(result.psbtB64);
    expect(tx.outputsLength).toBe(2);

    let inputTotal = 0n;
    for (let i = 0; i < tx.inputsLength; i++) {
      inputTotal += tx.getInput(i).witnessUtxo?.amount ?? 0n;
    }
    const byAddress = new Map<string, bigint>();
    for (let i = 0; i < tx.outputsLength; i++) {
      byAddress.set(addressOfOutput(tx, i), tx.getOutput(i).amount ?? 0n);
    }
    expect(byAddress.get(TO.address as string)).toBe(50_000n);
    expect(byAddress.get(FROM.address as string)).toBe(inputTotal - 50_000n - result.fee);
    expect(result.fee).toBeGreaterThan(0n);
  });

  it("amount mode sends change to an explicit changeAddress", async () => {
    const { psbtB64 } = await buildBitcoinSendPsbt({
      toAddress: TO.address as string,
      from,
      amountSats: 50_000,
      changeAddress: OTHER.address as string,
    });

    const tx = parse(psbtB64);
    const addresses = Array.from({ length: tx.outputsLength }, (_, i) => addressOfOutput(tx, i));
    expect(addresses).toContain(OTHER.address as string);
    expect(addresses).not.toContain(FROM.address as string);
  });

  it("drain mode spends every UTXO into a single output with no change", async () => {
    const result = await buildBitcoinSendPsbt({
      toAddress: TO.address as string,
      from,
      mode: "drain",
    });

    const tx = parse(result.psbtB64);
    expect(tx.inputsLength).toBe(UTXOS.length);
    expect(tx.outputsLength).toBe(1);
    expect(addressOfOutput(tx, 0)).toBe(TO.address as string);
    expect(tx.getOutput(0).amount).toBe(TOTAL - result.fee);
    expect(result.sats).toBe(Number(TOTAL - result.fee));

    for (let i = 0; i < tx.inputsLength; i++) {
      expect(tx.getInput(i).tapMerkleRoot).toEqual(TAP_MERKLE_ROOT);
    }
  });
});
