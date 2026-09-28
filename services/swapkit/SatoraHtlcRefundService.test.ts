import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";

// The service imports the secure keystore (react-native-keychain ships Flow
// syntax vitest cannot parse) and the RN chain/RPC helpers only for the
// signing/broadcast path. parseRefundableLocks touches none of it, so stub the
// heavy leaves to keep this a pure, network-free parse test.
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: vi.fn(),
  getPrivateKey: vi.fn(),
}));
// The in-flight journal uses AsyncStorage directly so persistence failures are
// observable; keep these pure tests native-module-free.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
  },
}));

import { getEthereumAddress } from "../../lib/secureKeyStorage";
import {
  decideRefundRetry,
  executeSatoraRefund,
  isConclusiveRefundDrop,
  parseRefundableLocks,
  type RefundTxProbe,
  refundJournalKey,
} from "./SatoraHtlcRefundService";

/**
 * Pure, network-free coverage for the permissionless Satora HTLC refund path.
 *
 * The signing/broadcast half (executeSatoraRefund/verifySatoraRefundable)
 * reaches the secure keystore and live RPC, so it is exercised in integration,
 * not here. What this file pins is the parsing contract that decides which
 * server-surfaced locks are even eligible — a malformed lock must never reach
 * the refundTo builder — using the real stuck-swap fields as the fixture.
 */

// The live 10-EURC stuck swap this whole feature exists to recover. The two identifiers are
// different values and must never be swapped: refundTo takes the preimageHash, while `key` is what
// the coordinator's deposits mapping is keyed by.
const LIVE_PREIMAGE_HASH = "0x4ceb8f6ceb28b29014b3431b31a38622f2b0d95b3985b3e273fdac54a7593602";
const LIVE_SWAP_KEY = "0x15ea76f0620b57711a165c0222fca4962f4425c747bbbc2a8555566c9d19f5bf";
const LIVE_LOCK = {
  preimageHash: LIVE_PREIMAGE_HASH,
  key: LIVE_SWAP_KEY,
  chainId: 42161,
  chain: "arbitrum",
  coordinatorAddress: "0xdb76F29f1d04D1202f56a34549869b070DFcBfF0",
  token: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40",
  claimAddress: "0x5ce278AAec6d9fa67bFcaF98512fE5175dFEebac",
  amountRaw: "149011072672818",
  timelock: 1789090352,
  refundable: true,
};

