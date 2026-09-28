import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSwapAlternatives, formatSwapRoute } from "../../lib/formatting";
import {
  assertMinedTxMatchesSigned,
  assertSupportedSwapActions,
  fetchCuratedRoutes,
  getRequiredGasWei,
  getSwapKitRouteLimits,
  getPendingBtcPayoutConfirmation,
  isTerminal,
  isServerExecutedRoute,
  parseSwapActionTx,
  routeSwapKitSwap,
  runSwapKitStatusLoop,
  runSwapKitSwapLoop,
  SWAPKIT_WALLET_CAPABILITIES,
} from "./SwapKitService";

describe("provider BTC payout confirmation", () => {
  const pending = {
    status: "COMPLETED",
    terminal: true,
    legs: [
      {
        leg: "USDC_BASE->BTC",
        terminal: true,
        settlementConfirmation: {
          txid: "a".repeat(64),
          confirmed: false,
          feerateSatPerVb: 1,
          etaMinutes: 60,
        },
      },
    ],
  };

  it("keeps a provider-paid BTC order live until its first confirmation", () => {
    expect(isTerminal(pending)).toBe(false);
    expect(getPendingBtcPayoutConfirmation(pending)).toEqual({
      txid: "a".repeat(64),
      confirmed: false,
      feerateSatPerVb: 1,
      etaMinutes: 60,
    });
  });

  it("accepts the order as terminal after confirmation", () => {
    const confirmed = {
      ...pending,
      legs: [
        {
          ...pending.legs[0],
          settlementConfirmation: { ...pending.legs[0].settlementConfirmation, confirmed: true },
        },
      ],
    };
    expect(isTerminal(confirmed)).toBe(true);
    expect(getPendingBtcPayoutConfirmation(confirmed)).toBeNull();
  });
});

const ADDR = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function mcpEnvelope(payload: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });
}

function mockFetchTexts(texts: string[], ok = true) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok,
    status: ok ? 200 : 500,
    text: async () => texts.shift() ?? mcpEnvelope({ status: "COMPLETED", terminal: true }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseSwapActionTx", () => {
  const validAction = {
    type: "sign_and_broadcast_evm_tx",
    chainId: 8453,
    tx: { to: ADDR, data: "0x5fd9ae2e", value: "0x0", gasLimit: "0x1530d3" },
    approval: { token: TOKEN, spender: ADDR, amount: "6203000" },
  };

  it("parses a valid Base mainnet action", () => {
    const parsed = parseSwapActionTx(validAction);
    expect(parsed.to).toBe(ADDR);
    expect(parsed.value).toBe(0n);
    expect(parsed.gasLimit).toBe(0x1530d3n);
    expect(parsed.approval).toEqual({ token: TOKEN, spender: ADDR, amount: 6203000n });
  });

  it("refuses to sign for a foreign or missing chain", () => {
    expect(() => parseSwapActionTx({ ...validAction, chainId: 1 })).toThrow(/chain/);
    expect(() => parseSwapActionTx({ ...validAction, chainId: undefined })).toThrow(/chain/);
  });

  it("rejects malformed to / calldata / approval", () => {
    expect(() =>
      parseSwapActionTx({ ...validAction, tx: { ...validAction.tx, to: "not-an-address" } }),
    ).toThrow(/`to`/);
    expect(() =>
      parseSwapActionTx({ ...validAction, tx: { ...validAction.tx, data: "zz" } }),
    ).toThrow(/calldata/);
    expect(() =>
      parseSwapActionTx({
        ...validAction,
        approval: { token: TOKEN, spender: ADDR, amount: "not-a-number" },
      }),
    ).toThrow(/approval amount/);
  });

  it("rejects a non-zero value — stablecoin legs never send ETH", () => {
    expect(() =>
      parseSwapActionTx({ ...validAction, tx: { ...validAction.tx, value: "0x1" } }),
    ).toThrow(/non-zero value/);
  });

  it("binds the approval to the tx target and the locally accepted token", () => {
    expect(() =>
      parseSwapActionTx({
        ...validAction,
        approval: {
          ...validAction.approval,
          spender: "0x2222222222222222222222222222222222222222",
        },
      }),
    ).toThrow(/spender/);
    expect(() =>
      parseSwapActionTx({
        ...validAction,
        approval: { ...validAction.approval, token: "0x2222222222222222222222222222222222222222" },
      }),
    ).toThrow(/swept asset/);
  });

  it("accepts a sweep chain only when the runner binds its exact token", () => {
    const ethereumAction = {
      ...validAction,
      chainId: 1,
      tx: { ...validAction.tx, chainId: 1 },
      approval: {
        ...validAction.approval,
        token: "0x2222222222222222222222222222222222222222",
      },
    };
    expect(() => parseSwapActionTx(ethereumAction)).toThrow(/chain/);
    expect(() =>
      parseSwapActionTx(ethereumAction, [1], ["0x3333333333333333333333333333333333333333"]),
    ).toThrow(/swept asset/);
    const parsed = parseSwapActionTx(ethereumAction, [1], [ethereumAction.approval.token]);
    expect(parsed.chainId).toBe(1);
  });

  it("parses a bound signer and rejects a malformed one", () => {
    const eoa = "0x4444444444444444444444444444444444444444";
    expect(parseSwapActionTx({ ...validAction, tx: { ...validAction.tx, from: eoa } }).from).toBe(
      eoa,
    );
    expect(() =>
      parseSwapActionTx({ ...validAction, tx: { ...validAction.tx, from: "nope" } }),
    ).toThrow(/`from`/);
  });
});

