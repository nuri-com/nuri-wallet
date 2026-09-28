vi.mock("./SwapKitV2OrderStore", () => ({ SwapKitV2OrderStore: { get: vi.fn() } }));
import { SwapKitV2OrderStore } from "./SwapKitV2OrderStore";
import { fundArkadeIntentsOutpoint, sendArkadeToArk } from "../arkade/ArkadeSendService";
import * as lightningFacts from "../../lib/bitcoin/lightning";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The executor module pulls in the whole wallet; stub the heavy seams so the
// keyRef minting/resolution logic runs in isolation.
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: vi.fn().mockResolvedValue("0xAbCd000000000000000000000000000000000001"),
}));
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
// SwapKitV2Executors now statically imports the intents refund core, which
// pulls the Arkade SDK into the parse graph. This suite never exercises the
// refund executors, so stub the service to keep the SDK out.
vi.mock("./SwapKitArkadeIntentsActionService", () => ({
  parseLockupParams: vi.fn(),
  refundArkadeIntentsLockup: vi.fn(),
}));

import { sha256 } from "../../lib/crypto";
import { getEthereumAddress } from "../../lib/secureKeyStorage";
import { getArkadeReceiveAddress } from "../arkade/ArkadeAddressService";
import { payArkadeLightningInvoice } from "../arkade/ArkadeLightningSendService";
import { deriveSwapKitHtlcMaterial } from "./SwapKitHtlcKeyService";
import { materializeSwapKitHtlcPreimage } from "./SwapKitHtlcSecretService";
import { claimSwapKitArkadeVhtlc } from "./SwapKitArkadeVhtlcService";
import { signAndBroadcastSwapKitEvmTx } from "./SwapKitEvmSigner";
import {
  assertOwnerIsWalletEoa,
  executeV2ArkadeClaim,
  executeV2ArkadeIntentsFund,
  executeV2ArkadeSend,
  executeV2HtlcMaterial,
  executeV2PayLightningInvoice,
  standardEvmLoopOptions,
  SWAPKIT_V2_EVM_SOURCE_CAPABILITIES,
  makeV2ExecuteEvmCall,
  makeV2SendAsset,
  makeRecoveryOnlyV2Executors,
  makeStandardV2Executors,
  makeV2SignTypedData,
} from "./SwapKitV2Executors";
import { executeSwapKitHtlcAction } from "./SwapKitHtlcActionService";

const CTX = { orderId: "ord_1" as never, actionId: "act_1" };

