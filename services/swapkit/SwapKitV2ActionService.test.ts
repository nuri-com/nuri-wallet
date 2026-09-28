import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory cache stub — the journal must be durable across dispatcher calls
// within a test but isolated between tests.
const cache = new Map<string, unknown>();
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (key: string) => cache.get(key) ?? null,
  setCacheValue: async (key: string, value: unknown) => {
    cache.set(key, value);
  },
}));

const submitMock = vi.fn();
const statusMock = vi.fn();
vi.mock("./SwapKitV2Service", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SwapKitV2Service")>();
  return {
    ...original,
    submitSwapKitV2Evidence: (...args: unknown[]) => submitMock(...args),
    getSwapKitV2Status: (...args: unknown[]) => statusMock(...args),
  };
});

import {
  assertExecutableActions,
  executeAndSubmitV2Action,
  runSwapKitV2OrderLoop,
  validateArkadeClaim,
  validateArkadeSend,
  validateExecuteEvmCall,
  validateHtlcMaterial,
  validatePayLightningInvoice,
  validateSendAsset,
  validateSignTypedData,
} from "./SwapKitV2ActionService";
import type { SwapKitV2Executors } from "./SwapKitV2ActionService";
import { asSwapKitV2OrderId, SwapKitV2Error } from "./SwapKitV2Service";
import type { SwapKitV2Action, SwapKitV2OrderView } from "./SwapKitV2Service";

const ORDER = asSwapKitV2OrderId("ord_test1");

function action(
  kind: string,
  request: Record<string, unknown>,
  overrides: Partial<SwapKitV2Action> = {},
): SwapKitV2Action {
  return {
    actionId: overrides.actionId ?? "act_1",
    kind,
    request,
    state: "ready",
    idempotencyKey: `${ORDER}:${overrides.actionId ?? "act_1"}`,
    ...overrides,
  };
}

const terminalView: SwapKitV2OrderView = {
  mode: "commit",
  orderId: ORDER,
  status: "COMPLETED",
  actions: [],
};

