import { p256 } from "@noble/curves/nist";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitSignedApproval } from "./bridgeCallback";

const SESSION_ID = "session_12345678";
const STATE = "state_12345678";
const CALLBACK = `https://banking.nuri.com/mcp/api/browser-sessions/${SESSION_ID}/callback`;
const CLIENT_PUBLIC_KEY = Buffer.from(
  p256.getPublicKey(
    Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0)),
    false,
  ),
).toString("base64url");

function approvalUrl(message?: string): string {
  const url = new URL("https://banking.nuri.com/mcp/bridge");
  url.searchParams.set("session_id", SESSION_ID);
  url.searchParams.set("state", STATE);
  url.searchParams.set("intent", "auth");
  url.searchParams.set("callback", CALLBACK);
  url.searchParams.set("client_pubkey", CLIENT_PUBLIC_KEY);
  if (message) url.searchParams.set("msg", Buffer.from(message).toString("base64url"));
  return url.toString();
}

function signer() {
  return vi.fn(async () => ({
    address: `0x${"11".repeat(20)}`,
    signature: `0x${"22".repeat(65)}`,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("submitSignedApproval", () => {
  it("loads sign_text from the current session approval endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, sign_text: "Reveal card details" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sign = signer();

    await submitSignedApproval({ approvalUrl: approvalUrl(), sign });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://banking.nuri.com/mcp/api/browser-sessions/${SESSION_ID}/approval?state=${STATE}`,
    );
    expect(sign).toHaveBeenCalledWith({ message: "Reveal card details" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(CALLBACK);
  });

  it("keeps accepting the previous inline msg contract", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sign = signer();

    await submitSignedApproval({ approvalUrl: approvalUrl("Legacy approval"), sign });

    expect(sign).toHaveBeenCalledWith({ message: "Legacy approval" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CALLBACK);
  });
});
