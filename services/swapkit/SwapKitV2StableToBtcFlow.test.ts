// Euro → Bitcoin over LI.FI, end to end on the wallet side, against the commit
// the server returns today (live LI.FI route `relaydepository`, captured from
// the engine without creating an order). Everything real except the network
// and the keys: the stable→BTC flow, the tracker, the action loop, the
// executors, the route binding and the EVM signer.
//
// What the user saw: the move turned into "Action required" with a Continue
// button, and only the approval ever reached the chain. The wallet signed the
// approval, then refused the Relay deposit call because the route binding only
// knew LI.FI's LayerSwap bridge. Accepting a quote must run BOTH steps on their
// own: the approval, then the swap.
import { beforeEach, expect, it, vi } from "vitest";
import commit from "./__fixtures__/lifi-eurc-btc-commit.json";

const OWNER = "0x00993cA379abd3F6c79E439c54a1AB2e7c95234B";
const cache = new Map<string, unknown>();
const m = vi.hoisted(() => ({
  commit: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  call: vi.fn(),
  estimateGas: vi.fn(),
  send: vi.fn(),
  receipt: vi.fn(),
  emit: vi.fn(),
}));
vi.mock("../balance/TransactionCacheService", () => ({
  getCacheValue: async (key: string) => cache.get(key) ?? null,
  setCacheValue: async (key: string, value: unknown) => {
    cache.set(key, value);
  },
}));
vi.mock("./SwapKitV2Service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SwapKitV2Service")>()),
  commitSwapKitV2: m.commit,
  submitSwapKitV2Evidence: m.submit,
  getSwapKitV2Status: m.status,
  cancelSwapKitV2Order: m.cancel,
}));
vi.mock("./SwapKitV2RecoveryKey", () => ({ getSwapKitV2RecoveryKey: async () => "k".repeat(64) }));
vi.mock("../events/AppEventBusService", () => ({ EventBus: { emit: m.emit, on: () => () => {} } }));
vi.mock("../../lib/secureKeyStorage", () => ({
  getPrivateKey: async () => new Uint8Array(32).fill(1),
  getEthereumAddress: async () => OWNER,
}));
vi.mock("viem/accounts", () => ({ privateKeyToAccount: () => ({ address: OWNER }) }));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({
    call: m.call,
    estimateGas: m.estimateGas,
    waitForTransactionReceipt: m.receipt,
  }),
  createWalletClient: () => ({ sendTransaction: m.send }),
}));
vi.mock("../../lib/rpc/baseRpc", () => ({ getBaseViemTransport: () => ({}) }));
vi.mock("../../lib/rpc/chainRpc", () => ({ getChainRpcUrl: () => "" }));
vi.mock("../arkade/ArkadeLightningSendService", () => ({ payArkadeLightningInvoice: vi.fn() }));
vi.mock("../arkade/ArkadeSendService", () => ({
  sendArkadeToArk: vi.fn(),
  fundArkadeIntentsOutpoint: vi.fn(),
}));
vi.mock("../bitcoin/ownDestinations", () => ({
  ownBitcoinDestinations: async (): Promise<{ arkade: null; onchain: null }> => ({
    arkade: null,
    onchain: null,
  }),
}));
vi.mock("../arkade/ArkadeAddressService", () => ({ getArkadeReceiveAddress: vi.fn() }));
vi.mock("./SwapKitHtlcKeyService", () => ({ deriveSwapKitHtlcMaterial: vi.fn() }));
vi.mock("./SwapKitHtlcSecretService", () => ({ materializeSwapKitHtlcPreimage: vi.fn() }));
vi.mock("./SwapKitArkadeVhtlcService", () => ({ claimSwapKitArkadeVhtlc: vi.fn() }));
vi.mock("./SwapKitHtlcActionService", () => ({ executeSwapKitHtlcAction: vi.fn() }));
vi.mock("./SwapKitArkadeIntentsActionService", () => ({
  parseLockupParams: vi.fn(),
  refundArkadeIntentsLockup: vi.fn(),
  deriveArkadeIntentsRefundMaterial: vi.fn(),
  isArkadeIntentsRefundKeyRef: vi.fn(),
}));
vi.mock("./SwapKitDirectEvmSwapService", () => ({ DIRECT_SWAP_SETTLED_EVENT: "settled" }));
vi.mock("./SwapKitV2MoveAccounting", () => ({ applyV2TerminalBalances: vi.fn() }));
vi.mock("./SwapKitV2BtcToStableService", () => ({ buildBtcToStableExecutorsFromSpec: vi.fn() }));
vi.mock("./SwapKitV2SweepService", () => ({ makeSweepV2ExecutorsFor: vi.fn() }));
vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));

import { getV2Move } from "./SwapKitV2MoveStatus";
import { executeV2StableToBtc } from "./SwapKitV2StableToBtcService";

const [approval, relaySwap] = commit.actions;

beforeEach(() => {
  cache.clear();
  // The captured commit is signed within its quote's validity (its actions'
  // deadline); pin the clock inside that window.
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(relaySwap.deadline) - 30_000 });
  m.call.mockResolvedValue({ data: `0x${"0".repeat(64)}` });
  m.estimateGas.mockResolvedValue(100_000n);
  m.send.mockResolvedValue(`0x${"ab".repeat(32)}`);
  m.receipt.mockResolvedValue({ status: "success" });
  m.commit.mockResolvedValue(commit);
  // Submitting the approval promotes the Relay call to ready, as the server
  // does; submitting the Relay call leaves the order in flight at the provider.
  m.submit.mockImplementation(async ({ actionId }: { actionId: string }) =>
    actionId === approval.actionId
      ? { ...commit, actions: [{ ...relaySwap, state: "ready", blockedReason: null }] }
      : { ...commit, status: "PROCESSING", actions: [] },
  );
  m.status.mockResolvedValue({ ...commit, status: "PROCESSING", actions: [] });
  m.cancel.mockResolvedValue({ ...commit, status: "EXPIRED", actions: [] });
});

it("signs the approval and then the LI.FI swap on its own — nothing is left for the user", async () => {
  const accepted = commit.accepted;
  await executeV2StableToBtc({
    fromAsset: "EURC_BASE",
    to: "BTC",
    amount: Number(accepted.acceptedDepositAmount),
    side: "deposit",
    optionId: commit.accepted.optionId ?? "lifi:lifi:EURC_BASE->BTC",
    quotedDeposit: Number(accepted.acceptedDepositAmount),
    quotedReceive: Number(accepted.minimumSettleAmount),
    owner: OWNER,
    settleTarget: accepted.settleTarget,
  });
  await vi.waitFor(() => expect(m.send).toHaveBeenCalledTimes(2));

  // Approval first, then the Relay deposit call itself, both with no tap.
  expect(String(m.send.mock.calls[0][0].data)).toBe(approval.request.data);
  expect(String(m.send.mock.calls[1][0].data)).toBe(relaySwap.request.data);
  expect(m.submit.mock.calls.map((c) => c[0].actionId)).toEqual([
    approval.actionId,
    relaySwap.actionId,
  ]);
  expect(m.cancel).not.toHaveBeenCalled();
  expect(getV2Move(commit.orderId)?.phase).not.toBe("action_required");
});
