import { beforeEach, describe, expect, it, vi } from "vitest";

const getReceiveAddress = vi.fn();
const getMusig2SendSource = vi.fn();
const getMusig2DescriptorCredId = vi.fn();
let currentCredId: string | null = "cred-a";

vi.mock("./providers/registry", () => ({
  getBtcL2Provider: () => ({ getReceiveAddress }),
}));
vi.mock("../auth/walletCredential", () => ({
  currentWalletCredId: () => currentCredId,
}));
// WalletService cannot be imported under Vitest (the repo mocks it, as BitcoinBalanceService.test.ts
// does); what matters here is the contract of the accessor over its values.
vi.mock("./WalletService", () => ({
  walletService: { getMusig2SendSource, getMusig2DescriptorCredId },
}));

const { getBitcoinOnchainSendAddress, getBitcoinReceiveAddress } = await import(
  "./BitcoinAddressService"
);

describe("BitcoinAddressService", () => {
  beforeEach(() => {
    getReceiveAddress.mockReset();
    getMusig2SendSource.mockReset();
    getMusig2DescriptorCredId.mockReset();
    currentCredId = "cred-a";
  });

  it("returns the provider's receive address", async () => {
    getReceiveAddress.mockResolvedValue("bc1pboarding");

    await expect(getBitcoinReceiveAddress()).resolves.toBe("bc1pboarding");
  });

  it("returns the send source the on-chain wallet will fund from", () => {
    getMusig2DescriptorCredId.mockReturnValue("cred-a");
    getMusig2SendSource.mockReturnValue({ address: "bc1psend" });

    expect(getBitcoinOnchainSendAddress()).toBe("bc1psend");
  });

  // The descriptor survives an in-app account switch, so the value is only usable while it belongs to
  // the credential that is loaded now. Empty is the fail-closed answer: an on-chain move is refused
  // instead of being bound to the previous account's address.
  it("returns empty when the descriptor belongs to another credential", () => {
    getMusig2DescriptorCredId.mockReturnValue("cred-previous");
    getMusig2SendSource.mockReturnValue({ address: "bc1ppreviousaccount" });

    expect(getBitcoinOnchainSendAddress()).toBe("");
    expect(getMusig2SendSource).not.toHaveBeenCalled();
  });

  it("returns empty when the descriptor is unbound", () => {
    getMusig2DescriptorCredId.mockReturnValue(null);
    getMusig2SendSource.mockReturnValue({ address: "bc1pstale" });

    expect(getBitcoinOnchainSendAddress()).toBe("");
  });

  it("returns empty when the loaded credential is not known yet", () => {
    currentCredId = null;
    getMusig2DescriptorCredId.mockReturnValue("cred-a");
    getMusig2SendSource.mockReturnValue({ address: "bc1psend" });

    expect(getBitcoinOnchainSendAddress()).toBe("");
  });

  it("returns empty when there is no send source at all", () => {
    getMusig2DescriptorCredId.mockReturnValue("cred-a");
    getMusig2SendSource.mockReturnValue(null);

    expect(getBitcoinOnchainSendAddress()).toBe("");
  });
});
