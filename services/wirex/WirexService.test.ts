import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Wallet: vi.fn(),
  assertWirexVirtualCardNames: vi.fn(),
  buildWirexCardActionMessage: vi.fn(),
  buildWirexIssueVirtualCardMessage: vi.fn(),
  getEthereumAddress: vi.fn(),
  getPrivateKey: vi.fn(),
  logWithId: vi.fn(),
  submitSignedApproval: vi.fn(),
  getAuthData: vi.fn(),
  storeAuthData: vi.fn(),
  deleteAuthData: vi.fn(),
}));

vi.mock("ethers", () => ({ Wallet: mocks.Wallet }));
vi.mock("../../lib/crypto", () => ({
  bytesToHex: vi.fn(),
  zeroize: vi.fn(),
}));
vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: {
    app: "🏁",
    auth: "🔐",
    card: "💳",
    error: "❌",
    iban: "🏦",
    network: "🌐",
    success: "✅",
    wallet: "💼",
  },
  logWithId: mocks.logWithId,
}));
vi.mock("../../lib/wirex/cardTransactions", () => ({
  mapWirexBankActivity: vi.fn(),
  mapWirexCardTransactions: vi.fn(),
}));
vi.mock("../../lib/wirex/wirexDeposits", () => ({ fetchWirexDeposits: vi.fn() }));
vi.mock("../../lib/wirex/mergeWirexActivity", () => ({ mergeWirexActivity: vi.fn() }));
vi.mock("../pricing/FxRateService", () => ({ fxRateService: {} }));
vi.mock("../../lib/secureKeyStorage", () => ({
  getAuthData: mocks.getAuthData,
  getEthereumAddress: mocks.getEthereumAddress,
  getPrivateKey: mocks.getPrivateKey,
  storeAuthData: mocks.storeAuthData,
  deleteAuthData: mocks.deleteAuthData,
}));
vi.mock("../../lib/wirex/bridgeCallback", () => ({
  submitSignedApproval: mocks.submitSignedApproval,
}));
// Only the builders/guards these tests assert on are stubbed; the rest (notably
// isWirexCardLast4, whose rule the server owns) stays real so the test can't drift
// from the shipped predicate.
vi.mock("../../lib/wirex/cardActionMessage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/wirex/cardActionMessage")>()),
  assertWirexVirtualCardNames: mocks.assertWirexVirtualCardNames,
  buildWirexCardActionMessage: mocks.buildWirexCardActionMessage,
  buildWirexIssueVirtualCardMessage: mocks.buildWirexIssueVirtualCardMessage,
}));
vi.mock("../../lib/wirex/registerVerification", () => ({ verifyRegisterCallData: vi.fn() }));
vi.mock("../auth/AuthStateService", () => ({ authStateManager: {} }));
vi.mock("./wirexConfig", () => ({
  wirexConfig: {
    restBaseUrl: "https://wirex.test/v1",
    routes: {
      cardClose: "/card/close",
      cardIssueVirtual: "/card/virtual",
      withdrawResult: "/withdraw/result",
      withdrawStart: "/withdraw/start",
    },
  },
}));

import { wirexService, WirexWithdrawUnconfirmedError } from "./WirexService";

const OWNER_EOA = "0x1111111111111111111111111111111111111111";

function okResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, error: null }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function errorResponse(error: unknown, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, data: null, error }), {
    headers: { "content-type": "application/json" },
    status,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.getEthereumAddress.mockResolvedValue(OWNER_EOA);
  // On-device signing EOA (biometric key, mocked here).
  mocks.Wallet.mockImplementation(function MockWallet() {
    return { address: OWNER_EOA, signMessage: async () => "0xsig" };
  });
  mocks.buildWirexIssueVirtualCardMessage.mockReturnValue("issue-message");
  // clearAllMocks keeps implementations — drop the throwing one a test may set.
  mocks.assertWirexVirtualCardNames.mockReset();
  // Default: the callback POST is reached (fire onBeforeCallbackPost, which the
  // execution approval uses to persist the durable pending record), then succeed.
  mocks.submitSignedApproval.mockImplementation(
    async (p: { onBeforeCallbackPost?: () => unknown }) => {
      await p?.onBeforeCallbackPost?.();
    },
  );
  // Durable auth-data store (keychain), shared across a test's withdraw calls so
  // the pending-withdrawal lock persists like it does on device.
  const authStore = new Map<string, string>();
  mocks.getAuthData.mockImplementation(async (key: string) => authStore.get(key) ?? null);
  mocks.storeAuthData.mockImplementation(async (key: string, value: string) => {
    authStore.set(key, value);
  });
  mocks.deleteAuthData.mockImplementation(async (key: string) => {
    authStore.delete(key);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WirexService.issueVirtualCard", () => {
  it("posts the locally signed request and returns the new card", async () => {
    const card = { id: "card-2", status: "Active", last4: "4242" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse({ card_id: "card-2", card, reconciled: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(wirexService.issueVirtualCard()).resolves.toEqual({
      cardId: "card-2",
      card,
      reconciled: false,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://wirex.test/v1/card/virtual");
    expect(init?.method).toBe("POST");
    // Signed write, not a read-session write: no bearer, wallet + ts + signature
    // in the body, and no bridge approval.
    expect(init?.headers).not.toHaveProperty("authorization");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ wallet: OWNER_EOA, ts: expect.any(Number), signature: "0xsig" });
    expect(mocks.buildWirexIssueVirtualCardMessage).toHaveBeenCalledWith({
      cardName: undefined,
      nameOnCard: undefined,
      ts: body.ts,
    });
    expect(mocks.submitSignedApproval).not.toHaveBeenCalled();
  });

  it("signs and sends the optional names, treating blank ones as omitted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse({ card_id: "card-2" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      wirexService.issueVirtualCard({ cardName: " Travel ", nameOnCard: "   " }),
    ).resolves.toEqual({ cardId: "card-2", card: null, reconciled: false });

    // The signed string and the body must agree on the same names.
    expect(mocks.buildWirexIssueVirtualCardMessage).toHaveBeenCalledWith({
      cardName: "Travel",
      nameOnCard: undefined,
      ts: expect.any(Number),
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      card_name: "Travel",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty("name_on_card");
  });

  it("surfaces a reconciled card (lost response) without issuing a second one", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse({ card_id: "card-2", reconciled: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(wirexService.issueVirtualCard()).resolves.toMatchObject({ reconciled: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    "visa_virtual_card_capability_not_active",
    "phone_number_missing",
    "wirex_card_snapshot_failed",
    "signature_replayed",
  ])("surfaces %s without ever re-signing and retrying", async (code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(errorResponse(code));
    vi.stubGlobal("fetch", fetchMock);

    await expect(wirexService.issueVirtualCard()).rejects.toThrow(code);
    // A retry would need a fresh signature and could create a SECOND card.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.getPrivateKey).toHaveBeenCalledOnce();
  });

  it("validates the names BEFORE the signature prompt", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    mocks.assertWirexVirtualCardNames.mockImplementation(() => {
      throw new Error("card_name_must_not_contain_semicolon_or_newline");
    });

    await expect(wirexService.issueVirtualCard({ cardName: "a;b" })).rejects.toThrow(
      "card_name_must_not_contain_semicolon_or_newline",
    );
    // No biometric tap, no request — the user is not charged a prompt for a name
    // the server would 400 on.
    expect(mocks.getPrivateKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the trimmed names actually sent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(okResponse({ card_id: "c" })));

    await wirexService.issueVirtualCard({ cardName: " Travel ", nameOnCard: "  " });

    expect(mocks.assertWirexVirtualCardNames).toHaveBeenCalledWith({
      cardName: "Travel",
      nameOnCard: undefined,
    });
  });

  it("rejects a success envelope without a card_id", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse({ card: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(wirexService.issueVirtualCard()).rejects.toThrow("returned no card_id");
  });
});

describe("WirexService.closeCard", () => {
  it("signs the close action with the shown last4 and posts both", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(okResponse({ ok: true, card_id: "card-2", action: "close" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(wirexService.closeCard("card-2", " 4242 ")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://wirex.test/v1/card/close");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      wallet: OWNER_EOA,
      card_id: "card-2",
      last4: "4242",
      ts: expect.any(Number),
      signature: "0xsig",
    });
    // The signed string and the body must carry the SAME last4 — the server
    // verifies both against Wirex.
    expect(mocks.buildWirexCardActionMessage).toHaveBeenCalledWith({
      action: "close",
      cardId: "card-2",
      last4: "4242",
      ts: body.ts,
      limit: undefined,
    });
  });

  // The server rejects a bad last4 before anything else (last4_must_be_4_digits),
  // so these must never reach the signature prompt.
  it.each(["", "   ", "424", "42424", "42a2", "•4242"])(
    "refuses to sign with an invalid last4 (%j)",
    async (last4) => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchMock);

      await expect(wirexService.closeCard("card-2", last4)).rejects.toThrow(
        "requires the 4 digits",
      );
      // No biometric tap, no request — the server would reject it anyway.
      expect(mocks.getPrivateKey).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("throws when the inner payload reports the close failed", async () => {
    // Envelope ok:true, inner ok:false — the Wirex-side failure must not read as
    // a closed card.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        okResponse({ ok: false, card_id: "card-2", error: "card_last4_mismatch" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(wirexService.closeCard("card-2", "4242")).rejects.toThrow("card_last4_mismatch");
  });
});

describe("WirexService.withdrawToWallet", () => {
  it.each(["", "0", "-1", "1.0000001", "not-an-amount"])(
    "rejects invalid amount %j before reading the wallet",
    async (amount) => {
      await expect(wirexService.withdrawToWallet(amount)).rejects.toThrow(
        "wirex_withdraw_invalid_amount",
      );
      expect(mocks.getEthereumAddress).not.toHaveBeenCalled();
    },
  );

  // A full card balance carries the base token's own 6 decimals; the server
  // parses it with those decimals, so it is sent verbatim, never cut to cents.
  it("starts a full-precision withdrawal with the exact figure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(okResponse({ ok: false, error: "stop_after_start" }));
    vi.stubGlobal("fetch", fetchMock);

    await wirexService.withdrawToWallet("0.995018", { asset: "USDC" }).catch(() => {});

    const [, startInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(startInit?.body))).toEqual({
      amount: "0.995018",
      asset: "USDC",
      wallet: OWNER_EOA,
    });
  });

  it("withdraws to the owner EOA after polling through ok:true waiting results", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValueOnce(okResponse({ status: "pending" }))
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      )
      .mockResolvedValueOnce(okResponse({ ok: true, status: "waiting" }))
      .mockResolvedValueOnce(
        okResponse({
          amount: "12.50",
          final_tx_hash: "0xfinal",
          first_tx_hash: "0xrequest",
          ok: true,
          status: "completed",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const withdrawal = wirexService.withdrawToWallet(" 12.50 ");
    await vi.runAllTimersAsync();

    await expect(withdrawal).resolves.toEqual({
      amount: "12.50",
      // A result that names no asset is the euro withdrawal every server
      // performed before the parameter existed.
      asset: "EURC",
      finalTxHash: "0xfinal",
      firstTxHash: "0xrequest",
      ok: true,
    });

    expect(mocks.getEthereumAddress).toHaveBeenCalledOnce();
    const [, startInit] = fetchMock.mock.calls[0];
    const startBody = JSON.parse(String(startInit?.body));
    expect(startBody).toEqual({ amount: "12.50", asset: "EURC", wallet: OWNER_EOA });
    expect(startBody).not.toHaveProperty("recipient");

    expect(mocks.submitSignedApproval).toHaveBeenNthCalledWith(1, {
      approvalUrl: "https://approval.test/request",
      sign: expect.any(Function),
    });
    expect(mocks.submitSignedApproval).toHaveBeenNthCalledWith(2, {
      approvalUrl: "https://approval.test/execute",
      sign: expect.any(Function),
      onBeforeCallbackPost: expect.any(Function),
    });
    expect(mocks.getPrivateKey).not.toHaveBeenCalled();

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://wirex.test/v1/withdraw/start",
      "https://wirex.test/v1/withdraw/result?session_id=request-session",
      "https://wirex.test/v1/withdraw/result?session_id=request-session",
      "https://wirex.test/v1/withdraw/result?session_id=execute-session",
      "https://wirex.test/v1/withdraw/result?session_id=execute-session",
    ]);
  });

  it("reports the request approval before the execution approval is signed", async () => {
    // Callers move the balances at the request approval (~3s into a ~19s flow),
    // so it must fire right after the FIRST approval, before the second.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          amount: "12.50",
          final_tx_hash: "0xfinal",
          first_tx_hash: "0xrequest",
          ok: true,
          status: "completed",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const order: string[] = [];
    mocks.submitSignedApproval.mockImplementation(
      async (p: { approvalUrl: string; onBeforeCallbackPost?: () => unknown }) => {
        order.push(`approve:${p.approvalUrl}`);
        await p?.onBeforeCallbackPost?.();
      },
    );

    const withdrawal = wirexService.withdrawToWallet("12.50", {
      onRequestApproved: () => order.push("onRequestApproved"),
      onSubmitted: () => order.push("onSubmitted"),
    });
    await vi.runAllTimersAsync();
    await expect(withdrawal).resolves.toMatchObject({ ok: true });

    expect(order).toEqual([
      "approve:https://approval.test/request",
      "onRequestApproved",
      "approve:https://approval.test/execute",
      "onSubmitted",
    ]);
  });

  it("rejects an explicit ok:false completed withdrawal result", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          amount: "12.50",
          final_tx_hash: "0xfinal",
          first_tx_hash: "0xrequest",
          ok: false,
          status: "completed",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    // Post-execution-approval failure → ambiguous/non-retryable, not a plain
    // error the UI would offer to retry.
    await expect(wirexService.withdrawToWallet("12.50")).rejects.toBeInstanceOf(
      WirexWithdrawUnconfirmedError,
    );

    expect(mocks.submitSignedApproval).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://wirex.test/v1/withdraw/start",
      "https://wirex.test/v1/withdraw/result?session_id=request-session",
      "https://wirex.test/v1/withdraw/result?session_id=execute-session",
    ]);
  });

  it.each([
    ["omitted", {}],
    ["null", { ok: null }],
  ])("rejects a completed withdrawal result with %s ok", async (_label, okFields) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          amount: "12.50",
          final_tx_hash: "0xfinal",
          first_tx_hash: "0xrequest",
          ...okFields,
          status: "completed",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    // Post-execution-approval failure → ambiguous/non-retryable, not a plain
    // error the UI would offer to retry.
    await expect(wirexService.withdrawToWallet("12.50")).rejects.toBeInstanceOf(
      WirexWithdrawUnconfirmedError,
    );

    expect(mocks.submitSignedApproval).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://wirex.test/v1/withdraw/start",
      "https://wirex.test/v1/withdraw/result?session_id=request-session",
      "https://wirex.test/v1/withdraw/result?session_id=execute-session",
    ]);
  });

  it("keeps a PRE-approval failure retryable — not unconfirmed", async () => {
    // The failure happens while polling for approval_required, BEFORE the
    // execution approval is submitted. No funds could have moved, so it stays a
    // specific (retryable) error, never the unconfirmed/non-retryable state.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValueOnce(okResponse({ status: "failed" }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await wirexService.withdrawToWallet("12.50").catch((e) => e);
    expect(err).not.toBeInstanceOf(WirexWithdrawUnconfirmedError);
    expect(String(err?.message)).toContain("wirex_withdraw_unexpected_status");
    // Only the request approval was submitted — the execution approval (the
    // point of no return) was never reached.
    expect(mocks.submitSignedApproval).toHaveBeenCalledTimes(1);
  });

  it("cannot start a second withdrawal while the first outcome is unknown (durable gate)", async () => {
    // Call 1: reaches the execution approval, persists the pending session, then
    // the completed poll returns an ambiguous status → unconfirmed.
    const fetch1 = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      )
      .mockResolvedValue(okResponse({ status: "processing" }));
    vi.stubGlobal("fetch", fetch1);

    const p1 = wirexService.withdrawToWallet("12.50").catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await p1).toBeInstanceOf(WirexWithdrawUnconfirmedError);
    // The ambiguous-window record was persisted.
    expect(mocks.storeAuthData).toHaveBeenCalledWith(
      expect.stringContaining("wirex:withdraw:pending:v1:"),
      expect.stringContaining("execute-session"),
    );

    // Call 2 simulates a close/reopen + retry tap. It must reconcile the SAME
    // session, stay unconfirmed, and NEVER POST withdraw/start (no 2nd withdrawal).
    const fetch2 = vi.fn<typeof fetch>().mockResolvedValue(okResponse({ status: "processing" }));
    vi.stubGlobal("fetch", fetch2);

    const p2 = wirexService.withdrawToWallet("12.50").catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await p2).toBeInstanceOf(WirexWithdrawUnconfirmedError);

    const urls2 = fetch2.mock.calls.map(([input]) => String(input));
    expect(urls2.some((u) => u.includes("/withdraw/start"))).toBe(false);
    expect(urls2.every((u) => u.includes("session_id=execute-session"))).toBe(true);
  });

  it("treats a lost execution-approval callback as unconfirmed and blocks retry", async () => {
    // Request approval resolves; the EXECUTION approval callback then rejects —
    // its POST may already have reached the server. Must be unconfirmed, with the
    // pending record persisted BEFORE the failing submit.
    mocks.submitSignedApproval
      // request approval OK
      .mockImplementationOnce(async () => {})
      // execution approval: the POST is reached (record persisted) then the
      // response is lost.
      .mockImplementationOnce(async (p: { onBeforeCallbackPost?: () => unknown }) => {
        await p?.onBeforeCallbackPost?.();
        throw new Error("callback timeout");
      });

    const fetch1 = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValue(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      );
    vi.stubGlobal("fetch", fetch1);

    const p1 = wirexService.withdrawToWallet("12.50").catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await p1).toBeInstanceOf(WirexWithdrawUnconfirmedError);
    expect(mocks.storeAuthData).toHaveBeenCalledWith(
      expect.stringContaining("wirex:withdraw:pending:v1:"),
      expect.stringContaining("execute-session"),
    );

    // Retry after the ambiguous callback: reconcile the same session (still
    // ambiguous) → unconfirmed, and never POST withdraw/start.
    const fetch2 = vi.fn<typeof fetch>().mockResolvedValue(okResponse({ status: "processing" }));
    vi.stubGlobal("fetch", fetch2);
    const p2 = wirexService.withdrawToWallet("12.50").catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await p2).toBeInstanceOf(WirexWithdrawUnconfirmedError);
    expect(
      fetch2.mock.calls.map(([u]) => String(u)).some((u) => u.includes("/withdraw/start")),
    ).toBe(false);
  });

  it("does NOT lock the wallet when the execution approval fails before its POST", async () => {
    // Local signing/biometric failure happens BEFORE the callback POST (never
    // fires onBeforeCallbackPost), so no withdrawal crossed the point of no
    // return. This must surface a plain retryable error — not unconfirmed — and
    // leave NO durable record, so a later attempt can withdraw normally.
    mocks.submitSignedApproval
      .mockImplementationOnce(async () => {}) // request approval OK
      .mockImplementationOnce(async () => {
        // signing fails before the POST; onBeforeCallbackPost is never called
        throw new Error("biometric_cancelled");
      });

    const fetch1 = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValue(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      );
    vi.stubGlobal("fetch", fetch1);

    const err = await wirexService.withdrawToWallet("12.50").catch((e) => e);
    expect(err).not.toBeInstanceOf(WirexWithdrawUnconfirmedError);
    expect(String(err?.message)).toContain("biometric_cancelled");
    // No pending record was written — the wallet is not locked.
    expect(mocks.storeAuthData).not.toHaveBeenCalledWith(
      expect.stringContaining("wirex:withdraw:pending:v1:"),
      expect.anything(),
    );

    // A subsequent withdrawal is unblocked: no reconcile record, so it reaches
    // withdraw/start normally.
    const fetch2 = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/request",
          session_id: "request-session",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          approval_url: "https://approval.test/execute",
          session_id: "execute-session",
          status: "approval_required",
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          amount: "12.50",
          final_tx_hash: "0xfinal",
          first_tx_hash: "0xrequest",
          ok: true,
          status: "completed",
        }),
      );
    vi.stubGlobal("fetch", fetch2);
    const p2 = wirexService.withdrawToWallet("12.50");
    await vi.runAllTimersAsync();
    await expect(p2).resolves.toMatchObject({ ok: true });
    expect(
      fetch2.mock.calls.map(([u]) => String(u)).some((u) => u.includes("/withdraw/start")),
    ).toBe(true);
  });
});

