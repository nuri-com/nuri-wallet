import { describe, expect, it, vi } from "vitest";

// Real order data from production (the 7.69 EURC swap). The lockup address was
// created by the solver and funded with real sats, so a rebuild that does not
// reproduce it would refuse every real Arkade payment.
// App-internal modules only; the Arkade SDK stays REAL so the address math is genuine.
vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: { bitcoin: "" },
  errorWithId: vi.fn(),
  logWithId: vi.fn(),
}));
vi.mock("./SwapKitService", () => ({
  isTerminal: () => false,
  trackSwapKitSwap: vi.fn(),
  submitSwapKitWalletAction: vi.fn(),
  parseSwapActionTx: vi.fn(),
}));
vi.mock("../arkade/internal/browserApproval", () => ({ withOutgoingBrowserApproval: vi.fn() }));
vi.mock("../arkade/internal/lightningSendStore", () => ({
  getArkadeLightningSendOwnerKey: vi.fn(),
  listArkadeLightningSends: vi.fn(),
  deleteArkadeLightningSend: vi.fn(),
}));
vi.mock("../arkade/internal/swapIntents", () => ({ createArkadeServerSwapIntent: vi.fn() }));
vi.mock("./SwapKitArkadeIntentsRefundJournal", () => ({
  loadJournal: vi.fn(),
  journalEntry: vi.fn(),
}));
vi.mock("../arkade/internal/walletCache", () => ({ getOrCreateWallet: vi.fn() }));

import { parseLockupParams, rebuildLockupPkScript } from "./SwapKitArkadeIntentsActionService";

const LOCKUP_ADDRESS =
  "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameeu09rjkhkn9ke0nvv3lzat5ls8pvqvx9jagqule9wrk76dhsc78r3jjygf";
const LOCKUP_PARAMS = {
  solverPubkey: "66422c952f8dcb96e4d0c3f049cd1e265b8461b916d9913c65c2494b64b4e3ce",
  operatorPubkey: "8202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c",
  serverPubkey: "8202bebddeb1f7442803897a85eaf3ce9254d07df0172fc3725ab5f0d097779c",
  emulatorPubkey: "39c196415da47b26456a101daaa12ba9e445bfe153197f1e2b750bf40e52092e",
  senderPubkey: "3cc6758badef6752417b6969ba4bdc8983855563ab3693ebd3184d99e93a7330",
  receiverPkScript: "5120891ca8c55ddcbef6d7416148071c9690b59870c42507d52c76adfef0a9df3fa4",
  refundPkScript: "512089ff53871e84324693590a183d0e2193d19388411c6b76318b0ac8283caa9a93",
  paymentHash: "bf5c3df2d1c34603ee97a633f8d9c5f7d2899a27c91ffd3080e8845c659eaf71",
  claimDelay: 605184,
  refundLocktime: 1791552229,
  refundWithoutReceiverDelay: 1266176,
  shape: "timelockedRefund",
};

describe("covenant rebuild against a real funded order", () => {
  it("reproduces the real lockup address", () => {
    expect(rebuildLockupPkScript(parseLockupParams(LOCKUP_PARAMS), LOCKUP_ADDRESS)).not.toBeNull();
  });

  it("fails without the solver's delay (the bug this fixes)", () => {
    const { refundWithoutReceiverDelay: _drop, ...nine } = LOCKUP_PARAMS;
    expect(rebuildLockupPkScript(parseLockupParams(nine), LOCKUP_ADDRESS)).toBeNull();
  });

  it("refuses a different address", () => {
    const other =
      "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameez0l2wr3appjg6f4jzsc858zry73jwyyz8rtwccckzkg9q724x5ns6hhuc";
    expect(rebuildLockupPkScript(parseLockupParams(LOCKUP_PARAMS), other)).toBeNull();
  });
});
