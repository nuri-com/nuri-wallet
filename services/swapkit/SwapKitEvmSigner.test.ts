import { beforeEach, describe, expect, it, vi } from "vitest";

const EOA = "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;
const RESET_HASH = `0x${"cd".repeat(32)}` as `0x${string}`;
const APPROVE_HASH = `0x${"ef".repeat(32)}` as `0x${string}`;

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  estimateGas: vi.fn(),
  sendTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  getPrivateKey: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      call: mocks.call,
      estimateGas: mocks.estimateGas,
      waitForTransactionReceipt: mocks.waitForTransactionReceipt,
    }),
    createWalletClient: () => ({ sendTransaction: mocks.sendTransaction }),
  };
});
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: () => ({ address: EOA }),
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getPrivateKey: mocks.getPrivateKey,
}));
vi.mock("../../lib/rpc/baseRpc", () => ({
  getBaseViemTransport: () => ({ type: "mock" }),
}));

import { signAndBroadcastSwapKitEvmTx } from "./SwapKitEvmSigner";
import live from "./__fixtures__/lifi-live-calldata.json";

const parsed = {
  chainId: 8453,
  to: "0x2222222222222222222222222222222222222222" as `0x${string}`,
  data: "0x1234" as `0x${string}`,
  value: 0n,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrivateKey.mockResolvedValue(new Uint8Array(32));
  mocks.call.mockResolvedValue({ data: "0x" });
  mocks.estimateGas.mockResolvedValue(100_000n);
  mocks.sendTransaction.mockResolvedValue(HASH);
  mocks.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
});

