import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SWAPKIT_V2_ACTION_KINDS,
  SwapKitV2Error,
  asSwapKitV2OrderId,
  assertKnownActionKinds,
  commitSwapKitV2,
  getSwapKitV2Capabilities,
  getSwapKitV2Limits,
  getSwapKitV2Status,
  isSwapKitV2OrderId,
  isSwapKitV2Terminal,
  nextReadyV2Action,
  quoteSwapKitV2,
  resetSwapKitV2CapabilitiesCache,
  submitSwapKitV2Evidence,
} from "./SwapKitV2Service";
import type { SwapKitV2Action, SwapKitV2OrderView } from "./SwapKitV2Service";

const CAPS = {
  contractVersion: "2.2.0",
  kinds: [...SWAPKIT_V2_ACTION_KINDS],
  signerClasses: ["eoa", "erc4337", "safe-multisig", "arkade-vhtlc"],
};

const RECOVERY_KEY = "r".repeat(64);

function mcpResult(payload: unknown, { isError = false } = {}) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError,
          content: [
            { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) },
          ],
        },
      }),
  } as Response;
}

function mockFetchSequence(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSwapKitV2CapabilitiesCache();
});

describe("v2 order id branding", () => {
  it("accepts ord_ ids and rejects v1-style tx ids", () => {
    expect(asSwapKitV2OrderId("ord_abc123")).toBe("ord_abc123");
    expect(() => asSwapKitV2OrderId("sk_4cb679be")).toThrow(/Not a SwapKit v2 order id/);
    expect(() => asSwapKitV2OrderId("")).toThrow(/Not a SwapKit v2 order id/);
    expect(isSwapKitV2OrderId("ord_x")).toBe(true);
    expect(isSwapKitV2OrderId("tx_x")).toBe(false);
  });
});

describe("capabilities handshake", () => {
  it("caches a valid contract for the session", async () => {
    const fetchMock = mockFetchSequence(mcpResult(CAPS));
    const caps = await getSwapKitV2Capabilities();
    expect(caps.contractVersion).toBe("2.2.0");
    await getSwapKitV2Capabilities();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a different contract major", async () => {
    mockFetchSequence(mcpResult({ ...CAPS, contractVersion: "3.0.0" }));
    await expect(getSwapKitV2Capabilities()).rejects.toThrow(/contract version 3\.0\.0/);
  });

  it("fails closed on a same-major but older minor (2.0/2.1)", async () => {
    mockFetchSequence(mcpResult({ ...CAPS, contractVersion: "2.1.0" }));
    await expect(getSwapKitV2Capabilities()).rejects.toThrow(/below the required 2\.2/);
  });

  it("fails closed when a required kind is no longer advertised", async () => {
    mockFetchSequence(
      mcpResult({ ...CAPS, kinds: CAPS.kinds.filter((k) => k !== "htlc_material") }),
    );
    await expect(getSwapKitV2Capabilities()).rejects.toThrow(/htlc_material/);
  });
});

describe("quote and commit", () => {
  it("returns options and structured unavailable", async () => {
    const quote = {
      mode: "quote",
      options: [
        {
          optionId: "satora:satora:USDC_BASE->BTC_ARKADE",
          from: "USDC_BASE",
          to: "BTC_ARKADE",
          depositAmount: "5.072596",
          settleAmount: "0.00006499",
          requiredCapabilities: [
            "htlc_material",
            "execute_evm_call",
            "sign_typed_data",
            "arkade_claim",
          ],
        },
      ],
      unavailable: [{ provider: "cow", route: "cow:USDC_BASE->BTC_ARKADE", reason: "no_route" }],
    };
    mockFetchSequence(mcpResult(CAPS), mcpResult(quote));
    const res = await quoteSwapKitV2({
      from: "USDC_BASE",
      to: "BTC_ARKADE",
      amount: "5",
      side: "deposit",
      owner: "0xowner",
      capabilities: SWAPKIT_V2_ACTION_KINDS,
    });
    expect(res.options[0].optionId).toContain("satora");
    expect(res.unavailable[0].reason).toBe("no_route");
  });

  it("commit requires settleTarget and rejects unknown action kinds in the response", async () => {
    mockFetchSequence(mcpResult(CAPS));
    await expect(
      commitSwapKitV2({
        from: "USDC_BASE",
        to: "BTC_ARKADE",
        amount: "5",
        side: "deposit",
        owner: "0xowner",
        capabilities: SWAPKIT_V2_ACTION_KINDS,
        optionId: "satora:x",
        idempotencyKey: "idem-1",
        recoveryKey: RECOVERY_KEY,
        acceptedDepositAmount: "5",
        minimumSettleAmount: "0.00006499",
      }),
    ).rejects.toThrow(/settleTarget/);
    resetSwapKitV2CapabilitiesCache();

    const view: SwapKitV2OrderView = {
      mode: "commit",
      orderId: "ord_1",
      status: "AWAITING_ACTION",
      actions: [
        {
          actionId: "act_1",
          kind: "teleport_funds",
          request: {},
          state: "ready",
          idempotencyKey: "ord_1:act_1",
        },
      ],
    };
    mockFetchSequence(mcpResult(CAPS), mcpResult(view));
    await expect(
      commitSwapKitV2({
        from: "USDC_BASE",
        to: "BTC_ARKADE",
        amount: "5",
        side: "deposit",
        owner: "0xowner",
        settleTarget: "0xdest",
        capabilities: SWAPKIT_V2_ACTION_KINDS,
        optionId: "satora:x",
        idempotencyKey: "idem-1",
        recoveryKey: RECOVERY_KEY,
        acceptedDepositAmount: "5",
        minimumSettleAmount: "0.00006499",
      }),
    ).rejects.toThrow(/unsupported action kind: teleport_funds/);
  });
});

