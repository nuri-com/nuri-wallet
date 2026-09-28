import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  emit: vi.fn(),
  persistUsername: vi.fn().mockResolvedValue(undefined),
  write: vi.fn(),
}));

vi.mock("../../lib/accountEmail", () => ({ getAccountEmail: vi.fn() }));
vi.mock("../../lib/secureKeyStorage", () => ({
  getBitcoinAddress: vi.fn(),
  getEthereumAddress: vi.fn(),
}));
vi.mock("../auth/AuthStateService", () => ({
  authStateManager: { setWalletUsername: calls.persistUsername },
}));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: calls.emit } }));
vi.mock("./ArkadeApiService", () => ({
  arkadeLnurlRegister: vi.fn(),
  arkadeLnurlSetProfile: vi.fn(),
  arkadeLnurlStatus: vi.fn(),
}));
vi.mock("./ArkadeWalletService", () => ({
  getArkadeWalletSummarySnapshot: vi.fn(),
  getLastGoodArkadeWalletSummarySnapshot: vi.fn(),
}));
vi.mock("./internal/identity", () => ({
  getArkadeLnurlAssertion: vi.fn(),
  getOrCreateArkadeIdentity: vi.fn(),
}));
vi.mock("./internal/logging", () => ({ emitTrace: vi.fn() }));
vi.mock("./internal/lnurlStatusCache", () => ({
  getArkadeLnurlStatusSnapshot: vi.fn(),
  readCachedLnurlStatus: vi.fn(),
  resetArkadeLnurlCache: vi.fn(),
  toLnurlStatus: (response: Record<string, unknown>) => ({
    username: response.username,
    registered: response.registered,
    lightningAddress: response.lightning_address,
  }),
  writeCachedLnurlStatus: calls.write,
}));

import { cacheArkadeLnurlRegistration } from "./ArkadeLnurlService";

describe("bootstrap username registration cache", () => {
  it("persists and emits the claimed username without another assertion", () => {
    const status = cacheArkadeLnurlRegistration({
      username: "emino",
      lightning_address: "emino@nuri.com",
    });

    expect(status).toMatchObject({
      username: "emino",
      registered: true,
      lightningAddress: "emino@nuri.com",
    });
    expect(calls.write).toHaveBeenCalledWith(status);
    expect(calls.persistUsername).toHaveBeenCalledWith("emino");
    expect(calls.emit).toHaveBeenCalledWith("arkade:lnurl:status", status);
  });
});