describe("assertMinedTxMatchesSigned", () => {
  const signed = {
    to: ADDR as `0x${string}`,
    data: "0x5fd9ae2e" as `0x${string}`,
    value: 0n,
    from: "0x4444444444444444444444444444444444444444" as `0x${string}`,
  };
  const mined = {
    to: ADDR.toLowerCase(),
    input: "0x5FD9AE2E",
    value: 0n,
    from: signed.from.toUpperCase().replace("0X", "0x"),
    chainId: 8453,
  };

  it("accepts the chain record when it equals the signed payload", () => {
    expect(() => assertMinedTxMatchesSigned(signed, mined)).not.toThrow();
  });

  it("rejects every mismatched signed field", () => {
    for (const bad of [
      { ...mined, to: "0x2222222222222222222222222222222222222222" },
      { ...mined, input: "0xdeadbeef" },
      { ...mined, value: 1n },
      { ...mined, from: "0x2222222222222222222222222222222222222222" },
      { ...mined, chainId: 1 },
    ]) {
      expect(() => assertMinedTxMatchesSigned(signed, bad)).toThrow(/does not match/);
    }
  });
});

describe("assertSupportedSwapActions", () => {
  it("accepts known action types and rejects unknown ones before funding", () => {
    expect(() =>
      assertSupportedSwapActions([
        { type: "pay_lightning_invoice" },
        { type: "sign_and_broadcast_evm_tx" },
      ]),
    ).not.toThrow();
    expect(() => assertSupportedSwapActions([{ type: "server_private_key" }])).toThrow(
      /unsupported/,
    );
  });

  // A capability is not a handler. arkade_vhtlc_v2 says this wallet can rebuild
  // the strict vHTLC script; the action that carries such a lockup is still
  // arkade_vhtlc_v1, and nothing dispatches a type of that name. If the
  // guardian let it through, a server slip would be discovered after funding
  // instead of before it.
  it("refuses a capability flag presented as an action type", () => {
    expect(SWAPKIT_WALLET_CAPABILITIES).toContain("arkade_vhtlc_v2");
    expect(() => assertSupportedSwapActions([{ type: "arkade_vhtlc_v2" }])).toThrow(/unsupported/);
    expect(() => assertSupportedSwapActions([{ type: "arkade_vhtlc_v1" }])).not.toThrow();
  });
});

