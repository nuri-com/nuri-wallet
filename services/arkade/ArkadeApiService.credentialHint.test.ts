import { afterEach, describe, expect, it, vi } from "vitest";
import { arkadeCredentialHintOrNull } from "./ArkadeApiService";

afterEach(() => vi.unstubAllGlobals());

describe("arkadeCredentialHintOrNull", () => {
  it("treats only 404 as an available username", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(arkadeCredentialHintOrNull("free.name")).resolves.toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    await expect(arkadeCredentialHintOrNull("free.name")).rejects.toThrow("http_503");
  });

  it("returns the exact existing credential", async () => {
    const hint = { username: "emino", credential_id_b64u: "credential" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(hint), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(arkadeCredentialHintOrNull("emino")).resolves.toEqual(hint);
  });
});