describe("error normalization", () => {
  it("classifies order_in_flight from an isError result", async () => {
    mockFetchSequence(
      mcpResult(
        "Error: commit: a FUNDED order (ord_9, status IN_FLIGHT) is already in flight for 0x… USDC_BASE->BTC_ARKADE; it must settle or refund before a new one.",
        { isError: true },
      ),
    );
    try {
      await getSwapKitV2Status(asSwapKitV2OrderId("ord_9"), { recoveryKey: RECOVERY_KEY });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SwapKitV2Error);
      expect((e as SwapKitV2Error).code).toBe("order_in_flight");
    }
  });

  it("classifies unknown_order", async () => {
    mockFetchSequence(mcpResult("Error: getStatus: unknown order ord_missing", { isError: true }));
    await expect(
      getSwapKitV2Status(asSwapKitV2OrderId("ord_missing"), { recoveryKey: RECOVERY_KEY }),
    ).rejects.toMatchObject({
      code: "unknown_order",
    });
  });
});

describe("swap_limits", () => {
  it("reads the pair's bounds without a capabilities handshake or a quote", async () => {
    const payload = {
      from: "BTC_ARKADE",
      to: "EURC_BASE",
      min: "0.00005925",
      max: "0.0005",
      routes: [] as never[],
    };
    const fetchMock = mockFetchSequence(mcpResult(payload));
    await expect(getSwapKitV2Limits({ from: "BTC_ARKADE", to: "EURC_BASE" })).resolves.toEqual(
      payload,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.params).toEqual({
      name: "swap_limits",
      arguments: { from: "BTC_ARKADE", to: "EURC_BASE" },
    });
  });

  it("rejects on an older server that has no such tool", async () => {
    mockFetchSequence(mcpResult("Tool swap_limits not found", { isError: true }));
    await expect(getSwapKitV2Limits({ from: "BTC", to: "EURC_BASE" })).rejects.toThrow(
      /swap_limits/,
    );
  });
});

describe("submit evidence", () => {
  it("passes evidence through and validates the refreshed view", async () => {
    const refreshed: SwapKitV2OrderView = {
      mode: "commit",
      orderId: "ord_1",
      status: "IN_FLIGHT",
      actions: [],
    };
    const fetchMock = mockFetchSequence(mcpResult(refreshed));
    const view = await submitSwapKitV2Evidence({
      orderId: asSwapKitV2OrderId("ord_1"),
      actionId: "act_1",
      idempotencyKey: "ord_1:act_1",
      recoveryKey: RECOVERY_KEY,
      result: { actionId: "act_1", txHash: `0x${"a".repeat(64)}` },
    });
    expect(view.status).toBe("IN_FLIGHT");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.params.name).toBe("swap_submit");
    expect(body.params.arguments.idempotencyKey).toBe("ord_1:act_1");
  });
});

describe("status model and action stream", () => {
  it("terminal detection covers the closed v2 set", () => {
    for (const status of ["COMPLETED", "FAILED", "REFUNDED", "EXPIRED", "CANCELLED"]) {
      expect(isSwapKitV2Terminal({ status })).toBe(true);
    }
    for (const status of ["CREATED", "AWAITING_ACTION", "IN_FLIGHT", "SETTLING"]) {
      expect(isSwapKitV2Terminal({ status })).toBe(false);
    }
  });

  it("nextReadyV2Action skips blocked actions", () => {
    const blocked: SwapKitV2Action = {
      actionId: "act_1",
      kind: "execute_evm_call",
      request: {},
      state: "blocked",
      idempotencyKey: "o:a1",
    };
    const ready: SwapKitV2Action = {
      actionId: "act_2",
      kind: "send_asset",
      request: {},
      state: "ready",
      idempotencyKey: "o:a2",
    };
    const view: SwapKitV2OrderView = {
      mode: "commit",
      orderId: "ord_1",
      status: "AWAITING_ACTION",
      actions: [blocked, ready],
    };
    expect(nextReadyV2Action(view)?.actionId).toBe("act_2");
  });

  it("assertKnownActionKinds rejects missing ids", () => {
    expect(() =>
      assertKnownActionKinds([
        { actionId: "", kind: "send_asset", request: {}, state: "ready", idempotencyKey: "x" },
      ]),
    ).toThrow(/missing actionId/);
  });
});
