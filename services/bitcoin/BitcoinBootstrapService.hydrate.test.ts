import { beforeEach, describe, expect, it, vi } from "vitest";

// The MuSig2 descriptor belongs to the identity whose keys it was derived from. Resolving those keys
// is async (co-signer context), and an in-app login can replace the identity while it is in flight, so
// the install has to be tied to the identity it started under — otherwise the previous account's
// descriptor lands in the singleton and is bound as if it were the new account's.

const USER_PUBKEY = `02${"a".repeat(64)}`;
const AGGREGATED = "b".repeat(64);

let currentCredId: string | null = "cred-a";
let identityEpoch = 7;

vi.mock("../auth/walletCredential", () => ({
  currentWalletCredId: () => currentCredId,
}));

const walletService = {
  generateNewAddress: vi.fn(async () => ""),
  getAddressGeneration: vi.fn(() => 3),
  getIdentityEpoch: vi.fn(() => identityEpoch),
  resetAddressState: vi.fn(() => {
    identityEpoch += 1;
  }),
  setMusig2Address: vi.fn(),
  createWallet: vi.fn(async () => {}),
  getNewAddress: vi.fn(async () => "bc1phydrated"),
};
vi.mock("./WalletService", () => ({ walletService }));

const resolveArkadeMusig2WalletKeys = vi.fn();
vi.mock("./Musig2WalletKeys", () => ({ resolveArkadeMusig2WalletKeys }));

vi.mock("./BitcoinBalanceStore", () => ({
  bitcoinBalanceStore: { refresh: vi.fn(async () => {}) },
}));
vi.mock("../arkade/ArkadeLnurlService", () => ({
  hydrateArkadeLnurlStatus: vi.fn(async () => {}),
  resetArkadeLnurlCache: vi.fn(),
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  clearArkadeBoardingAddressCache: vi.fn(async () => {}),
}));

const { hydrateMusig2Address } = await import("./BitcoinBootstrapService");

function keys(credId: string) {
  return {
    userCompressed: USER_PUBKEY,
    aggregatedXonly32: AGGREGATED,
    csvTimelock: { type: "seconds" as const, value: 6674432 },
    credId,
  };
}

describe("hydrateMusig2Address", () => {
  beforeEach(() => {
    currentCredId = "cred-a";
    identityEpoch = 7;
    for (const fn of [
      walletService.generateNewAddress,
      walletService.getAddressGeneration,
      walletService.getIdentityEpoch,
      walletService.resetAddressState,
      walletService.setMusig2Address,
      walletService.createWallet,
      walletService.getNewAddress,
      resolveArkadeMusig2WalletKeys,
    ]) {
      fn.mockClear();
    }
    walletService.getIdentityEpoch.mockImplementation(() => identityEpoch);
    walletService.getAddressGeneration.mockReturnValue(3);
    walletService.setMusig2Address.mockClear();
  });

  it("installs the wallet for the identity whose keys resolved", async () => {
    resolveArkadeMusig2WalletKeys.mockResolvedValue(keys("cred-a"));

    await hydrateMusig2Address();

    expect(walletService.createWallet).toHaveBeenCalledTimes(1);
    expect(walletService.createWallet).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.any(String),
      expect.any(String),
      { credId: "cred-a", epoch: 7 },
    );
    expect(walletService.setMusig2Address).toHaveBeenCalledTimes(1);
  });

  // The race: the keys of the account being replaced land after the new account is loaded.
  it("discards an install whose identity was replaced while its keys were resolving", async () => {
    let release: (value: unknown) => void = () => {};
    resolveArkadeMusig2WalletKeys.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const hydrate = hydrateMusig2Address();
    await Promise.resolve();

    // Account replaced: state reset (epoch bumped) and a different credential loaded.
    currentCredId = "cred-b";
    walletService.resetAddressState();
    release(keys("cred-a"));

    await hydrate;

    expect(walletService.createWallet).not.toHaveBeenCalled();
    expect(walletService.setMusig2Address).not.toHaveBeenCalled();
  });

  // Same window, but the keys belong to the credential that is loaded now: the install is legitimate
  // even though the epoch moved (the identity did not change).
  it("installs the keys of the loaded credential after a reset", async () => {
    resolveArkadeMusig2WalletKeys.mockResolvedValue(keys("cred-b"));
    currentCredId = "cred-b";
    walletService.resetAddressState();

    await hydrateMusig2Address();

    expect(walletService.createWallet).toHaveBeenCalledTimes(1);
    expect(walletService.createWallet).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Number),
      expect.any(String),
      expect.any(String),
      { credId: "cred-b", epoch: 8 },
    );
  });

  // The snapshot the keys came from is not the one this run started with (the credential moved while
  // the co-signer context was being resolved), so neither the descriptor nor the address may land.
  it("discards keys that belong to another credential", async () => {
    resolveArkadeMusig2WalletKeys.mockResolvedValue(keys("cred-other"));

    await hydrateMusig2Address();

    expect(walletService.createWallet).not.toHaveBeenCalled();
    expect(walletService.setMusig2Address).not.toHaveBeenCalled();
  });

  it("installs nothing when the keys cannot be resolved", async () => {
    resolveArkadeMusig2WalletKeys.mockResolvedValue(null);

    await hydrateMusig2Address();

    expect(walletService.createWallet).not.toHaveBeenCalled();
    expect(walletService.setMusig2Address).not.toHaveBeenCalled();
  });
});