describe("getSwapKitRouteLimits", () => {
  it("prefers executable, best, quoted, then unavailable limits", () => {
    const executable = { source: "bestExecutable", min: 1 };
    const best = { source: "best", min: 2 };
    const quote = { source: "quote", min: 3 };
    const unavailable = { source: "unavailable", min: 4 };

    expect(
      getSwapKitRouteLimits({
        bestExecutable: { limits: executable },
        best: { limits: best },
        quotes: [{ limits: quote }],
        unavailable: [{ limits: unavailable }],
      }),
    ).toBe(executable);
    expect(
      getSwapKitRouteLimits({
        best: { limits: best },
        quotes: [{ limits: quote }],
        unavailable: [{ limits: unavailable }],
      }),
    ).toBe(best);
    expect(getSwapKitRouteLimits({ quotes: [{}, { limits: quote }] })).toBe(quote);
    expect(getSwapKitRouteLimits({ unavailable: [{}, { limits: unavailable }] })).toBe(unavailable);
    expect(getSwapKitRouteLimits(null)).toBeNull();
  });
});

describe("getRequiredGasWei", () => {
  it("uses only a valid before-funding requirement for the requested chain", () => {
    expect(
      getRequiredGasWei(
        {
          requiredGas: [
            { chainId: 42161, minWei: "10", beforeFunding: true },
            { chainId: 8453, minWei: "5000000000000", beforeFunding: true },
          ],
        },
        8453,
      ),
    ).toBe(5_000_000_000_000n);
    expect(getRequiredGasWei({ requiredGas: [{ chainId: 8453, minWei: "bad" }] }, 8453)).toBeNull();
  });
});

describe("fetchCuratedRoutes", () => {
  it("sorts executable routes first by best rate; greyed-out routes sink to the bottom", async () => {
    mockFetchTexts([
      mcpEnvelope({
        options: [
          { routeId: "soon", executable: false, effectiveRate: 99 },
          { routeId: "ok-worse", executable: true, productionReady: true, effectiveRate: 1 },
          { routeId: "ok-best", executable: true, productionReady: true, effectiveRate: 2 },
        ],
      }),
    ]);

    const routes = await fetchCuratedRoutes({
      from: "EURC_BASE",
      to: "BTC_LN",
      amount: 50,
      side: "deposit",
    });
    expect(routes.map((route) => route.routeId)).toEqual(["ok-best", "ok-worse", "soon"]);
  });
});

describe("SwapKit MCP envelope parsing", () => {
  it("parses JSON envelopes", async () => {
    const fetchMock = mockFetchTexts([mcpEnvelope({ quotes: [{ provider: "ok" }] })]);

    await expect(routeSwapKitSwap({ from: "BTC_LN", to: "EURC_BASE" })).resolves.toMatchObject({
      quotes: [{ provider: "ok" }],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses the latest SSE data envelope", async () => {
    mockFetchTexts([
      `event: message\ndata: ${mcpEnvelope({ quotes: [{ provider: "first" }] })}\n\ndata: ${mcpEnvelope({ quotes: [{ provider: "last" }] })}\n\ndata: [DONE]\n`,
    ]);

    await expect(routeSwapKitSwap({ from: "BTC_LN", to: "EURC_BASE" })).resolves.toMatchObject({
      quotes: [{ provider: "last" }],
    });
  });

  it("surfaces MCP isError and HTTP failures", async () => {
    mockFetchTexts([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { isError: true, content: [{ type: "text", text: "route unavailable" }] },
      }),
    ]);
    await expect(routeSwapKitSwap({ from: "BTC_LN", to: "EURC_BASE" })).rejects.toThrow(
      /route unavailable.*http 200/,
    );

    mockFetchTexts([mcpEnvelope({})], false);
    await expect(routeSwapKitSwap({ from: "BTC_LN", to: "EURC_BASE" })).rejects.toThrow(
      /failed \(http 500\)/,
    );
  });

  it("surfaces structured transient responses as retryable failures", async () => {
    mockFetchTexts([
      mcpEnvelope({
        ok: false,
        status: "TEMPORARILY_UNAVAILABLE",
        retryable: true,
        retryAfterMs: 1500,
      }),
    ]);

    await expect(routeSwapKitSwap({ from: "BTC_LN", to: "EURC_BASE" })).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 1500,
    });
  });
});