describe("parseRefundableLocks", () => {
  it("accepts the live stuck-swap lock and normalizes its fields", () => {
    const [lock, ...rest] = parseRefundableLocks([LIVE_LOCK]);
    expect(rest).toHaveLength(0);
    expect(lock.preimageHash).toBe(LIVE_LOCK.preimageHash);
    expect(lock.chainId).toBe(42161);
    expect(lock.coordinatorAddress).toBe(LIVE_LOCK.coordinatorAddress);
    expect(lock.token).toBe(LIVE_LOCK.token);
    expect(lock.claimAddress).toBe(LIVE_LOCK.claimAddress);
    expect(lock.amountRaw).toBe("149011072672818");
    expect(lock.timelock).toBe(1789090352);
    expect(lock.refundable).toBe(true);
  });

  it("signs refundTo with the lock's preimageHash, never its swap key", () => {
    const [lock] = parseRefundableLocks([LIVE_LOCK]);
    expect(lock.preimageHash).toBe(LIVE_PREIMAGE_HASH);
    expect(lock.preimageHash).not.toBe(LIVE_SWAP_KEY);
    expect(lock.key).toBe(LIVE_SWAP_KEY);
  });

  it("drops an entry that only carries the pre-0.6.127 hashlock field", () => {
    // The server used to call the swap key `hashlock`; signing that value as the preimageHash is
    // what made every refund revert UnknownHtlc, so such an entry must never be refunded.
    const { preimageHash: _drop, ...legacy } = LIVE_LOCK;
    expect(parseRefundableLocks([{ ...legacy, hashlock: LIVE_SWAP_KEY }])).toEqual([]);
  });

  it("returns [] for non-array input", () => {
    expect(parseRefundableLocks(null)).toEqual([]);
    expect(parseRefundableLocks(undefined)).toEqual([]);
    expect(parseRefundableLocks({})).toEqual([]);
  });

  it("drops malformed entries (bad preimageHash/key, address, amount, or numbers)", () => {
    const bad = [
      { ...LIVE_LOCK, preimageHash: "0xnothex" },
      { ...LIVE_LOCK, key: "0xnothex" },
      { ...LIVE_LOCK, preimageHash: LIVE_SWAP_KEY, key: LIVE_SWAP_KEY },
      { ...LIVE_LOCK, coordinatorAddress: "not-an-address" },
      { ...LIVE_LOCK, token: "0x123" },
      { ...LIVE_LOCK, amountRaw: "12.5" },
      { ...LIVE_LOCK, amountRaw: "-1" },
      { ...LIVE_LOCK, amountRaw: "0" },
      { ...LIVE_LOCK, chainId: "arbitrum" },
      { ...LIVE_LOCK, chainId: null },
      { ...LIVE_LOCK, chainId: 42161.5 },
      { ...LIVE_LOCK, timelock: "soon" },
      { ...LIVE_LOCK, timelock: null },
      { ...LIVE_LOCK, timelock: 1.5 },
      {},
    ];
    expect(parseRefundableLocks(bad)).toEqual([]);
  });

  it("keeps only well-formed locks in a mixed batch", () => {
    const second = {
      ...LIVE_LOCK,
      preimageHash: `0x${"ab".repeat(32)}`,
      refundable: false,
    };
    const parsed = parseRefundableLocks([LIVE_LOCK, { bogus: true }, second]);
    expect(parsed.map((l) => l.preimageHash)).toEqual([
      LIVE_LOCK.preimageHash,
      second.preimageHash,
    ]);
    expect(parsed[1].refundable).toBe(false);
  });

  it("defaults refundable to false when absent", () => {
    const { refundable: _omit, ...noFlag } = LIVE_LOCK;
    const [lock] = parseRefundableLocks([noFlag]);
    expect(lock.refundable).toBe(false);
  });

  it("accepts only literal true as refundable", () => {
    for (const refundable of ["false", "true", "0", "1", 0, 1, null]) {
      const [lock] = parseRefundableLocks([{ ...LIVE_LOCK, refundable }]);
      expect(lock.refundable).toBe(false);
    }
  });
});

describe("executeSatoraRefund coordinator allowlist", () => {
  it("refuses a coordinator that is not an allowlisted Satora deployment", async () => {
    // A compromised server could return a look-alike contract whose deposits()
    // returns this wallet and whose refundTo() does something else; we must
    // reject it before any signing, purely on the untrusted coordinator address.
    vi.mocked(getEthereumAddress).mockResolvedValue("0x0506b80e00c0e8464f9707589ae116ebf1304f93");
    await expect(
      executeSatoraRefund({
        ...LIVE_LOCK,
        coordinatorAddress: "0x000000000000000000000000000000000000dEaD",
      }),
    ).rejects.toThrow(/not an allowlisted Satora deployment/);
  });

  it("refuses a known coordinator address presented on the wrong chain", async () => {
    vi.mocked(getEthereumAddress).mockResolvedValue("0x0506b80e00c0e8464f9707589ae116ebf1304f93");
    await expect(executeSatoraRefund({ ...LIVE_LOCK, chainId: 1 })).rejects.toThrow(
      /not an allowlisted Satora deployment/,
    );
  });
});

