import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getNostrPrivateKey: vi.fn(),
  publish: vi.fn(),
  fetchNewest: vi.fn(),
  ensureDmRelayListPublished: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({
  getNostrPrivateKey: mocks.getNostrPrivateKey,
}));
vi.mock("../../lib/nostr/relayPublish", () => ({
  publishNostrEventToRelays: mocks.publish,
  fetchNewestNostrEventFromRelays: mocks.fetchNewest,
}));
vi.mock("./NostrDmRelayListService", () => ({
  ensureDmRelayListPublished: mocks.ensureDmRelayListPublished,
}));

import {
  NOSTR_BACKUP_D_TAG_SWAPKIT,
  publishSwapKitRecoverySnapshotToNostr,
  restoreSwapKitRecoverySnapshotFromNostr,
} from "./NostrBackupService";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getNostrPrivateKey.mockImplementation(async () => new Uint8Array(32).fill(3));
  mocks.ensureDmRelayListPublished.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue({ tried: 1, opened: 1, ackedOk: 1 });
});

describe("NostrBackupService SwapKit snapshots", () => {
  it("publishes only encrypted active-swap content", async () => {
    await publishSwapKitRecoverySnapshotToNostr([
      {
        txId: "private-to-relay-only-as-ciphertext",
        settleTarget: "0x1111111111111111111111111111111111111111",
        expectedUsdc: 5,
        minEurc: 4.9,
        usdcBaseline: "123",
        sats: 10_000,
        createdAt: 1,
        attempts: 0,
        recovery: { provider: "satora", keyIndex: 4, actionId: "wa-4" },
      },
    ]);

    const event = mocks.publish.mock.calls[0][1] as { tags: string[][]; content: string };
    expect(mocks.getNostrPrivateKey).toHaveBeenCalled();
    expect(event.tags).toContainEqual(["d", NOSTR_BACKUP_D_TAG_SWAPKIT]);
    expect(event.content).not.toContain("private-to-relay-only-as-ciphertext");
    expect(JSON.parse(event.content)).toMatchObject({
      format: "nuri-swapkit-active-v1",
      encryption: "xchacha20poly1305-hkdf-sha256-nostr-key-v1",
    });
  });

  it("restores the published snapshot losslessly (encrypt/decrypt roundtrip)", async () => {
    const order = {
      kind: "card_topup" as const,
      txId: "sk_roundtrip",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 18.574427,
      minEurc: 16.05244014,
      usdcBaseline: "123",
      sats: 30_000,
      createdAt: 1,
      attempts: 0,
      // Must survive the round-trip: a restored row that loses this refund
      // address falls back to the wallet's current receive address on refund.
      arkadeRefundAddress: "ark1qorigin000000000000000000000000000000",
    };
    await publishSwapKitRecoverySnapshotToNostr([order]);
    const published = mocks.publish.mock.calls[0][1] as { content: string };
    mocks.fetchNewest.mockResolvedValue({ created_at: 1, content: published.content });

    const restored = await restoreSwapKitRecoverySnapshotFromNostr();
    expect(restored).toHaveLength(1);
    expect(restored?.[0]).toMatchObject(order);
    expect(restored?.[0]?.arkadeRefundAddress).toBe(order.arkadeRefundAddress);
  });

  it("carries a funded sweep's deposit hash and approval ceiling through the round-trip", async () => {
    // After local storage is lost this snapshot is the only durable copy: the
    // hash is what re-reports a deposit the server never heard about, and the
    // ceiling is what lets a restored row approve anything at all.
    const order = {
      kind: "discovered" as const,
      txId: "sk_swept",
      settleTarget: "0x1111111111111111111111111111111111111111",
      expectedUsdc: 0,
      usdcBaseline: "0",
      sats: 0,
      createdAt: 1,
      attempts: 0,
      recovery: {
        provider: "sweep",
        status: "PROCESSING",
        chainId: 42161,
        approvalToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        approvalMaxUnits: "11370000",
        depositTo: "0x2222222222222222222222222222222222222222",
        depositAmount: "11.37",
        depositTxHash: "0xdeposit",
      },
    };
    await publishSwapKitRecoverySnapshotToNostr([order]);
    const published = mocks.publish.mock.calls[0][1] as { content: string };
    mocks.fetchNewest.mockResolvedValue({ created_at: 1, content: published.content });

    const restored = await restoreSwapKitRecoverySnapshotFromNostr();
    expect(restored?.[0]?.recovery).toMatchObject(order.recovery);
  });

  it("returns null when nothing decrypts", async () => {
    mocks.fetchNewest.mockResolvedValue(null);
    await expect(restoreSwapKitRecoverySnapshotFromNostr()).resolves.toBeNull();
  });
});