describe("runSwapKitSwapLoop", () => {
  it("keeps polling a provider-paid BTC payout until the first confirmation", async () => {
    const txid = "a".repeat(64);
    const onUpdate = vi.fn();
    const fetchMock = mockFetchTexts([
      mcpEnvelope({
        txId: "btc-payout-1",
        status: "COMPLETED",
        terminal: true,
        legs: [
          {
            leg: "USDC_BASE->BTC",
            terminal: true,
            settlementConfirmation: { txid, confirmed: false, feerateSatPerVb: 1 },
          },
        ],
      }),
      mcpEnvelope({
        txId: "btc-payout-1",
        status: "COMPLETED",
        terminal: true,
        legs: [
          {
            leg: "USDC_BASE->BTC",
            terminal: true,
            settlementConfirmation: { txid, confirmed: true, feerateSatPerVb: 1 },
          },
        ],
      }),
    ]);

    const result = await runSwapKitSwapLoop("btc-payout-1", {
      intervalMs: 1,
      maxPolls: 2,
      onUpdate,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(result.legs?.[0]?.settlementConfirmation?.confirmed).toBe(true);
  });

  it("never submits a recoveryChoice — server ≥0.6.25 resolves FixedFloat emergencies itself", async () => {
    const fetchMock = mockFetchTexts([
      mcpEnvelope({
        txId: "ff-1",
        status: "RECOVERY_PENDING",
        legs: [{ provider: "fixedfloat", status: "RECOVERY_PENDING" }],
      }),
      mcpEnvelope({ txId: "ff-1", status: "COMPLETED", terminal: true }),
    ]);

    await expect(runSwapKitSwapLoop("ff-1", { intervalMs: 1, maxPolls: 2 })).resolves.toMatchObject(
      {
        status: "COMPLETED",
      },
    );

    const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(calls.some((body) => "recoveryChoice" in body.params.arguments)).toBe(false);
  });

  it("signs at most once and re-reports the broadcast hash", async () => {
    const action = {
      type: "sign_and_broadcast_evm_tx",
      chainId: 8453,
      tx: { to: ADDR, data: "0x5fd9ae2e", value: "0x0" },
    };
    const fetchMock = mockFetchTexts([
      mcpEnvelope({ txId: "order-1", status: "PENDING", actions: [action] }),
      mcpEnvelope({ txId: "order-1", status: "PENDING", actions: [action] }),
      mcpEnvelope({ txId: "order-1", status: "COMPLETED" }),
    ]);
    const signAction = vi.fn(async () => ({ hash: "0xhash" }));

    await expect(
      runSwapKitSwapLoop("order-1", { intervalMs: 1, maxPolls: 3, signAction }),
    ).resolves.toMatchObject({ status: "COMPLETED" });

    expect(signAction).toHaveBeenCalledOnce();
    const requestBodies = fetchMock.mock.calls
      .map(([, init]) =>
        (init as RequestInit | undefined)?.body ? JSON.parse(String(init?.body)) : null,
      )
      .filter(Boolean);
    expect(requestBodies.some((body) => body.params.arguments.depositTxHash === "0xhash")).toBe(
      true,
    );
  });

  it("tolerates four consecutive track errors but throws on the fifth", async () => {
    mockFetchTexts([
      "not json",
      "not json",
      "not json",
      "not json",
      mcpEnvelope({ status: "COMPLETED" }),
    ]);
    await expect(
      runSwapKitSwapLoop("order-2", { intervalMs: 1, maxPolls: 5 }),
    ).resolves.toMatchObject({
      status: "COMPLETED",
    });

    mockFetchTexts(["not json", "not json", "not json", "not json", "not json"]);
    await expect(runSwapKitSwapLoop("order-3", { intervalMs: 1, maxPolls: 5 })).rejects.toThrow(
      /non-JSON/,
    );
  });

  it("keeps the sheet alive when a stale action fails local parsing before retry", async () => {
    mockFetchTexts([
      mcpEnvelope({
        txId: "order-stale-action",
        status: "AWAITING_SIGNATURE",
        actions: [
          {
            type: "sign_and_broadcast_evm_tx",
            chainId: 42161,
            tx: { to: ADDR, data: "0x5fd9ae2e", value: "0x0" },
            approval: {
              token: "0x4444444444444444444444444444444444444444",
              spender: ADDR,
              amount: "1",
            },
          },
        ],
      }),
      mcpEnvelope({ txId: "order-stale-action", status: "COMPLETED", terminal: true }),
    ]);
    const signAction = vi.fn(async () => ({ hash: "0xhash" }));

    await expect(
      runSwapKitSwapLoop("order-stale-action", {
        intervalMs: 1,
        maxPolls: 2,
        signAction,
        allowedActionChains: [42161],
        allowedApprovalTokens: [TOKEN],
      }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
    expect(signAction).not.toHaveBeenCalled();
  });

  it("fails closed on a send_asset action unless the caller funds it out of band", async () => {
    const sendAsset = mcpEnvelope({
      status: "AWAITING_FUNDING",
      actions: [{ type: "send_asset", to: "0x2222222222222222222222222222222222222222" }],
    });

    // A signer is what puts the loop on the action path at all, and every
    // non-sweep caller that reaches it passes one.
    const signAction = vi.fn(async () => ({ hash: "0xhash" }));

    // No externallyFundedDeposit: nothing in this flow will ever fund the
    // deposit, so the loop must refuse rather than poll to exhaustion.
    mockFetchTexts([sendAsset]);
    await expect(
      runSwapKitSwapLoop("order-send-asset-unfunded", { intervalMs: 1, maxPolls: 3, signAction }),
    ).rejects.toThrow(/unsupported live action: send_asset/);
    expect(signAction).not.toHaveBeenCalled();

    // Sweep claim: fundSweepConvert is moving the deposit, so the loop keeps
    // polling and reports the server's terminal status instead of throwing.
    mockFetchTexts([sendAsset, mcpEnvelope({ status: "COMPLETED", terminal: true })]);
    await expect(
      runSwapKitSwapLoop("order-send-asset-funded", {
        intervalMs: 1,
        maxPolls: 3,
        signAction,
        externallyFundedDeposit: true,
      }),
    ).resolves.toMatchObject({ status: "COMPLETED" });
    expect(signAction).not.toHaveBeenCalled();
  });

  it("retries KV-lag unknown transactions and treats status-only terminal as terminal", async () => {
    vi.useFakeTimers();
    mockFetchTexts([
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "unknown transaction" } }),
      mcpEnvelope({ txId: "order-4", status: "FAILED" }),
    ]);
    const promise = runSwapKitSwapLoop("order-4", { maxPolls: 2 });
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(promise).resolves.toMatchObject({ status: "FAILED" });
  });

  it("returns a synthetic terminal UNKNOWN when 'unknown transaction' outlives the KV grace window", async () => {
    vi.useFakeTimers();
    const unknown = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { message: "unknown transaction" },
    });
    const fetchMock = mockFetchTexts([unknown, unknown, unknown, unknown, unknown, unknown]);

    const promise = runSwapKitSwapLoop("order-gone", { intervalMs: 1, maxPolls: 10 });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      txId: "order-gone",
      status: "UNKNOWN",
      terminal: true,
      explanation: expect.stringMatching(/unknown transaction/i),
    });
    // 5 grace retries + the terminal-deciding poll — nothing after that.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("runSwapKitStatusLoop", () => {
  it("polls to terminal and ignores actions[] — never signs, never submits", async () => {
    const evmAction = {
      type: "sign_and_broadcast_evm_tx",
      chainId: 8453,
      tx: { to: ADDR, data: "0x5fd9ae2e", value: "0x0" },
    };
    const onUpdate = vi.fn();
    const fetchMock = mockFetchTexts([
      mcpEnvelope({ txId: "v2-1", status: "PROCESSING", actions: [evmAction] }),
      mcpEnvelope({ txId: "v2-1", status: "COMPLETED", terminal: true }),
    ]);

    await expect(
      runSwapKitStatusLoop("v2-1", { intervalMs: 1, maxPolls: 2, onUpdate }),
    ).resolves.toMatchObject({ status: "COMPLETED" });

    expect(onUpdate).toHaveBeenCalledTimes(2);
    // Every call is a bare swap_track poll: no signature/hash ever leaves the app.
    const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    for (const body of calls) {
      expect(body.params.name).toBe("swap_track");
      expect(body.params.arguments).toEqual({ txId: "v2-1" });
    }
  });
});