describe("signAndBroadcastSwapKitEvmTx", () => {
  it("returns the broadcast hash when the post-send receipt RPC is unavailable", async () => {
    mocks.waitForTransactionReceipt.mockRejectedValueOnce(new Error("public RPC replication lag"));

    await expect(signAndBroadcastSwapKitEvmTx(parsed)).resolves.toEqual({ hash: HASH });
    expect(mocks.sendTransaction).toHaveBeenCalledOnce();
  });

  it("journals broadcast intent before send and the hash before receipt polling", async () => {
    const events: string[] = [];
    mocks.sendTransaction.mockImplementationOnce(async () => {
      events.push("send");
      return HASH;
    });
    mocks.waitForTransactionReceipt.mockImplementationOnce(async () => {
      events.push("receipt");
      return { status: "success" };
    });

    await signAndBroadcastSwapKitEvmTx(parsed, {
      onBeforeBroadcast: () => {
        events.push("before");
      },
      onBroadcast: () => {
        events.push("hash");
      },
    });

    expect(events).toEqual(["before", "send", "hash", "receipt"]);
  });

  // #3 — the server emits its approve as a plain execute_evm_call with RAW
  // calldata and no `approval` metadata, so the metadata branch never sees it.
  // Without decoding, an unbounded allowance was signed for the order's token.
  describe("raw ERC-20 approval calldata is held to the accepted ceiling", () => {
    const approveCalldata = (amount: bigint) =>
      `0x095ea7b3${"0".repeat(24)}${TOKEN.slice(2)}${amount
        .toString(16)
        .padStart(64, "0")}` as `0x${string}`;

    it("refuses raw approve calldata above the ceiling", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, data: approveCalldata(5_000_000n) },
          { maxApprovalUnits: 1_000_000n },
        ),
      ).rejects.toThrow(/exceeds the accepted deposit/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses an unlimited (max-uint256) raw approval", async () => {
      const MAX = (1n << 256n) - 1n;
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, data: approveCalldata(MAX) },
          { maxApprovalUnits: 1_000_000n },
        ),
      ).rejects.toThrow(/exceeds the accepted deposit/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("signs raw approve calldata at or under the ceiling", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, data: approveCalldata(1_000_000n) },
          { maxApprovalUnits: 1_000_000n },
        ),
      ).resolves.toEqual({ hash: HASH });
      expect(mocks.sendTransaction).toHaveBeenCalledOnce();
    });

    it("leaves non-approval calldata alone when no route is bound (unbound lanes only)", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, data: "0xdeadbeef" },
          {
            maxApprovalUnits: 1n,
          },
        ),
      ).resolves.toEqual({ hash: HASH });
      expect(mocks.sendTransaction).toHaveBeenCalledOnce();
    });
  });

  // approve() bounds a FUTURE spend; transfer()/transferFrom() move the money
  // now, to a recipient named in server-built calldata. No route emits one, so
  // every bounded lane refuses them outright — at ANY amount, to ANY recipient.
  describe("bounded lanes never sign a raw ERC-20 transfer", () => {
    const transferCalldata = (to: string, amount: bigint) =>
      `0xa9059cbb${"0".repeat(24)}${to.slice(2)}${amount.toString(16).padStart(64, "0")}` as `0x${string}`;
    const transferFromCalldata = (from: string, to: string, amount: bigint) =>
      `0x23b872dd${"0".repeat(24)}${from.slice(2)}${"0".repeat(24)}${to.slice(2)}${amount
        .toString(16)
        .padStart(64, "0")}` as `0x${string}`;

    it("refuses a transfer even under the ceiling", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, data: transferCalldata(TOKEN, 1n) },
          { maxApprovalUnits: 1_000_000n },
        ),
      ).rejects.toThrow(/never signs a raw ERC-20 transfer/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses a transferFrom of this wallet's own balance", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, data: transferFromCalldata(EOA, TOKEN, 1n) },
          { maxApprovalUnits: 1_000_000n },
        ),
      ).rejects.toThrow(/never signs a raw ERC-20 transfer/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses a transfer in the sweep lane too", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, data: transferCalldata(TOKEN, 1n) },
          { requireApprovalBound: true },
        ),
      ).rejects.toThrow(/never signs a raw ERC-20 transfer/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });
  });

  // #1 — an EVM-source order binds every call to its accepted route.
  describe("route-bound EVM calls", () => {
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
    const EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;
    const LIFI = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as const;
    const COW_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110" as const;
    const STRANGER = `0x${"9".repeat(40)}` as const;
    const route = {
      chainId: 8453,
      sourceToken: USDC,
      settle: {
        kind: "evm" as const,
        chainId: 8453,
        token: EURC,
        receiver: live.stableToStable.receiver as `0x${string}`,
      },
    };
    const bounds = { maxApprovalUnits: 1_000_000n, route };
    const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const approve = (spender: string, amount: bigint) =>
      `0x095ea7b3${word(spender)}${word(amount.toString(16))}` as `0x${string}`;
    const allowanceIs = (byToken: Record<string, bigint>) =>
      mocks.call.mockImplementation(async (req: { to?: string; data?: string }) => {
        if (String(req.data || "").startsWith("0xdd62ed3e")) {
          const hit = Object.entries(byToken).find(
            ([t]) => t.toLowerCase() === String(req.to).toLowerCase(),
          );
          return { data: `0x${(hit?.[1] ?? 0n).toString(16).padStart(64, "0")}` };
        }
        return { data: "0x" };
      });

    it("signs an approve of a known route spender on the source token", async () => {
      for (const spender of [LIFI, COW_RELAYER]) {
        mocks.sendTransaction.mockClear();
        await expect(
          signAndBroadcastSwapKitEvmTx(
            { ...parsed, to: USDC, data: approve(spender, 1_000_000n) },
            bounds,
          ),
        ).resolves.toEqual({ hash: HASH });
        expect(mocks.sendTransaction).toHaveBeenCalledOnce();
      }
    });

    it("refuses an approve naming a spender outside the route", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx({ ...parsed, to: USDC, data: approve(STRANGER, 1n) }, bounds),
      ).rejects.toThrow(/not a contract of the accepted route/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses an approve on a token this order does not spend", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx({ ...parsed, to: EURC, data: approve(LIFI, 1n) }, bounds),
      ).rejects.toThrow(/not a contract of the accepted route/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses arbitrary calldata to an unknown contract", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx({ ...parsed, to: STRANGER, data: "0xdeadbeef" }, bounds),
      ).rejects.toThrow(/not a contract of the accepted route/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses any non-approve call on the source token", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx({ ...parsed, to: USDC, data: "0x39509351" }, bounds),
      ).rejects.toThrow(/Only an approve\(\) may be called/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });

    // Leftover approvals are normal and never block a swap.
    it("signs the LI.FI swap regardless of existing allowances", async () => {
      allowanceIs({ [USDC]: 50_000_000n, [EURC]: 7n });
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, to: LIFI, data: live.stableToStable.data as `0x${string}` },
          { ...bounds, maxApprovalUnits: 20_000_000n },
        ),
      ).resolves.toEqual({ hash: HASH });
    });

    it("refuses approval metadata on a route-bound order", async () => {
      await expect(
        signAndBroadcastSwapKitEvmTx(
          { ...parsed, to: LIFI, approval: { token: USDC, spender: LIFI, amount: 1n } },
          bounds,
        ),
      ).rejects.toThrow(/does not accept approval metadata/);
      expect(mocks.sendTransaction).not.toHaveBeenCalled();
    });
  });

  it("still rejects a receipt that proves the action reverted", async () => {
    mocks.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });

    await expect(signAndBroadcastSwapKitEvmTx(parsed)).rejects.toThrow(
      `Sweep action reverted onchain: ${HASH}`,
    );
  });

  it("replaces an oversized allowance with the exact server-requested amount", async () => {
    mocks.call.mockResolvedValueOnce({ data: "0x14" }).mockResolvedValueOnce({ data: "0x" });
    mocks.sendTransaction
      .mockResolvedValueOnce(RESET_HASH)
      .mockResolvedValueOnce(APPROVE_HASH)
      .mockResolvedValueOnce(HASH);

    await expect(
      signAndBroadcastSwapKitEvmTx(
        {
          ...parsed,
          approval: {
            token: TOKEN,
            spender: parsed.to,
            amount: 10n,
          },
        },
        { maxApprovalUnits: 10n },
      ),
    ).resolves.toEqual({ hash: HASH });

    expect(mocks.sendTransaction).toHaveBeenCalledTimes(3);
    expect(mocks.sendTransaction.mock.calls[0]?.[0]).toMatchObject({
      to: TOKEN,
      data: expect.stringMatching(/0{64}$/),
    });
    expect(mocks.sendTransaction.mock.calls[1]?.[0]).toMatchObject({
      to: TOKEN,
      data: expect.stringMatching(/0{63}a$/),
    });
    expect(mocks.sendTransaction.mock.calls[2]?.[0]).toMatchObject({ to: parsed.to });
    expect(mocks.waitForTransactionReceipt).toHaveBeenNthCalledWith(1, { hash: RESET_HASH });
    expect(mocks.waitForTransactionReceipt).toHaveBeenNthCalledWith(2, { hash: APPROVE_HASH });
    expect(mocks.waitForTransactionReceipt).toHaveBeenNthCalledWith(3, { hash: HASH });
  });
});