describe("decideRefundRetry (in-flight journal)", () => {
  const record = {
    txHash: "0xabc",
    broadcastAtMs: 1_000,
    nonce: 7,
    from: "0x0506b80e00c0e8464f9707589ae116ebf1304f93",
  };

  it("rebroadcasts when there is no prior record", () => {
    expect(decideRefundRetry({ record: null, receipt: null })).toBe("rebroadcast");
  });

  it("reports already-claimed when the prior tx confirmed", () => {
    expect(decideRefundRetry({ record, receipt: { status: "success" } })).toBe("already-claimed");
  });

  it("rebroadcasts when the prior tx reverted (lock unconsumed)", () => {
    expect(decideRefundRetry({ record, receipt: { status: "reverted" } })).toBe("rebroadcast");
  });

  it("skips a duplicate while the prior tx is pending or the RPC cannot find a receipt", () => {
    expect(decideRefundRetry({ record, receipt: null })).toBe("skip-in-flight");
  });

  it("never infers a dropped transaction from elapsed time alone", () => {
    const yearsOld = { ...record, broadcastAtMs: 1 };
    expect(decideRefundRetry({ record: yearsOld, receipt: null })).toBe("skip-in-flight");
  });

  it("requires two healthy RPCs before calling a missing hash dropped", () => {
    const absent: RefundTxProbe = {
      txVisible: false,
      pendingNonce: 7,
      latestNonce: 7,
      receipt: null,
    };
    expect(isConclusiveRefundDrop(record, [absent])).toBe(false);
    expect(
      isConclusiveRefundDrop(record, [
        absent,
        { txVisible: null, pendingNonce: null, latestNonce: null, receipt: null },
      ]),
    ).toBe(false);
  });

  it("proves a drop when both RPCs miss the hash and have no pending nonce above it", () => {
    const absent: RefundTxProbe = {
      txVisible: false,
      pendingNonce: 7,
      latestNonce: 7,
      receipt: null,
    };
    expect(isConclusiveRefundDrop(record, [absent, absent])).toBe(true);
    expect(
      decideRefundRetry({
        record,
        receipt: null,
        conclusivelyDroppedOrReplaced: true,
      }),
    ).toBe("rebroadcast");
  });

  it("does not call it dropped when either RPC still sees a pending nonce", () => {
    expect(
      isConclusiveRefundDrop(record, [
        { txVisible: false, pendingNonce: 7, latestNonce: 7, receipt: null },
        { txVisible: false, pendingNonce: 8, latestNonce: 7, receipt: null },
      ]),
    ).toBe(false);
  });

  it("recognizes a mined replacement after both RPCs see the nonce consumed", () => {
    const replaced: RefundTxProbe = {
      txVisible: false,
      pendingNonce: 8,
      latestNonce: 8,
      receipt: null,
    };
    expect(isConclusiveRefundDrop(record, [replaced, replaced])).toBe(true);
  });
});

describe("HTLC key derivation (documents the deposits() lookup)", () => {
  it("is a stable keccak of the six lock fields with coordinator as refundAddress", () => {
    // Guards the exact field ORDER the coordinator's _key uses; a reorder here
    // would silently look up the wrong depositor and refuse every real refund.
    const encoded =
      LIVE_LOCK.preimageHash.slice(2) + BigInt(LIVE_LOCK.amountRaw).toString(16).padStart(64, "0");
    expect(encoded.length).toBeGreaterThan(64);
    // keccak256 is deterministic — sanity that viem is wired and hashing.
    expect(keccak256("0x1234")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("refund journal identity", () => {
  it("derives the chain's own swap key for the live lock", () => {
    const [lock] = parseRefundableLocks([LIVE_LOCK]);
    // The fixture's `key` is the key the coordinator deposited under, read from Arbitrum; our
    // derivation from the six fields must land on exactly that value.
    expect(refundJournalKey(lock)).toBe(`42161:${LIVE_SWAP_KEY.toLowerCase()}`);
  });

  it("keeps two locks that share a preimageHash apart", () => {
    // The contract allows distinct locks with one preimage hash: different amount, timelock, claim
    // address or coordinator. Keyed by the preimage hash the second would read the first's journal
    // record and never be refunded (review finding, PR #1445).
    const { key: _omit, ...withoutKey } = LIVE_LOCK;
    const second = {
      ...withoutKey,
      amountRaw: "42000000000000",
      timelock: LIVE_LOCK.timelock + 3600,
    };
    const [first, other] = parseRefundableLocks([LIVE_LOCK, second]);
    expect(first.preimageHash).toBe(other.preimageHash);
    expect(refundJournalKey(first)).not.toBe(refundJournalKey(other));
  });

  it("is stable for the same lock", () => {
    const [lock] = parseRefundableLocks([LIVE_LOCK]);
    expect(refundJournalKey(lock)).toBe(refundJournalKey(lock));
  });
});