beforeEach(() => {
  cache.clear();
  submitMock.mockReset().mockResolvedValue(terminalView);
  statusMock.mockReset().mockResolvedValue(terminalView);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bound-request validation", () => {
  it("execute_evm_call: rejects foreign chains, bad calldata, non-zero value", () => {
    const good = { chainId: 8453, to: `0x${"a".repeat(40)}`, data: "0xdeadbeef", value: "0" };
    expect(() => validateExecuteEvmCall(good, [8453])).not.toThrow();
    expect(() => validateExecuteEvmCall({ ...good, chainId: 1 }, [8453])).toThrow(/chain 1/);
    expect(() => validateExecuteEvmCall({ ...good, data: "zz" }, [8453])).toThrow(/calldata/);
    expect(() => validateExecuteEvmCall({ ...good, value: "1" }, [8453])).toThrow(/non-zero/);
  });

  it("execute_evm_call: accepts the $htlcPreimageHex redaction with a valid keyRef", () => {
    const redacted = {
      chainId: 8453,
      to: `0x${"a".repeat(40)}`,
      data: "0xdead$htlcPreimageHexbeef",
      value: "0",
      needsPreimage: true,
      keyRef: {
        provider: "satora",
        walletKeyRef: "nuri-htlc-v1:satora:7",
        preimageHash: `0x${"b".repeat(64)}`,
      },
    };
    expect(() => validateExecuteEvmCall(redacted, [8453])).not.toThrow();
    expect(() =>
      validateExecuteEvmCall({ ...redacted, keyRef: { provider: "satora" } }, [8453]),
    ).toThrow(/keyRef/);
  });

  it("pay_lightning_invoice: requires ln invoice and positive sats", () => {
    expect(() =>
      validatePayLightningInvoice({ invoice: "lnbc1...", amountSats: 500 }),
    ).not.toThrow();
    expect(() => validatePayLightningInvoice({ invoice: "0xnope", amountSats: 500 })).toThrow(
      /BOLT11/,
    );
    expect(() => validatePayLightningInvoice({ invoice: "lnbc1", amountSats: 0 })).toThrow(
      /amountSats/,
    );
  });

  it("arkade_send: requires ark1 destination and integer sats", () => {
    expect(() => validateArkadeSend({ to: "ark1qqq", amountSats: 1000 })).not.toThrow();
    expect(() => validateArkadeSend({ to: "bc1qqq", amountSats: 1000 })).toThrow(/ark1/);
    expect(() => validateArkadeSend({ to: "ark1qqq", amountSats: 1.5 })).toThrow(/amountSats/);
  });

  it("arkade_claim: requires descriptor + preimage source", () => {
    const vhtlc = { address: "ark1xyz" };
    expect(() =>
      validateArkadeClaim({ vhtlc, destinationAddress: "ark1me", preimage: `0x${"c".repeat(64)}` }),
    ).not.toThrow();
    expect(() =>
      validateArkadeClaim({
        vhtlc,
        destinationAddress: "ark1me",
        needsPreimage: true,
        keyRef: {
          provider: "satora",
          walletKeyRef: "nuri-htlc-v1:satora:1",
          preimageHash: `0x${"d".repeat(64)}`,
        },
      }),
    ).not.toThrow();
    expect(() => validateArkadeClaim({ vhtlc, destinationAddress: "ark1me" })).toThrow(/preimage/);
    expect(() => validateArkadeClaim({ destinationAddress: "ark1me" })).toThrow(/VHTLC/);
    // outpoint/claimScript form is refused fail-closed: the wallet cannot verify
    // the hashLock/receiver bindings from an opaque claimScript, and no
    // advertised corridor needs it.
    expect(() =>
      validateArkadeClaim({ outpoint: { txid: "ab", vout: 0 }, claimScript: "51" }),
    ).toThrow(/not supported by this wallet/);
    expect(() => validateArkadeClaim({ claimScript: "51" })).toThrow(
      /not supported by this wallet/,
    );
  });

  it("htlc_material: requires role + scope; sender needs paymentHash", () => {
    expect(() => validateHtlcMaterial({ role: "receiver", scope: "ord_1" })).not.toThrow();
    expect(() =>
      validateHtlcMaterial({ role: "sender", scope: "ord_1", paymentHash: "e".repeat(64) }),
    ).not.toThrow();
    expect(() => validateHtlcMaterial({ role: "sender", scope: "ord_1" })).toThrow(/paymentHash/);
    expect(() => validateHtlcMaterial({ role: "receiver", scope: "" })).toThrow(/scope/);
    expect(() => validateHtlcMaterial({ role: "minter", scope: "x" })).toThrow(/role/);
  });

  it("sign_typed_data: requires the complete EIP-712 payload", () => {
    const payload = { domain: {}, types: {}, primaryType: "Order", message: {} };
    expect(() => validateSignTypedData(payload)).not.toThrow();
    expect(() => validateSignTypedData({ ...payload, primaryType: "" })).toThrow(/incomplete/);
  });

  it("send_asset: requires asset, positive decimal amount, destination", () => {
    expect(() =>
      validateSendAsset({ asset: "EURC_BASE", amount: "1.5", to: "0xdst" }),
    ).not.toThrow();
    expect(() => validateSendAsset({ asset: "EURC_BASE", amount: "0", to: "0xdst" })).toThrow(
      /amount/,
    );
    expect(() => validateSendAsset({ asset: "", amount: "1", to: "0xdst" })).toThrow(/asset/);
  });
});

