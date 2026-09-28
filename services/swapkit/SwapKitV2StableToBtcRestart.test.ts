// Restart parity for the stable→BTC source approval bound (review finding #1)
// and the rebuild that reproduces it.
//
// An approval-bearing execute_evm_call on the Base source token is rejected by
// the signer when no ceiling is supplied. The live flow bounds it with
// stableSourceExecutors(); if the order is resumed after a restart without a
// persisted executorSpec, rebuildV2ExecutorsForOrder() returns null, the tracker
// installs the DEFAULT unbounded executors, and the still-ready approval action
// can never be signed — the swap strands mid-route.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseUnits } from "viem";

const mocks = vi.hoisted(() => ({
  quoteSwapKitV2: vi.fn(),
  commitSwapKitV2: vi.fn(),
  startSwapKitV2Tracking: vi.fn(),
  emitV2SwapRefresh: vi.fn(),
  persistV2CommitIntent: vi.fn(),
  resolveV2CommitIntent: vi.fn(),
  hydrate: vi.fn(),
  listUnresolvedV2CommitIntents: vi.fn(() => []),
  removeOrder: vi.fn(),
  makeStandardV2Executors: vi.fn((options?: unknown) => ({ __options: options })),
  emit: vi.fn(),
}));

vi.mock("./SwapKitV2Service", () => ({
  SWAPKIT_V2_ACTION_KINDS: ["sign_typed_data", "send_asset", "execute_evm_call"],
  quoteSwapKitV2: mocks.quoteSwapKitV2,
  commitSwapKitV2: mocks.commitSwapKitV2,
  asSwapKitV2OrderId: (id: string) => id,
}));
vi.mock("./SwapKitV2PendingTracker", () => ({
  startSwapKitV2Tracking: mocks.startSwapKitV2Tracking,
  emitV2SwapRefresh: mocks.emitV2SwapRefresh,
}));
vi.mock("./SwapKitV2OrderStore", () => ({
  SwapKitV2OrderStore: { hydrate: mocks.hydrate, remove: mocks.removeOrder },
  listUnresolvedV2CommitIntents: mocks.listUnresolvedV2CommitIntents,
  persistV2CommitIntent: mocks.persistV2CommitIntent,
  resolveV2CommitIntent: mocks.resolveV2CommitIntent,
}));
vi.mock("./SwapKitV2Executors", () => ({
  makeStandardV2Executors: mocks.makeStandardV2Executors,
  // The EVM-source capability list: the forbidden Arkade-funding kinds removed.
  SWAPKIT_V2_EVM_SOURCE_CAPABILITIES: [
    "sign_typed_data",
    "execute_evm_call",
    "arkade_claim",
    "htlc_material",
    "arkade_refund_material",
    "arkade_intents_refund",
  ],
  // Mirrors the real helper: the point of this test is that the live call and
  // the resume rebuild go through the SAME derivation, so the mock keeps the
  // real ceiling math (a pure viem function) and only stubs executor creation.
  standardEvmLoopOptions: (chainId: number, deposit: number, decimals: number) => ({
    executors: mocks.makeStandardV2Executors({
      allowedEvmChains: [chainId],
      maxApprovalUnits: parseUnits((deposit * 1.02).toFixed(decimals), decimals),
    }),
    allowedEvmChains: [chainId],
  }),
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({
  getSwapKitV2RecoveryKey: vi.fn(async () => "r".repeat(64)),
}));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: mocks.emit } }));
vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));
// SwapKitV2ResumeExecutors pulls approvalCeiling from the direct-EVM service,
// whose balance-read import drags native modules into the node test env.
vi.mock("./SwapKitDirectEvmSwapService", () => ({
  readDirectSwapBalance: vi.fn(),
  DIRECT_SWAP_SETTLED_EVENT: "swap:directSettled",
}));
vi.mock("./SwapKitV2BtcToStableService", () => ({
  buildBtcToStableExecutorsFromSpec: vi.fn(() => ({})),
}));
vi.mock("../bitcoin/ownDestinations", () => ({
  ownBitcoinDestinations: async (): Promise<{ arkade: null; onchain: null }> => ({
    arkade: null,
    onchain: null,
  }),
}));
vi.mock("./SwapKitV2SweepService", () => ({ makeSweepV2ExecutorsFor: vi.fn(() => null) }));

import { executeV2StableToBtc } from "./SwapKitV2StableToBtcService";
import { rebuildV2ExecutorsForOrder } from "./SwapKitV2ResumeExecutors";
import type { SwapKitV2StoredOrder } from "./SwapKitV2OrderStore";

const EOA = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commitSwapKitV2.mockResolvedValue({ orderId: "ord_1", status: "COMMITTED", actions: [] });
});

describe("stable→BTC restart parity", () => {
  it("persists the source approval envelope on the commit intent", async () => {
    await executeV2StableToBtc({
      fromAsset: "EURC_BASE",
      to: "BTC",
      amount: 12,
      side: "deposit",
      owner: EOA,
      settleTarget: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      optionId: "opt_1",
      quotedDeposit: 12,
      quotedReceive: 0.0003,
    });

    const intent = mocks.persistV2CommitIntent.mock.calls[0][0];
    expect(intent.flow).toBe("stable_to_btc");
    // Exactly what stableSourceExecutors() needs to reproduce its ceiling.
    expect(intent.executorSpec).toMatchObject({
      flow: "standard_evm",
      chainId: 8453,
      tokenDecimals: 6,
      acceptedDeposit: "12",
    });
  });

  it("rebuilds the SAME bounded ceiling the live flow used", async () => {
    await executeV2StableToBtc({
      fromAsset: "EURC_BASE",
      to: "BTC",
      amount: 12,
      side: "deposit",
      owner: EOA,
      settleTarget: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      optionId: "opt_1",
      quotedDeposit: 12,
      quotedReceive: 0.0003,
    });
    const liveOptions = mocks.makeStandardV2Executors.mock.calls.at(-1)?.[0] as {
      maxApprovalUnits: bigint;
      allowedEvmChains: number[];
    };
    const spec = mocks.persistV2CommitIntent.mock.calls[0][0].executorSpec;

    mocks.makeStandardV2Executors.mockClear();
    const rebuilt = await rebuildV2ExecutorsForOrder({
      orderId: "ord_1",
      owner: EOA,
      flow: "stable_to_btc",
      executorSpec: spec,
    } as unknown as SwapKitV2StoredOrder);

    expect(rebuilt).not.toBeNull();
    const rebuiltOptions = mocks.makeStandardV2Executors.mock.calls.at(-1)?.[0] as {
      maxApprovalUnits: bigint;
      allowedEvmChains: number[];
    };
    expect(rebuiltOptions.maxApprovalUnits).toBe(liveOptions.maxApprovalUnits);
    expect(rebuiltOptions.maxApprovalUnits).toBe(parseUnits("12.24", 6));
    expect(rebuiltOptions.allowedEvmChains).toEqual([8453]);
    expect(rebuilt?.allowedEvmChains).toEqual([8453]);
  });

  it("without a persisted spec the resume would install unbounded executors", async () => {
    const rebuilt = await rebuildV2ExecutorsForOrder({
      orderId: "ord_1",
      owner: EOA,
      flow: "stable_to_btc",
    } as unknown as SwapKitV2StoredOrder);
    expect(rebuilt).toBeNull();
  });
});