describe("WirexService.withdrawToWallet asset", () => {
  it("refuses a dollar withdrawal a server does not echo back", async () => {
    // A server that predates the parameter prepares a EURO withdrawal and says
    // nothing about it. Nothing has been signed at that point, so the refusal
    // costs the user only a retry — taking the silence for agreement would move
    // the wrong money.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      okResponse({
        approval_url: "https://approval.test/request",
        session_id: "request-session",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(wirexService.withdrawToWallet("12.50", { asset: "USDC" })).rejects.toThrow(
      "wirex_withdraw_asset_not_supported",
    );
    // Refused BEFORE any approval was submitted.
    expect(mocks.submitSignedApproval).not.toHaveBeenCalled();
  });
});

// A SEPA transfer is judged by its own bank-feed row, never by an unrelated
// outbound payment placed around the same time.
describe("SEPA completion matches only the submitted transfer", () => {
  const PLACED = "2026-09-25T10:00:00.000Z";
  const row = (over: Record<string, unknown>) => ({
    id: "other",
    direction: "Outbound",
    status: "Completed",
    created_at: "2026-09-25T10:00:20.000Z",
    source_amount: { amount: -50, currency: "EUR" },
    ...over,
  });
  const settled = (rows: unknown[], amount: number | null = 25) => {
    mocks.getEthereumAddress.mockResolvedValue(OWNER_EOA);
    vi.spyOn(wirexService, "getBankTransactions").mockResolvedValue(rows as never);
    return wirexService.isSepaTransferSettled("tr_1", PLACED, amount);
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an unrelated completed payment does not settle it", async () => {
    expect(await settled([row({})])).toBe(false);
  });
  it("its own row by id decides", async () => {
    expect(await settled([row({ id: "tr_1", status: "Pending" })])).toBe(false);
    expect(await settled([row({ id: "tr_1" })])).toBe(true);
  });
  it("without the id, the one same-amount row placed with it decides", async () => {
    expect(await settled([row({ source_amount: { amount: -25, currency: "EUR" } })])).toBe(true);
  });
  it("two same-amount rows are ambiguous: no verdict", async () => {
    const same = row({ source_amount: { amount: -25, currency: "EUR" } });
    expect(await settled([same, { ...same, id: "x2" }])).toBeNull();
  });
});