describe("dispatcher", () => {
  it("fails closed on a kind without an executor — before anything runs", async () => {
    await expect(
      executeAndSubmitV2Action(ORDER, action("execute_evm_call", {}), {
        executors: {},
        recoveryKey: "r".repeat(64),
      }),
    ).rejects.toThrow(/cannot execute: execute_evm_call/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("assertExecutableActions rejects a partial sequence up front", () => {
    const executors: SwapKitV2Executors = { execute_evm_call: async () => ({ txHash: "0x1" }) };
    expect(() =>
      assertExecutableActions(
        [action("execute_evm_call", {}), action("arkade_claim", {}, { actionId: "act_2" })],
        executors,
      ),
    ).toThrow(/arkade_claim/);
  });

  it("executes each kind and shapes evidence per the registry response schema", async () => {
    const txHash = `0x${"1".repeat(64)}`;
    const executors: SwapKitV2Executors = {
      execute_evm_call: vi.fn().mockResolvedValue({ txHash }),
      pay_lightning_invoice: vi
        .fn()
        .mockResolvedValue({ paymentHash: "f".repeat(64), preimage: "9".repeat(64) }),
      htlc_material: vi.fn().mockResolvedValue({
        paymentHash: "a".repeat(64),
        claimPublicKey: `02${"b".repeat(64)}`,
        refundPublicKey: `03${"c".repeat(64)}`,
      }),
      arkade_send: vi.fn().mockResolvedValue({ arkTxid: "arktx1" }),
    };

    await executeAndSubmitV2Action(
      ORDER,
      action("execute_evm_call", {
        chainId: 8453,
        to: `0x${"a".repeat(40)}`,
        data: "0xdeadbeef",
        value: "0",
      }),
      { executors, recoveryKey: "r".repeat(64) },
    );
    expect(submitMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ txHash, result: { actionId: "act_1", txHash } }),
    );

    await executeAndSubmitV2Action(
      ORDER,
      action("pay_lightning_invoice", { invoice: "lnbc1", amountSats: 500 }, { actionId: "act_2" }),
      { executors, recoveryKey: "r".repeat(64) },
    );
    expect(submitMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preimage: "9".repeat(64),
        result: expect.objectContaining({ paymentHash: "f".repeat(64) }),
      }),
    );

    await executeAndSubmitV2Action(
      ORDER,
      action("htlc_material", { role: "receiver", scope: "ord_test1" }, { actionId: "act_3" }),
      { executors, recoveryKey: "r".repeat(64) },
    );
    // Public material only — never a preimage in htlc_material evidence.
    const htlcCall = submitMock.mock.calls.at(-1)?.[0];
    expect(htlcCall.result.claimPublicKey).toMatch(/^02/);
    expect(htlcCall.preimage).toBeUndefined();

    await executeAndSubmitV2Action(
      ORDER,
      action("arkade_send", { to: "ark1dest", amountSats: 2100 }, { actionId: "act_4" }),
      { executors, recoveryKey: "r".repeat(64) },
    );
    expect(submitMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        txHash: "arktx1",
        result: { actionId: "act_4", arkTxid: "arktx1" },
      }),
    );
  });

  it("does NOT replay evidence across a different order (composite journal key)", async () => {
    const executor = vi.fn().mockResolvedValue({ txHash: `0x${"3".repeat(64)}` });
    const executors: SwapKitV2Executors = { execute_evm_call: executor };
    const req = {
      chainId: 8453,
      to: `0x${"a".repeat(40)}`,
      data: "0xdeadbeef",
      value: "0",
    };
    // Same actionId, TWO different orders. Order B must execute its own action —
    // never replay order A's evidence (that would skip B's real broadcast).
    const orderB = asSwapKitV2OrderId("ord_test2");
    await executeAndSubmitV2Action(ORDER, action("execute_evm_call", req), {
      executors,
      recoveryKey: "r".repeat(64),
    });
    await executeAndSubmitV2Action(orderB, action("execute_evm_call", req), {
      executors,
      recoveryKey: "r".repeat(64),
    });
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it("replays journaled evidence without re-executing", async () => {
    const executor = vi.fn().mockResolvedValue({ txHash: `0x${"2".repeat(64)}` });
    const executors: SwapKitV2Executors = { execute_evm_call: executor };
    const evmAction = action("execute_evm_call", {
      chainId: 8453,
      to: `0x${"a".repeat(40)}`,
      data: "0xdeadbeef",
      value: "0",
    });

    await executeAndSubmitV2Action(ORDER, evmAction, { executors, recoveryKey: "r".repeat(64) });
    expect(executor).toHaveBeenCalledTimes(1);

    // Same action again (e.g. lost submit response): evidence replays, the
    // wallet never signs twice.
    await executeAndSubmitV2Action(ORDER, evmAction, { executors, recoveryKey: "r".repeat(64) });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledTimes(2);
    expect(submitMock.mock.calls[1][0].txHash).toBe(submitMock.mock.calls[0][0].txHash);
  });

  it("journals evidence before submit so a submit crash cannot lose it", async () => {
    submitMock.mockRejectedValueOnce(new Error("network down"));
    const executor = vi.fn().mockResolvedValue({ arkTxid: "arktx9" });
    const executors: SwapKitV2Executors = { arkade_send: executor };
    const sendAction = action("arkade_send", { to: "ark1dest", amountSats: 999 });

    await expect(
      executeAndSubmitV2Action(ORDER, sendAction, { executors, recoveryKey: "r".repeat(64) }),
    ).rejects.toThrow(/network down/);

    // Retry: executor must NOT run again; the journaled txid is re-submitted.
    submitMock.mockResolvedValueOnce(terminalView);
    await executeAndSubmitV2Action(ORDER, sendAction, { executors, recoveryKey: "r".repeat(64) });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls.at(-1)?.[0].txHash).toBe("arktx9");
  });

  it("refuses blocked actions", async () => {
    await expect(
      executeAndSubmitV2Action(ORDER, action("arkade_send", {}, { state: "blocked" }), {
        executors: { arkade_send: async () => ({ arkTxid: "x" }) },
        recoveryKey: "r".repeat(64),
      }),
    ).rejects.toThrow(/not ready/);
  });
});