describe("signAndBroadcastSwapKitEvmTx approval ceiling", () => {
  const approval = { token: TOKEN as `0x${string}`, spender: parsed.to, amount: 10n };

  it("refuses an approval larger than the detected balance", async () => {
    await expect(
      signAndBroadcastSwapKitEvmTx({ ...parsed, approval }, { maxApprovalUnits: 9n }),
    ).rejects.toThrow(/exceeds the detected balance/);
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses to approve at all when no detected-amount bound was persisted", async () => {
    await expect(signAndBroadcastSwapKitEvmTx({ ...parsed, approval })).rejects.toThrow(
      /no detected-amount bound/,
    );
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("signAndBroadcastSwapKitEvmTx sweep lane without approval", () => {
  it("refuses an approvalless action and sends nothing", async () => {
    // No approval metadata means no amount this wallet can bound: the calldata
    // is server-built and never decoded, so it could spend an existing
    // allowance past the detected balance.
    await expect(
      signAndBroadcastSwapKitEvmTx(parsed, {
        maxApprovalUnits: 1_000n,
        requireApprovalBound: true,
      }),
    ).rejects.toThrow(/no approval to bound/);
    expect(mocks.sendTransaction).not.toHaveBeenCalled();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("signs an approvalless action in a bounded order flow (server-authoritative approve)", async () => {
    // The server now emits an explicit ERC20 approve as its own execute_evm_call
    // with raw calldata and no `approval` metadata. A bounded ORDER flow (no
    // requireApprovalBound) must SIGN it, not refuse it — refusing was the
    // decimals→integers regression that deadlocked stable→stable swaps.
    mocks.call.mockResolvedValueOnce({ data: "0x" });
    mocks.sendTransaction.mockResolvedValueOnce(HASH);

    await expect(
      signAndBroadcastSwapKitEvmTx(parsed, { maxApprovalUnits: 1_000n }),
    ).resolves.toEqual({ hash: HASH });
  });

  it("still signs an approvalless action outside the sweep lane", async () => {
    mocks.call.mockResolvedValueOnce({ data: "0x" });
    mocks.sendTransaction.mockResolvedValueOnce(HASH);

    await expect(signAndBroadcastSwapKitEvmTx(parsed)).resolves.toEqual({ hash: HASH });
  });
});