describe("isServerExecutedRoute", () => {
  it("is true only for an explicit executionMode of 'server' (top level or .route)", () => {
    expect(isServerExecutedRoute({ executionMode: "server" })).toBe(true);
    expect(isServerExecutedRoute({ route: { executionMode: "server" } })).toBe(true);
    expect(isServerExecutedRoute({ executionMode: "wallet" })).toBe(false);
    expect(isServerExecutedRoute({ executionMode: "SERVER" })).toBe(false);
    expect(isServerExecutedRoute({ route: {} })).toBe(false);
    expect(isServerExecutedRoute({})).toBe(false);
    expect(isServerExecutedRoute(null)).toBe(false);
    expect(isServerExecutedRoute("server")).toBe(false);
  });
});

describe("swap route formatting", () => {
  it("formats the chosen route without hardcoding hops", () => {
    expect(
      formatSwapRoute({
        path: ["BTC_LN", "USDC_BASE", "EURC_BASE"],
        providers: ["fixedfloat", "lifi"],
      }),
    ).toBe("BTC → USDC → EURC · fixedfloat + lifi");
    expect(formatSwapRoute({ path: ["EURC_BASE", "BTC_LN"], providers: ["bitcoinvn"] })).toBe(
      "EURC → BTC · bitcoinvn",
    );
    expect(formatSwapRoute(undefined)).toBeNull();
  });

  it("summarizes alternatives by hub, keeping the chain", () => {
    expect(
      formatSwapAlternatives([
        { path: ["BTC_LN", "USDC_ARBITRUM", "EURC_BASE"] },
        { path: ["BTC_LN", "USDC_ETH", "EURC_BASE"] },
        { path: ["EURC_BASE", "BTC_LN"] },
      ]),
    ).toBe("USDC·Arbitrum, USDC·Eth, direct");
    expect(formatSwapAlternatives([])).toBeNull();
  });
});

