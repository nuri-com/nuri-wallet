import { describe, expect, it, vi } from "vitest";

// The resume builder pulls in flow services whose native imports vitest cannot
// load; stub those seams. The standard_evm branch under test calls the real
// standardEvmLoopOptions.
vi.mock("./SwapKitV2BtcToStableService", () => ({ buildBtcToStableExecutorsFromSpec: vi.fn() }));
vi.mock("./SwapKitV2SweepService", () => ({ makeSweepV2ExecutorsFor: vi.fn() }));
vi.mock("../arkade/ArkadeLightningSendService", () => ({ payArkadeLightningInvoice: vi.fn() }));
vi.mock("../arkade/ArkadeSendService", () => ({
  sendArkadeToArk: vi.fn(),
  fundArkadeIntentsOutpoint: vi.fn(),
}));
vi.mock("../arkade/ArkadeAddressService", () => ({ getArkadeReceiveAddress: vi.fn() }));
vi.mock("./SwapKitHtlcKeyService", () => ({ deriveSwapKitHtlcMaterial: vi.fn() }));
vi.mock("./SwapKitHtlcSecretService", () => ({ materializeSwapKitHtlcPreimage: vi.fn() }));
vi.mock("./SwapKitArkadeVhtlcService", () => ({ claimSwapKitArkadeVhtlc: vi.fn() }));
vi.mock("./SwapKitEvmSigner", () => ({ signAndBroadcastSwapKitEvmTx: vi.fn() }));
vi.mock("./SwapKitHtlcActionService", () => ({ executeSwapKitHtlcAction: vi.fn() }));
vi.mock("./SwapKitArkadeIntentsActionService", () => ({
  parseLockupParams: vi.fn(),
  refundArkadeIntentsLockup: vi.fn(),
}));
vi.mock("../../lib/secureKeyStorage", () => ({ getEthereumAddress: vi.fn() }));
vi.mock("./SwapKitV2OrderStore", () => ({ SwapKitV2OrderStore: { get: vi.fn() } }));

import { rebuildV2ExecutorsForOrder } from "./SwapKitV2ResumeExecutors";

const order = (spec: Record<string, unknown>, from = "USDC_BASE") =>
  ({
    orderId: "ord_1",
    from,
    executorSpec: { flow: "standard_evm", chainId: 8453, tokenDecimals: 6, ...spec },
  }) as never;

// #2 — the resume path rebuilt standard_evm with the UNIVERSAL set, restoring
// Arkade funding authority the live path had removed. It now calls the same
// builder, so a restart cannot widen what an EVM-source order may do.
describe("standard_evm resume", () => {
  it("rebuilds WITHOUT the Arkade/Lightning funding executors", async () => {
    const rebuilt = await rebuildV2ExecutorsForOrder(order({ acceptedDeposit: "25" }));
    expect(rebuilt?.executors.pay_lightning_invoice).toBeUndefined();
    expect(rebuilt?.executors.arkade_send).toBeUndefined();
    expect(rebuilt?.executors.arkade_intents_fund).toBeUndefined();
    expect(rebuilt?.executors.execute_evm_call).toBeTypeOf("function");
    expect(rebuilt?.allowedEvmChains).toEqual([8453]);
  });

  it("fails closed on an unreadable accepted deposit instead of falling back to the default set", async () => {
    await expect(rebuildV2ExecutorsForOrder(order({ acceptedDeposit: "" }))).rejects.toThrow(
      /no readable accepted deposit/,
    );
  });

  it("fails closed when the source token cannot be resolved", async () => {
    await expect(
      rebuildV2ExecutorsForOrder(order({ acceptedDeposit: "25" }, "UNKNOWN_ASSET")),
    ).rejects.toThrow();
  });
});
