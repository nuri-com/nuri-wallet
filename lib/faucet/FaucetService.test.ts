import { afterEach, describe, expect, it, vi } from "vitest";
import { FAUCET_RELAY_MAX_ATTEMPTS } from "../../config/constants";
import { WIREX_PROXY_BASE_URL } from "../../config/network";
import { dripBaseGas } from "./FaucetService";

const mockFetch = (impl: typeof fetch) => {
  vi.stubGlobal("fetch", impl);
};

describe("dripBaseGas", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns sent + txHash on faucet success", async () => {
    let calledUrl = "";
    let calledBody = "";
    mockFetch(async (url, init) => {
      calledUrl = String(url);
      calledBody = String(init?.body);
      return new Response(JSON.stringify({ ok: true, txHash: "0xabc", reason: null }), {
        status: 200,
      });
    });
    const result = await dripBaseGas("0x1111111111111111111111111111111111111111");
    expect(calledUrl).toBe(`${WIREX_PROXY_BASE_URL}/faucet/drip`);
    expect(JSON.parse(calledBody)).toEqual({
      beneficiary: "0x1111111111111111111111111111111111111111",
    });
    expect(result).toEqual({ sent: true, txHash: "0xabc", transient: false });
  });

  it("returns the refusal reason without throwing, and does not retry it", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, reason: "has_gas" }), { status: 200 });
    });
    const result = await dripBaseGas("0x1111111111111111111111111111111111111111");
    expect(result).toEqual({ sent: false, reason: "has_gas", transient: false });
    expect(calls).toBe(1);
  });

  it("fails open on network error after exhausting retries", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      throw new Error("network down");
    });
    const result = await dripBaseGas("0x1111111111111111111111111111111111111111");
    expect(result.sent).toBe(false);
    expect(result.reason).toContain("network down");
    // An unreachable relay never reached a verdict — callers must stay fail-open.
    expect(result.transient).toBe(true);
    expect(calls).toBe(FAUCET_RELAY_MAX_ATTEMPTS);
  });

  it("retries a 5xx relay fault and returns the eventual success", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls < 2) return new Response("upstream boom", { status: 502 });
      return new Response(JSON.stringify({ ok: true, txHash: "0xdef" }), { status: 200 });
    });
    const result = await dripBaseGas("0x1111111111111111111111111111111111111111");
    expect(result).toEqual({ sent: true, txHash: "0xdef", transient: false });
    expect(calls).toBe(2);
  });

  it("does not retry a 4xx the relay chose", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: false, reason: "already_claimed" }), {
        status: 403,
      });
    });
    const result = await dripBaseGas("0x1111111111111111111111111111111111111111");
    expect(result).toEqual({ sent: false, reason: "already_claimed", transient: false });
    expect(calls).toBe(1);
  });
});