describe("not-ready reverts", () => {
  it("classifies precondition reverts as waits, real failures as failures", async () => {
    const { isNotReadyRevert } = await import("./SwapKitService");
    // Every one of these was observed live on 2026-07-14 while a precondition
    // (provider payout, lockup confirmation, CoW settlement) was still landing.
    expect(
      isNotReadyRevert(new Error("Execution reverted with reason: TRANSFER_FROM_FAILED")),
    ).toBe(true);
    expect(isNotReadyRevert(new Error("preflight reverted selector=0x931997cf"))).toBe(true); // ExpiredTransaction
    expect(isNotReadyRevert(new Error("preflight reverted selector=0x5ec69df0"))).toBe(true); // SwapNotFound
    // SwapNotActive: the exact revert that abandoned sk_4cb679be… on 2026-08-21
    // with its sats already locked — the claim was offered before Satora's lock
    // had settled, so simulation failed and the sign budget ran out.
    expect(isNotReadyRevert(new Error("preflight reverted selector=0x28c6a0cc"))).toBe(true);
    expect(isNotReadyRevert(new Error("Arkade VHTLC refund locktime not reached"))).toBe(true);
    expect(
      isNotReadyRevert(
        new Error("FORFEIT_CLOSURE_LOCKED (11): 1784471181 > 1784468590 (blocktime)"),
      ),
    ).toBe(true);
    // Structural problems must still burn the budget and surface.
    expect(isNotReadyRevert(new Error("SwapKit approval exceeds the user-accepted amount"))).toBe(
      false,
    );
    expect(isNotReadyRevert(new Error("action is bound to signer 0xabc, not this wallet"))).toBe(
      false,
    );
  });

  it("gives a timelock wait far more patience than a stuck precondition", async () => {
    const { notReadyBudget } = await import("./SwapKitService");
    // Block time trails the wall clock by an hour or two, so a refund can be
    // legitimately early for far longer than the 25-wait precondition budget.
    // Counting it there stranded 62k sats on 19.07.2026.
    const clock = notReadyBudget(
      new Error("FORFEIT_CLOSURE_LOCKED (11): 1784471181 > 1784468590 (blocktime)"),
    );
    const precondition = notReadyBudget(new Error("Execution reverted: TRANSFER_FROM_FAILED"));
    expect(precondition).toBe(25);
    // At the 90s backoff cap this must outlast the documented ~2h chain lag.
    expect(clock * 90).toBeGreaterThan(2 * 3600);
    expect(clock).toBeGreaterThan(precondition);
  });

  it("keeps polling a paid swap through repeated not-ready reverts instead of abandoning it", async () => {
    vi.useFakeTimers();
    try {
      const evmAction = {
        type: "sign_and_broadcast_evm_tx",
        chainId: 8453,
        tx: { to: ADDR, data: "0x5fd9ae2e", value: "0x0" },
      };
      mockFetchTexts([
        mcpEnvelope({ status: "PROCESSING", actions: [evmAction] }),
        mcpEnvelope({ status: "PROCESSING", actions: [evmAction] }),
        mcpEnvelope({ status: "PROCESSING", actions: [evmAction] }),
        mcpEnvelope({ status: "PROCESSING", actions: [evmAction] }),
        mcpEnvelope({ status: "PROCESSING", actions: [evmAction] }),
        mcpEnvelope({ status: "COMPLETED", terminal: true }),
      ]);
      const signAction = vi
        .fn()
        // 4 not-ready reverts in a row — with the old budget (3) this threw and
        // stranded the paid swap; now it waits and completes.
        .mockRejectedValueOnce(new Error("Execution reverted with reason: TRANSFER_FROM_FAILED"))
        .mockRejectedValueOnce(new Error("Execution reverted with reason: TRANSFER_FROM_FAILED"))
        .mockRejectedValueOnce(new Error("Execution reverted with reason: TRANSFER_FROM_FAILED"))
        .mockRejectedValueOnce(new Error("Execution reverted with reason: TRANSFER_FROM_FAILED"))
        .mockResolvedValue({ hash: "0xhash" });

      const promise = runSwapKitSwapLoop("sk_test", {
        signAction,
        intervalMs: 1_000,
        maxPolls: 20,
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(signAction.mock.calls.length).toBeGreaterThan(3); // survived past the 3-failure budget
      expect(String(result.status)).toBe("COMPLETED");
    } finally {
      vi.useRealTimers();
    }
  });
});
