import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));
vi.mock("./logging", () => ({
  emitTrace: vi.fn(),
  logArkadeWalletSignTrace: vi.fn(),
}));
vi.mock("./walletCache", () => ({
  getCachedArkadeIdentity: vi.fn(() => null),
}));
// Pulls `@arkade-os/sdk`, which vitest cannot transform. Only the storage key
// prefix is used from the backup service.
vi.mock("../ArkadeRecoveryBackupService", () => ({
  scopeArkadeV4StorageKey: (key: string) => `@arkade-v4:${key}`,
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  type ArkadeLightningSendRecord,
  deleteArkadeLightningSend,
  listArkadeLightningSends,
  recordArkadeLightningSendFunding,
  saveArkadeLightningSend,
  updateArkadeLightningSend,
} from "./lightningSendStore";

const OWNER = `02${"ab".repeat(32)}`;
const OTHER_OWNER = `03${"cd".repeat(32)}`;

function buildRecord(over: Partial<ArkadeLightningSendRecord> = {}): ArkadeLightningSendRecord {
  return {
    rfqId: "rfq-1",
    txId: "swapkit-order-1",
    opId: "arkade.pay-1",
    paymentHash: "aa".repeat(32),
    refundLocktime: 1_800_000_000,
    lockupAddress: "ark1lockup",
    refundAddress: "ark1mine",
    fundAmountSats: 12_345,
    invoiceSats: 12_000,
    senderDescriptor: "tr(0202020202)",
    senderPublicKey: "cd".repeat(32),
    createdAtMs: 1_700_000_000_000,
    ...over,
  };
}

beforeEach(() => {
  storage.clear();
});

describe("lightningSendStore", () => {
  it("survives a round trip through storage", async () => {
    const record = buildRecord();
    await saveArkadeLightningSend(OWNER, record);

    expect(await listArkadeLightningSends(OWNER)).toEqual([record]);
  });

  it("keeps the handles a restart needs", async () => {
    await saveArkadeLightningSend(OWNER, buildRecord());
    const [restored] = await listArkadeLightningSends(OWNER);

    // Without these four a funded swap cannot be looked up, unwound, or signed
    // for: everything else on the record is display.
    expect(restored.rfqId).toBe("rfq-1");
    expect(restored.txId).toBe("swapkit-order-1");
    expect(restored.refundLocktime).toBe(1_800_000_000);
    expect(restored.senderDescriptor).toBe("tr(0202020202)");
  });

  it("keeps one record per rfqId and scopes records to their owner", async () => {
    await saveArkadeLightningSend(OWNER, buildRecord({ fundAmountSats: 1 }));
    await saveArkadeLightningSend(OWNER, buildRecord({ fundAmountSats: 2 }));
    await saveArkadeLightningSend(OWNER, buildRecord({ rfqId: "rfq-2" }));
    await saveArkadeLightningSend(OTHER_OWNER, buildRecord({ rfqId: "rfq-3" }));

    const mine = await listArkadeLightningSends(OWNER);
    expect(mine.map((record) => record.rfqId).sort()).toEqual(["rfq-1", "rfq-2"]);
    expect(mine.find((record) => record.rfqId === "rfq-1")?.fundAmountSats).toBe(2);
    expect((await listArkadeLightningSends(OTHER_OWNER)).map((record) => record.rfqId)).toEqual([
      "rfq-3",
    ]);
  });

  it("records the funding txid without losing the rest of the record", async () => {
    const record = buildRecord();
    await saveArkadeLightningSend(OWNER, record);
    await updateArkadeLightningSend(OWNER, record.rfqId, { fundingTxid: "txid-1" });

    expect(await listArkadeLightningSends(OWNER)).toEqual([{ ...record, fundingTxid: "txid-1" }]);
  });

  it("drops a settled swap and leaves the others alone", async () => {
    await saveArkadeLightningSend(OWNER, buildRecord());
    await saveArkadeLightningSend(OWNER, buildRecord({ rfqId: "rfq-2" }));

    await deleteArkadeLightningSend(OWNER, "rfq-1");

    expect((await listArkadeLightningSends(OWNER)).map((record) => record.rfqId)).toEqual([
      "rfq-2",
    ]);
  });

  it("reports no pending sends when storage holds nothing", async () => {
    expect(await listArkadeLightningSends(OWNER)).toEqual([]);
  });

  // The sats have already left the wallet when this runs. A throw here would
  // reach the send's failure path, which reverts the outgoing hold, clears the
  // pending markers and tells the user a completed payment failed.
  it("never throws when the post-submit txid write fails", async () => {
    const record = buildRecord();
    await saveArkadeLightningSend(OWNER, record);
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error("quota exceeded"));

    await expect(
      recordArkadeLightningSendFunding(OWNER, record.rfqId, "txid-1"),
    ).resolves.toBeUndefined();

    // The primary record still has no txid, but the independent outbox already
    // does BEFORE any wake-up read: this is the restart-safe handoff the old
    // module-local Map could not provide.
    const outboxEntry = Array.from(storage.entries()).find(([key]) =>
      key.includes("arkade-intents-funding-outbox-v1"),
    );
    expect(outboxEntry).toBeDefined();
    expect(JSON.parse(outboxEntry?.[1] ?? "{}")).toEqual({ "rfq-1": "txid-1" });

    // The first wake-up read overlays that durable outbox onto the pre-funding
    // record, exposes the txid to the server poller, and folds it back into the
    // primary store now that storage has recovered. Simulate a full module/
    // process reload: the new instance has an empty in-memory fallback and must
    // recover exclusively from AsyncStorage.
    vi.resetModules();
    const restartedStore = await import("./lightningSendStore");
    expect(await restartedStore.listArkadeLightningSends(OWNER)).toEqual([
      { ...record, fundingTxid: "txid-1" },
    ]);
    expect(
      Array.from(storage.values()).some((value) => value.includes('"fundingTxid":"txid-1"')),
    ).toBe(true);
  });

  it("fails closed after restart when the durable funding outbox cannot be read", async () => {
    const record = buildRecord();
    await saveArkadeLightningSend(OWNER, record);
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error("primary write failed"));
    await recordArkadeLightningSendFunding(OWNER, record.rfqId, "txid-1");

    const outboxEntry = Array.from(storage.entries()).find(([key]) =>
      key.includes("arkade-intents-funding-outbox-v1"),
    );
    expect(outboxEntry).toBeDefined();

    // New module = no volatile map. If its only durable txid cannot be read,
    // list must reject so the wake-up cycle performs no bare terminal poll and
    // cannot delete the refund record/outbox. The next wake retries.
    vi.resetModules();
    const restartedStore = await import("./lightningSendStore");
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error("outbox unavailable"));
    await expect(restartedStore.listArkadeLightningSends(OWNER)).rejects.toThrow(
      /outbox unavailable/,
    );

    expect(storage.get(outboxEntry?.[0] ?? "")).toBe(outboxEntry?.[1]);
    const primaryEntry = Array.from(storage.entries()).find(
      ([key]) => !key.includes("arkade-intents-funding-outbox-v1"),
    );
    expect(primaryEntry).toBeDefined();
    expect(JSON.parse(primaryEntry?.[1] ?? "[]")).toEqual([record]);
  });

  // A read that failed is not an empty store. Every mutation replaces the whole
  // array, so a tolerant read would write back a list missing every other
  // funded send — and with them the RFQ and refund-key descriptor those sends
  // need to be resumed and signed.
  it("refuses a save when the store cannot be read, leaving records untouched", async () => {
    const existing = buildRecord({ rfqId: "rfq-existing" });
    await saveArkadeLightningSend(OWNER, existing);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(saveArkadeLightningSend(OWNER, buildRecord({ rfqId: "rfq-new" }))).rejects.toThrow(
      /storage unavailable/,
    );

    expect(await listArkadeLightningSends(OWNER)).toEqual([existing]);
  });

  it("refuses an update when the store cannot be read", async () => {
    const existing = buildRecord({ rfqId: "rfq-existing" });
    await saveArkadeLightningSend(OWNER, existing);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      updateArkadeLightningSend(OWNER, existing.rfqId, { fundingTxid: "txid-1" }),
    ).rejects.toThrow(/storage unavailable/);

    expect(await listArkadeLightningSends(OWNER)).toEqual([existing]);
  });

  it("refuses a delete when the store cannot be read", async () => {
    const first = buildRecord({ rfqId: "rfq-1" });
    const second = buildRecord({ rfqId: "rfq-2" });
    await saveArkadeLightningSend(OWNER, first);
    await saveArkadeLightningSend(OWNER, second);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(deleteArkadeLightningSend(OWNER, first.rfqId)).rejects.toThrow(
      /storage unavailable/,
    );

    expect(await listArkadeLightningSends(OWNER)).toEqual([first, second]);
  });

  // The post-submit annotation is the one caller that must never throw, so it
  // swallows the same failure but retains the txid for the wake-up poller and
  // retries persistence when the store can be read again.
  it("retains and retries the funding txid after a post-submit read failure", async () => {
    const record = buildRecord();
    await saveArkadeLightningSend(OWNER, record);
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(
      recordArkadeLightningSendFunding(OWNER, record.rfqId, "txid-1"),
    ).resolves.toBeUndefined();

    expect(await listArkadeLightningSends(OWNER)).toEqual([{ ...record, fundingTxid: "txid-1" }]);
    expect(
      Array.from(storage.values()).some((value) => value.includes('"fundingTxid":"txid-1"')),
    ).toBe(true);
  });

  it("keeps writing after a failed write", async () => {
    const record = buildRecord();
    await saveArkadeLightningSend(OWNER, record);
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error("quota exceeded"));
    await recordArkadeLightningSendFunding(OWNER, record.rfqId, "txid-1");

    await recordArkadeLightningSendFunding(OWNER, record.rfqId, "txid-2");

    expect(await listArkadeLightningSends(OWNER)).toEqual([{ ...record, fundingTxid: "txid-2" }]);
  });
});