// A deterministic fake preimage and its real SHA256, so hash-binding checks
// run against genuine crypto rather than stubbed equality.
const PREIMAGE = new Uint8Array(32).fill(7);
const PREIMAGE_HASH = `0x${Buffer.from(sha256(PREIMAGE)).toString("hex")}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEthereumAddress).mockResolvedValue("0xAbCd000000000000000000000000000000000001");
  // Fresh copy per call: the executor zeroizes the returned bytes, and a
  // shared instance would hand zeros to the next caller.
  vi.mocked(materializeSwapKitHtlcPreimage).mockImplementation(
    async () => new Uint8Array(PREIMAGE),
  );
});

describe("htlc_material mints a wallet-owned opaque keyRef (contract v2.1.0)", () => {
  it("derives via the EXISTING v1 key service and returns public material + walletKeyRef", async () => {
    vi.mocked(deriveSwapKitHtlcMaterial).mockResolvedValue({
      keyIndex: 42,
      publicKey: `0x02${"a".repeat(64)}`,
      userId: `0x03${"b".repeat(64)}`,
      preimageHash: PREIMAGE_HASH,
      evmAddress: "0xabc",
    });
    const result = await executeV2HtlcMaterial({ role: "receiver", scope: "ord_1" }, CTX);
    // Allocation is keyed by the v2 action id — replay-stable, v1 machinery.
    expect(deriveSwapKitHtlcMaterial).toHaveBeenCalledWith("satora", "v2:ord_1:act_1");
    expect(result.walletKeyRef).toBe("nuri-htlc-v1:satora:42");
    expect(result.claimPublicKey).toBe(`02${"a".repeat(64)}`);
    expect(result.refundPublicKey).toBe(`03${"b".repeat(64)}`);
    expect(result.paymentHash).toBe(PREIMAGE_HASH.slice(2));
  });

  it("sender role swaps claim/refund keys and keeps the counterparty's paymentHash", async () => {
    vi.mocked(deriveSwapKitHtlcMaterial).mockResolvedValue({
      keyIndex: 7,
      publicKey: `0x02${"a".repeat(64)}`,
      userId: `0x03${"b".repeat(64)}`,
      preimageHash: PREIMAGE_HASH,
      evmAddress: "0xabc",
    });
    const bound = "c".repeat(64);
    const result = await executeV2HtlcMaterial(
      { role: "sender", scope: "ord_1", paymentHash: bound },
      CTX,
    );
    expect(result.claimPublicKey).toBe(`03${"b".repeat(64)}`);
    expect(result.refundPublicKey).toBe(`02${"a".repeat(64)}`);
    expect(result.paymentHash).toBe(bound);
  });
});

describe("keyRef resolution is wallet-only and hash-verified", () => {
  const evmRequest = (keyRef: Record<string, unknown>) => ({
    chainId: 8453,
    to: `0x${"a".repeat(40)}`,
    data: "0xdead$htlcPreimageHexbeef",
    value: "0",
    needsPreimage: true,
    keyRef,
  });

  it("resolves a wallet-minted ref, verifies the hash, and signs", async () => {
    vi.mocked(signAndBroadcastSwapKitEvmTx).mockResolvedValue({ hash: `0x${"1".repeat(64)}` });
    const executor = makeV2ExecuteEvmCall();
    const result = await executor(
      evmRequest({
        provider: "satora",
        walletKeyRef: "nuri-htlc-v1:satora:42",
        preimageHash: PREIMAGE_HASH,
      }),
      CTX,
    );
    expect(result.txHash).toBe(`0x${"1".repeat(64)}`);
    expect(materializeSwapKitHtlcPreimage).toHaveBeenCalledWith("satora", 42);
    // The redaction was materialized into the calldata before signing.
    const parsed = vi.mocked(signAndBroadcastSwapKitEvmTx).mock.calls.at(-1)?.[0];
    expect(parsed?.data).toContain(Buffer.from(PREIMAGE).toString("hex"));
  });

  it("refuses a keyRef this wallet did not mint (e.g. a bare server keyIndex)", async () => {
    const executor = makeV2ExecuteEvmCall();
    await expect(
      executor(evmRequest({ provider: "satora", keyIndex: 42, preimageHash: PREIMAGE_HASH }), CTX),
    ).rejects.toThrow(/missing provider\/walletKeyRef/);
    await expect(
      executor(
        evmRequest({
          provider: "satora",
          walletKeyRef: "someone-elses-ref:1",
          preimageHash: PREIMAGE_HASH,
        }),
        CTX,
      ),
    ).rejects.toThrow(/not minted by this wallet/);
    expect(signAndBroadcastSwapKitEvmTx).not.toHaveBeenCalled();
  });

  it("refuses a provider mismatch and a preimage-hash mismatch", async () => {
    const executor = makeV2ExecuteEvmCall();
    await expect(
      executor(
        evmRequest({
          provider: "boltz",
          walletKeyRef: "nuri-htlc-v1:satora:42",
          preimageHash: PREIMAGE_HASH,
        }),
        CTX,
      ),
    ).rejects.toThrow(/provider does not match/);
    await expect(
      executor(
        evmRequest({
          provider: "satora",
          walletKeyRef: "nuri-htlc-v1:satora:42",
          preimageHash: `0x${"d".repeat(64)}`,
        }),
        CTX,
      ),
    ).rejects.toThrow(/does not match this wallet's derivation/);
  });
});

describe("executeV2ArkadeClaim", () => {
  const claimRequest = (overrides: Record<string, unknown> = {}) => ({
    keyRef: {
      provider: "satora",
      walletKeyRef: "nuri-htlc-v1:satora:9",
      preimageHash: PREIMAGE_HASH,
    },
    destinationAddress: "ark1ourown",
    vhtlc: { address: "ark1vhtlc" },
    ...overrides,
  });

  it("claims with OUR keyIndex from the wallet-minted ref", async () => {
    vi.mocked(getArkadeReceiveAddress).mockResolvedValue("ark1ourown");
    vi.mocked(claimSwapKitArkadeVhtlc).mockResolvedValue("arktx1");
    const result = await executeV2ArkadeClaim(claimRequest(), CTX);
    expect(result.arkTxid).toBe("arktx1");
    expect(claimSwapKitArkadeVhtlc).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "satora", keyIndex: 9, preimageHash: PREIMAGE_HASH }),
    );
  });

  it("refuses a destination that is not this wallet's own Arkade address", async () => {
    vi.mocked(getArkadeReceiveAddress).mockResolvedValue("ark1ourown");
    await expect(
      executeV2ArkadeClaim(claimRequest({ destinationAddress: "ark1somebodyelse" }), CTX),
    ).rejects.toThrow(/not this wallet's own Arkade address/);
    expect(claimSwapKitArkadeVhtlc).not.toHaveBeenCalled();
  });

  it("server-preimage claims still require a wallet-minted ref", async () => {
    vi.mocked(getArkadeReceiveAddress).mockResolvedValue("ark1ourown");
    await expect(
      executeV2ArkadeClaim(
        claimRequest({
          preimage: `0x${"e".repeat(64)}`,
          keyRef: { provider: "satora", walletKeyRef: "foreign", preimageHash: PREIMAGE_HASH },
        }),
        CTX,
      ),
    ).rejects.toThrow(/not minted by this wallet/);
  });
});

describe("executeV2PayLightningInvoice", () => {
  // A decodable invoice and a persisted consent are now PRECONDITIONS, so the
  // outcome-shape cases below state them rather than relying on fail-open.
  let decodeSpy: ReturnType<typeof vi.spyOn> | null = null;
  beforeEach(() => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
      flow: "arkade_to_btc",
      acceptedDeposit: "500",
    } as never);
    decodeSpy = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
      raw: "lnbc1",
      amountSats: 500,
      expiresAt: Date.now() / 1000 + 600,
      paymentHash: "ab".repeat(32),
    });
  });
  afterEach(() => {
    decodeSpy?.mockRestore();
  });

  it("fails when the payment yields no payment hash", async () => {
    vi.mocked(payArkadeLightningInvoice).mockResolvedValue({ preimage: undefined });
    await expect(
      executeV2PayLightningInvoice({ invoice: "lnbc1", amountSats: 500 }, CTX),
    ).rejects.toThrow(/payment hash/);
  });

  it("returns the payment hash and preimage when present", async () => {
    vi.mocked(payArkadeLightningInvoice).mockResolvedValue({
      paymentHash: "f".repeat(64),
      preimage: "9".repeat(64),
    });
    const result = await executeV2PayLightningInvoice({ invoice: "lnbc1", amountSats: 500 }, CTX);
    expect(result).toEqual({ paymentHash: "f".repeat(64), preimage: "9".repeat(64) });
  });
});

// #3 (re-review) — every one of these inputs decides how much money leaves.
// Unreadable MUST mean refuse, never "unbounded": the old code turned a decode
// failure into 0 and skipped the guards on exactly the malformed responses the
// guards exist to catch.
// #3 — a stablecoin-source order must not be able to spend the ARKADE wallet.
// The universal set armed pay_lightning_invoice / arkade_send /
// arkade_intents_fund, so a server response naming one would have been honoured
// against a pot of money the user never put up for this order.
const USDC_BASE_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

describe("EVM-source orders cannot debit the Arkade wallet", () => {
  it("omits every Arkade/Lightning FUNDING executor", () => {
    const { executors } = standardEvmLoopOptions(8453, 25, 6, USDC_BASE_ADDR, null);
    expect(executors.pay_lightning_invoice).toBeUndefined();
    expect(executors.arkade_send).toBeUndefined();
    expect(executors.arkade_intents_fund).toBeUndefined();
  });

  it("keeps the EVM executors the flow actually needs", () => {
    const { executors } = standardEvmLoopOptions(8453, 25, 6, USDC_BASE_ADDR, null);
    expect(executors.execute_evm_call).toBeTypeOf("function");
    expect(executors.sign_typed_data).toBeTypeOf("function");
  });

  it("keeps the receive-side kinds, which move the wallet's own money home", () => {
    const { executors } = standardEvmLoopOptions(8453, 25, 6, USDC_BASE_ADDR, null);
    expect(executors.arkade_claim).toBeTypeOf("function");
    expect(executors.arkade_refund_material).toBeTypeOf("function");
    expect(executors.arkade_intents_refund).toBeTypeOf("function");
  });

  it("advertises exactly the kinds it can execute, so nothing can stall", () => {
    const { executors } = standardEvmLoopOptions(8453, 25, 6, USDC_BASE_ADDR, null);
    for (const kind of SWAPKIT_V2_EVM_SOURCE_CAPABILITIES) {
      expect(executors[kind as keyof typeof executors]).toBeTypeOf("function");
    }
    expect(SWAPKIT_V2_EVM_SOURCE_CAPABILITIES).not.toContain("send_asset");
    expect(SWAPKIT_V2_EVM_SOURCE_CAPABILITIES).not.toContain("arkade_send");
  });
});

describe("pay_lightning_invoice is fail-closed on unreadable inputs", () => {
  beforeEach(() => {
    vi.mocked(payArkadeLightningInvoice).mockResolvedValue({ paymentHash: "f".repeat(64) });
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
      flow: "arkade_to_btc",
      acceptedDeposit: "20000",
    } as never);
  });

  it("refuses an invoice it cannot decode", async () => {
    const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockImplementation(() => {
      throw new Error("bad bolt11");
    });
    await expect(
      executeV2PayLightningInvoice({ invoice: "garbage", amountSats: 1000 }, CTX),
    ).rejects.toThrow(/could not decode/);
    expect(payArkadeLightningInvoice).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  it("refuses an amountless invoice", async () => {
    const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
      raw: "lnbc1",
      amountSats: 0,
      expiresAt: Date.now() / 1000 + 600,
      paymentHash: "ab".repeat(32),
    });
    await expect(
      executeV2PayLightningInvoice({ invoice: "lnbc1", amountSats: 1000 }, CTX),
    ).rejects.toThrow(/no payable amount/);
    expect(payArkadeLightningInvoice).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  it.each([[undefined], [null], ["abc"], [0], [-5]])(
    "refuses an action whose amountSats is %s",
    async (amountSats) => {
      const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
        raw: "lnbc1",
        amountSats: 1000,
        expiresAt: Date.now() / 1000 + 600,
        paymentHash: "ab".repeat(32),
      });
      await expect(
        executeV2PayLightningInvoice({ invoice: "lnbc1", amountSats } as never, CTX),
      ).rejects.toThrow(/no valid amountSats/);
      expect(payArkadeLightningInvoice).not.toHaveBeenCalled();
      decode.mockRestore();
    },
  );

  it.each([[undefined], [{ flow: "arkade_to_btc" }], [{ acceptedDeposit: "0" }]])(
    "refuses to spend when the persisted consent is %j",
    async (stored) => {
      vi.mocked(SwapKitV2OrderStore.get).mockReturnValue(stored as never);
      const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
        raw: "lnbc1",
        amountSats: 1000,
        expiresAt: Date.now() / 1000 + 600,
        paymentHash: "ab".repeat(32),
      });
      await expect(
        executeV2PayLightningInvoice({ invoice: "lnbc1", amountSats: 1000 }, CTX),
      ).rejects.toThrow(/no persisted accepted deposit/);
      expect(payArkadeLightningInvoice).not.toHaveBeenCalled();
      decode.mockRestore();
    },
  );
});

describe("pay_lightning_invoice honours the accepted deposit ceiling (#2)", () => {
  beforeEach(() => {
    vi.mocked(payArkadeLightningInvoice).mockResolvedValue({
      paymentHash: "f".repeat(64),
      preimage: "9".repeat(64),
    });
  });

  it("refuses an invoice whose ENCODED amount exceeds the accepted deposit", async () => {
    // The server may hand over an action whose own amountSats looks fine while
    // the BOLT11 it points at encodes more. payArkadeLightningInvoice funds the
    // ENCODED figure, so that is what the persisted ceiling must be applied to.
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
      flow: "arkade_to_btc",
      acceptedDeposit: "20000",
    } as never);
    const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
      raw: "lnbc1",
      amountSats: 45_000,
      expiresAt: Date.now() / 1000 + 600,
      paymentHash: "ab".repeat(32),
    });

    await expect(
      executeV2PayLightningInvoice({ invoice: "lnbc1", amountSats: 45_000 }, CTX),
    ).rejects.toThrow(/exceeds the accepted deposit/);
    expect(payArkadeLightningInvoice).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  it("pays an invoice at or under the accepted deposit", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
      flow: "arkade_to_btc",
      acceptedDeposit: "20000",
    } as never);
    const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
      raw: "lnbc1",
      amountSats: 20_000,
      expiresAt: Date.now() / 1000 + 600,
      paymentHash: "ab".repeat(32),
    });

    const result = await executeV2PayLightningInvoice(
      { invoice: "lnbc1", amountSats: 20_000 },
      CTX,
    );
    expect(result.paymentHash).toBe("f".repeat(64));
    expect(payArkadeLightningInvoice).toHaveBeenCalledOnce();
    decode.mockRestore();
  });

  it("still refuses an invoice that disagrees with the action's own amount", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue(undefined as never);
    const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
      raw: "lnbc1",
      amountSats: 9_000,
      expiresAt: Date.now() / 1000 + 600,
      paymentHash: "ab".repeat(32),
    });

    await expect(
      executeV2PayLightningInvoice({ invoice: "lnbc1", amountSats: 500 }, CTX),
    ).rejects.toThrow(/amount mismatch/);
    expect(payArkadeLightningInvoice).not.toHaveBeenCalled();
    decode.mockRestore();
  });
});

describe("assertOwnerIsWalletEoa", () => {
  it("accepts the wallet's own EOA case-insensitively and rejects others", async () => {
    await expect(
      assertOwnerIsWalletEoa("0xabcd000000000000000000000000000000000001"),
    ).resolves.toBeUndefined();
    await expect(assertOwnerIsWalletEoa(`0x${"9".repeat(40)}`)).rejects.toThrow(
      /not this wallet's EOA/,
    );
  });
});

describe("resumed Lightning funding", () => {
  it("does not fund an expired invoice on restart", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
      flow: "arkade_lightning",
      to: "BTC_LN",
      settleTarget: "lnbc1",
      acceptedDepositAmount: "0.00001003",
    } as never);
    const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
      raw: "lnbc1",
      amountSats: 1000,
      expiresAt: Date.now() / 1000 - 1,
      paymentHash: "ab".repeat(32),
    });
    await expect(
      executeV2ArkadeIntentsFund({ to: "ark1lockup", amountSats: 1003 }, CTX),
    ).rejects.toThrow(/expired/);
    expect(fundArkadeIntentsOutpoint).not.toHaveBeenCalled();
    decode.mockRestore();
  });
  it("reconciles an already-started funding action even after invoice expiry", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
      flow: "arkade_lightning",
      to: "BTC_LN",
      settleTarget: "lnbc1",
      acceptedDepositAmount: "0.00001003",
    } as never);
    const decode = vi.spyOn(lightningFacts, "decodeBolt11Facts").mockReturnValue({
      raw: "lnbc1",
      amountSats: 1000,
      expiresAt: Date.now() / 1000 - 1,
      paymentHash: "ab".repeat(32),
    });
    vi.mocked(fundArkadeIntentsOutpoint).mockResolvedValue({
      arkTxid: "ab".repeat(32),
      outpoint: { txid: "ab".repeat(32), vout: 2 },
    });
    await executeV2ArkadeIntentsFund(
      { to: "ark1lockup", amountSats: 1003 },
      { ...CTX, previouslyStarted: true },
    );
    expect(fundArkadeIntentsOutpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        lockupAddress: "ark1lockup",
        amountSats: 1003,
        reconcileOnly: true,
      }),
    );
    decode.mockRestore();
  });
});

// Blockers #3/#4 — STARTED is written at the real broadcast boundary, never
// before it: a refusal that moved nothing leaves the action re-runnable, and
// every value-moving executor records the marker before funds leave.
describe("STARTED marks the real broadcast boundary", () => {
  it("send_asset marks STARTED from the funder's pre-broadcast hook, before it returns", async () => {
    const markStarted = vi.fn().mockResolvedValue(undefined);
    const order: string[] = [];
    const fund = vi.fn(
      async (_to: string, _sats: number, onBeforeBroadcast: () => Promise<void>) => {
        order.push("preflight");
        await onBeforeBroadcast();
        order.push("broadcast");
        return "ab".repeat(32);
      },
    );
    markStarted.mockImplementation(async () => {
      order.push("marked");
    });
    const exec = makeV2SendAsset({
      expectedAsset: "BTC",
      validateDestination: () => true,
      boundSats: 1000,
      fund,
    });
    await exec({ asset: "BTC", to: "bc1qdeposit", amount: "0.00001" }, { ...CTX, markStarted });
    expect(order).toEqual(["preflight", "marked", "broadcast"]);
  });

  it("send_asset leaves NO marker when the funder refuses before broadcasting", async () => {
    const markStarted = vi.fn();
    const exec = makeV2SendAsset({
      expectedAsset: "BTC",
      validateDestination: () => true,
      boundSats: 1000,
      fund: vi.fn().mockRejectedValue(new Error("user cancelled")),
    });
    await expect(
      exec({ asset: "BTC", to: "bc1qdeposit", amount: "0.00001" }, { ...CTX, markStarted }),
    ).rejects.toThrow(/cancelled/);
    expect(markStarted).not.toHaveBeenCalled();
  });

  it("arkade_send marks only via the send primitive's hook, not up front", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({ acceptedDeposit: "2000" } as never);
    const markStarted = vi.fn();
    vi.mocked(sendArkadeToArk).mockRejectedValue(new Error("approval dismissed"));
    await expect(
      executeV2ArkadeSend({ to: "ark1x", amountSats: 1000 }, { ...CTX, markStarted }),
    ).rejects.toThrow(/dismissed/);
    expect(markStarted).not.toHaveBeenCalled();
    const hook = vi.mocked(sendArkadeToArk).mock.calls[0]?.[0]?.onBeforeBroadcast;
    expect(hook).toBeTypeOf("function");
    await hook?.();
    expect(markStarted).toHaveBeenCalledOnce();
  });

  it("pay_lightning_invoice hands its marker to the send primitive instead of marking early", async () => {
    vi.mocked(payArkadeLightningInvoice).mockRejectedValue(new Error("funding ceiling"));
    const markStarted = vi.fn();
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({ acceptedDeposit: "5000" } as never);
    await executeV2PayLightningInvoice(
      { invoice: "lnbc1", amountSats: 1000, paymentHash: "f".repeat(64) },
      { ...CTX, markStarted },
    ).catch(() => {});
    expect(markStarted).not.toHaveBeenCalled();
  });
});

// Bot P1 — arkade_send debits the Arkade wallet with whatever the server
// names; the persisted accepted deposit is the ceiling.
describe("arkade_send is bound to the accepted deposit", () => {
  it("refuses a send above the accepted deposit", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({ acceptedDeposit: "1000" } as never);
    await expect(executeV2ArkadeSend({ to: "ark1x", amountSats: 1001 }, CTX)).rejects.toThrow(
      /exceeds the accepted deposit/,
    );
    expect(sendArkadeToArk).not.toHaveBeenCalled();
  });

  it("refuses when the order has no persisted ceiling", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue(undefined as never);
    await expect(executeV2ArkadeSend({ to: "ark1x", amountSats: 1 }, CTX)).rejects.toThrow(
      /no persisted accepted deposit/,
    );
    expect(sendArkadeToArk).not.toHaveBeenCalled();
  });

  it("sends at or under the accepted deposit", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({ acceptedDeposit: "1000" } as never);
    vi.mocked(sendArkadeToArk).mockResolvedValue("cd".repeat(32));
    await expect(executeV2ArkadeSend({ to: "ark1x", amountSats: 1000 }, CTX)).resolves.toEqual({
      arkTxid: "cd".repeat(32),
    });
  });
});

// Taner #1 (5e7df9bb) — the funding cap applied only to BTC_LN orders, so
// BTC_ARKADE→stable and BTC_LN→BTC funding could request any amountSats.
describe("arkade_intents_fund is capped on every corridor", () => {
  for (const to of ["EURC_BASE", "USDC_BASE", "BTC"]) {
    it(`refuses funding above the accepted deposit for → ${to}`, async () => {
      vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
        to,
        acceptedDepositAmount: "0.00001",
      } as never);
      await expect(
        executeV2ArkadeIntentsFund({ to: "ark1lockup", amountSats: 1001 }, CTX),
      ).rejects.toThrow(/exceeds the accepted deposit/);
      expect(fundArkadeIntentsOutpoint).not.toHaveBeenCalled();
    });
  }

  it("refuses funding when the order has no persisted ceiling", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({ to: "USDC_BASE" } as never);
    await expect(
      executeV2ArkadeIntentsFund({ to: "ark1lockup", amountSats: 1 }, CTX),
    ).rejects.toThrow(/no persisted accepted deposit/);
    expect(fundArkadeIntentsOutpoint).not.toHaveBeenCalled();
  });

  it("funds at the accepted deposit", async () => {
    vi.mocked(SwapKitV2OrderStore.get).mockReturnValue({
      to: "USDC_BASE",
      acceptedDepositAmount: "0.00001",
    } as never);
    vi.mocked(fundArkadeIntentsOutpoint).mockResolvedValue({
      arkTxid: "ab".repeat(32),
      outpoint: { txid: "ab".repeat(32), vout: 0 },
    });
    await executeV2ArkadeIntentsFund({ to: "ark1lockup", amountSats: 1000 }, CTX);
    expect(fundArkadeIntentsOutpoint).toHaveBeenCalledOnce();
  });
});

// Taner #2 (5e7df9bb) — rows re-adopted after a reinstall have no consent on
// this device, so they may only move value back to this wallet.
describe("recovery-only executors", () => {
  it("carries claim/refund kinds and nothing that funds or signs a spend", () => {
    const executors = makeRecoveryOnlyV2Executors();
    expect(Object.keys(executors).sort()).toEqual(
      ["arkade_claim", "arkade_intents_refund", "arkade_refund_material"].sort(),
    );
  });
});

// Taner #1 (ed888cb9) — sign_typed_data checked only the domain chain.
describe("sign_typed_data is route-bound", () => {
  it("is not offered at all by an executor set with no route", () => {
    expect(makeStandardV2Executors({}).sign_typed_data).toBeUndefined();
  });

  it("refuses a Permit2 signature and never reaches the signer", async () => {
    const sign = makeV2SignTypedData({ sourceToken: USDC_BASE_ADDR, ceiling: 1n, settle: null });
    await expect(
      sign(
        {
          domain: { name: "Permit2", chainId: 8453, verifyingContract: `0x${"2".repeat(40)}` },
          primaryType: "PermitWitnessTransferFrom",
          types: {},
          message: {},
        },
        CTX,
      ),
    ).rejects.toThrow(/refused/);
    expect(executeSwapKitHtlcAction).not.toHaveBeenCalled();
  });
});

// Taner #1 (0c7e5c09) — non-EVM-source flows installed an unbound raw EVM
// executor. Raw calls are only offered where every call can be bound.
describe("raw EVM execution requires a binding", () => {
  it("is not installed by an executor set with no route and no sweep bound", () => {
    expect(makeStandardV2Executors({}).execute_evm_call).toBeUndefined();
    expect(makeStandardV2Executors().execute_evm_call).toBeUndefined();
    expect(makeStandardV2Executors({ maxApprovalUnits: 1n }).execute_evm_call).toBeUndefined();
  });
  it("is installed for a route-bound EVM-source order", () => {
    const { executors } = standardEvmLoopOptions(8453, 25, 6, USDC_BASE_ADDR, null);
    expect(executors.execute_evm_call).toBeTypeOf("function");
  });
  it("is NOT installed for the sweep lane: an approval cap bounds an amount, not a target", () => {
    expect(
      makeStandardV2Executors({ requireApprovalBound: true, maxApprovalUnits: 1n })
        .execute_evm_call,
    ).toBeUndefined();
  });
});