describe("order loop", () => {
  it("drains ready actions then polls to terminal", async () => {
    const executor = vi.fn().mockResolvedValue({ txHash: `0x${"3".repeat(64)}` });
    const inFlight: SwapKitV2OrderView = {
      mode: "commit",
      orderId: ORDER,
      status: "IN_FLIGHT",
      actions: [],
    };
    submitMock.mockResolvedValueOnce(inFlight);
    statusMock.mockResolvedValueOnce(terminalView);

    const initial: SwapKitV2OrderView = {
      mode: "commit",
      orderId: ORDER,
      status: "AWAITING_ACTION",
      actions: [
        action("execute_evm_call", {
          chainId: 8453,
          to: `0x${"a".repeat(40)}`,
          data: "0xdeadbeef",
          value: "0",
        }),
      ],
    };
    const result = await runSwapKitV2OrderLoop(initial, ORDER, {
      executors: { execute_evm_call: executor },
      recoveryKey: "r".repeat(64),
      intervalMs: 1,
    });
    expect(result.status).toBe("COMPLETED");
    expect(executor).toHaveBeenCalledTimes(1);
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it("never signs a ready call past its deadline; the server expires the order", async () => {
    const executor = vi.fn().mockResolvedValue({ txHash: `0x${"3".repeat(64)}` });
    const stale = {
      ...action("execute_evm_call", {
        chainId: 8453,
        to: `0x${"a".repeat(40)}`,
        data: "0xa3443faa",
        value: "0",
      }),
      deadline: new Date(Date.now() - 1_000).toISOString(),
    };
    statusMock.mockResolvedValueOnce({
      mode: "commit",
      orderId: ORDER,
      status: "EXPIRED",
      actions: [],
    });
    const result = await runSwapKitV2OrderLoop(
      { mode: "commit", orderId: ORDER, status: "AWAITING_ACTION", actions: [stale] },
      ORDER,
      {
        executors: { execute_evm_call: executor },
        recoveryKey: "r".repeat(64),
        intervalMs: 60_000,
      },
    );
    expect(result.status).toBe("EXPIRED");
    expect(executor).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("fails closed immediately on an inexecutable ready action", async () => {
    const initial: SwapKitV2OrderView = {
      mode: "commit",
      orderId: ORDER,
      status: "AWAITING_ACTION",
      actions: [action("arkade_claim", {})],
    };
    await expect(
      runSwapKitV2OrderLoop(initial, ORDER, {
        executors: {},
        recoveryKey: "r".repeat(64),
        intervalMs: 1,
      }),
    ).rejects.toThrow(/arkade_claim/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  // The loop retries transient failures forever on purpose (nobody is watching
  // a committed order). A failure that REPEATING cannot fix is the opposite
  // case: spinning on it holds the order's loop claim and leaves the status pill
  // stuck on "Executing…" with no way for the user to intervene.
  describe("failures that must not be retried forever", () => {
    const readyView = (): SwapKitV2OrderView => ({
      mode: "commit",
      orderId: ORDER,
      status: "AWAITING_ACTION",
      actions: [
        action("execute_evm_call", {
          chainId: 8453,
          to: `0x${"a".repeat(40)}`,
          data: "0xdeadbeef",
          value: "0",
        }),
      ],
    });

    it("stops on a 4xx rejection of the bound request", async () => {
      const executor = vi.fn().mockResolvedValue({ txHash: `0x${"3".repeat(64)}` });
      submitMock.mockRejectedValue(
        new SwapKitV2Error("bound request rejected", { httpStatus: 400 }),
      );
      await expect(
        runSwapKitV2OrderLoop(readyView(), ORDER, {
          executors: { execute_evm_call: executor },
          recoveryKey: "r".repeat(64),
          intervalMs: 1,
        }),
      ).rejects.toThrow(/bound request rejected/);
    });

    it("stops rather than repeating an action that started without evidence", async () => {
      // The executor reached its broadcast boundary (marked STARTED) and then
      // failed — it may have sent. The dispatcher refuses to repeat it; the
      // user gets an actionable status instead of a spin.
      const executor = vi.fn(async (_req: unknown, ctx: { markStarted?: () => Promise<void> }) => {
        await ctx.markStarted?.();
        throw new Error("rpc dropped after broadcast");
      });
      // The post-boundary failure is transient to the loop, so it retries —
      // straight into the STARTED-without-evidence guard, which fails closed
      // without running the executor a second time.
      await expect(
        runSwapKitV2OrderLoop(readyView(), ORDER, {
          executors: { execute_evm_call: executor as never },
          recoveryKey: "r".repeat(64),
          intervalMs: 1,
        }),
      ).rejects.toThrow(/started without durable evidence/);
      expect(executor).toHaveBeenCalledTimes(1);
    });

    // #3 — a refusal BEFORE the boundary moved nothing: it must stop the loop
    // (no silent re-prompt) but leave NO marker, so an explicit Continue runs
    // the action again instead of hitting action_reconciliation_required.
    // Taner #4 — an aborted loop stops between steps and never runs another action.
    it("stops at the next step boundary once its signal is aborted", async () => {
      const controller = new AbortController();
      const executor = vi.fn();
      controller.abort();
      await expect(
        runSwapKitV2OrderLoop(readyView(), ORDER, {
          executors: { execute_evm_call: executor },
          recoveryKey: "r".repeat(64),
          intervalMs: 1,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/aborted/);
      expect(executor).not.toHaveBeenCalled();
    });

    it("wakes from a poll wait immediately on abort and never polls again", async () => {
      const controller = new AbortController();
      const waiting: SwapKitV2OrderView = {
        mode: "commit",
        orderId: ORDER,
        status: "IN_FLIGHT",
        actions: [],
      };
      statusMock.mockClear();
      const loop = runSwapKitV2OrderLoop(waiting, ORDER, {
        executors: {},
        recoveryKey: "r".repeat(64),
        intervalMs: 60_000,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 5);
      const started = Date.now();
      await expect(loop).rejects.toThrow(/aborted/);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(statusMock).not.toHaveBeenCalled();
    });

    it("leaves a pre-broadcast refusal re-runnable", async () => {
      const executor = vi.fn().mockRejectedValue(new Error("user cancelled signing"));
      await expect(
        runSwapKitV2OrderLoop(readyView(), ORDER, {
          executors: { execute_evm_call: executor },
          recoveryKey: "r".repeat(64),
          intervalMs: 1,
        }),
      ).rejects.toThrow(/user cancelled signing/);
      expect(executor).toHaveBeenCalledTimes(1);
      executor.mockClear();
      executor.mockRejectedValue(new Error("user cancelled signing"));
      await expect(
        runSwapKitV2OrderLoop(readyView(), ORDER, {
          executors: { execute_evm_call: executor },
          recoveryKey: "r".repeat(64),
          intervalMs: 1,
        }),
      ).rejects.toThrow(/user cancelled signing/);
      // Re-ran rather than being refused as "started without evidence".
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it("keeps waiting through a 5xx while polling — a funded order is never abandoned", async () => {
      const inFlight: SwapKitV2OrderView = {
        mode: "commit",
        orderId: ORDER,
        status: "IN_FLIGHT",
        actions: [],
      };
      statusMock
        .mockRejectedValueOnce(new SwapKitV2Error("gateway", { httpStatus: 503, retryable: true }))
        .mockRejectedValueOnce(new SwapKitV2Error("rate limited", { httpStatus: 429 }))
        .mockResolvedValueOnce(terminalView);
      const result = await runSwapKitV2OrderLoop(inFlight, ORDER, {
        executors: {},
        recoveryKey: "r".repeat(64),
        intervalMs: 1,
      });
      expect(result.status).toBe("COMPLETED");
      expect(statusMock).toHaveBeenCalledTimes(3);
    });
  });
});

describe("interrupted Arkade funding", () => {
  // A funding attempt that reached its send boundary and then died leaves a
  // STARTED marker with no evidence. Re-entering must NEVER fund a second time —
  // but it must still be allowed to RECONCILE, i.e. report the spend the first
  // attempt already made. Refusing outright stranded exactly those orders: a
  // funded lockup on chain and a server that was never told about it.
  it("re-enters an interrupted funding as reconciliation, never as a second send", async () => {
    const fund = vi
      .fn()
      .mockImplementationOnce(async (_req: unknown, ctx: { markStarted?: () => Promise<void> }) => {
        // Reached the irreversible boundary, then died before evidence.
        await ctx.markStarted?.();
        throw new Error("outpoint lookup interrupted");
      })
      .mockResolvedValueOnce({ arkTxid: "ark-tx-1", outpoint: { txid: "ab".repeat(32), vout: 1 } });
    const funding = action("arkade_intents_fund", {
      to: "ark1lockup",
      amountSats: 1003,
      asset: "BTC_ARKADE",
    });
    const options = { recoveryKey: "r".repeat(64), executors: { arkade_intents_fund: fund } };

    await expect(executeAndSubmitV2Action(ORDER, funding, options)).rejects.toThrow(
      /outpoint lookup interrupted/,
    );
    // The retry is ALLOWED through, and arrives flagged as a reconciliation so
    // the executor takes its reconcileOnly branch instead of funding again.
    await executeAndSubmitV2Action(ORDER, funding, options);

    expect(fund).toHaveBeenCalledTimes(2);
    expect(fund.mock.calls[0][1].previouslyStarted).toBe(false);
    expect(fund.mock.calls[1][1].previouslyStarted).toBe(true);
  });

  // The marker is what makes the above safe, so it must only appear once the
  // executor actually reached its send boundary. A refusal BEFORE that (bounds
  // check, dismissed passkey prompt) moved nothing and has to stay retryable.
  it("leaves no STARTED marker when the executor refused before sending", async () => {
    const fund = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("Lightning funding exceeds the accepted deposit."), {
          sentNothing: true,
        }),
      )
      .mockResolvedValueOnce({ arkTxid: "ark-tx-2", outpoint: { txid: "cd".repeat(32), vout: 0 } });
    const funding = action("arkade_intents_fund", {
      to: "ark1lockup",
      amountSats: 1003,
      asset: "BTC_ARKADE",
    });
    const options = { recoveryKey: "r".repeat(64), executors: { arkade_intents_fund: fund } };

    await expect(executeAndSubmitV2Action(ORDER, funding, options)).rejects.toThrow(
      /exceeds the accepted deposit/,
    );
    await executeAndSubmitV2Action(ORDER, funding, options);

    // Still a FIRST attempt: nothing was sent, so nothing was marked.
    expect(fund.mock.calls[1][1].previouslyStarted).toBe(false);
  });
});

describe("interrupted approve reconciliation", () => {
  it("re-runs a stale-started ERC20 approve the server still reports ready", async () => {
    // The stable→stable deadlock: the approve leg started (marker persisted)
    // but threw before journaling evidence, and the server still shows it
    // `ready`. A blind fail-closed would strand the swap behind an "action
    // required" that can never clear. An approve is idempotent (the signer
    // reads the live allowance), so the dispatcher must clear the stale mark
    // and re-run it — letting the swap simply continue when the user returns.
    const approveData = `0x095ea7b3${"0".repeat(128)}`;
    const approve = action("execute_evm_call", {
      chainId: 8453,
      to: `0x${"a".repeat(40)}`,
      data: approveData,
      value: "0",
    });
    const first = vi.fn().mockRejectedValue(new Error("user stepped away"));
    await expect(
      executeAndSubmitV2Action(ORDER, approve, {
        recoveryKey: "r".repeat(64),
        executors: { execute_evm_call: first },
      }),
    ).rejects.toThrow();

    // Second attempt: NOT refused. It re-executes the approve fresh.
    const second = vi.fn().mockResolvedValue({ txHash: "0xapprove" });
    const view = await executeAndSubmitV2Action(ORDER, approve, {
      recoveryKey: "r".repeat(64),
      executors: { execute_evm_call: second },
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][1].previouslyStarted).toBe(false);
    expect(view.orderId).toBe(ORDER);
  });
});
