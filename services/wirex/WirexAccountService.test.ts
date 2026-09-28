import { beforeEach, describe, expect, it, vi } from "vitest";

const WALLET = "0x1111111111111111111111111111111111111111";

const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getAuthData: vi.fn(),
  storeAuthData: vi.fn(),
  deleteAuthData: vi.fn(),
  getStatus: vi.fn(),
  getWallet: vi.fn(),
  issueVirtualCard: vi.fn(),
  closeCard: vi.fn(),
  getRates: vi.fn(),
  setCachedBalance: vi.fn(),
  getCachedBalance: vi.fn(),
  clearCachedBalance: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
  getAuthData: mocks.getAuthData,
  storeAuthData: mocks.storeAuthData,
  deleteAuthData: mocks.deleteAuthData,
}));
vi.mock("./WirexService", () => ({
  wirexService: {
    getStatus: mocks.getStatus,
    getWallet: mocks.getWallet,
    issueVirtualCard: mocks.issueVirtualCard,
    closeCard: mocks.closeCard,
  },
}));
vi.mock("../pricing/FxRateService", () => ({
  fxRateService: { getRates: mocks.getRates, convert: (amount: number) => amount },
}));
vi.mock("../balance/BalanceCacheService", () => ({
  BALANCE_CACHE_KEYS: { card: "@cache:cardBalance" },
  setCachedBalance: mocks.setCachedBalance,
  getCachedBalance: mocks.getCachedBalance,
  clearCachedBalance: mocks.clearCachedBalance,
}));
vi.mock("../events/AppEventBusService", () => ({
  EventBus: { on: mocks.on, emit: mocks.emit },
}));
vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: { card: "💳", error: "❌" },
  logWithId: vi.fn(),
  errorWithId: vi.fn(),
}));

import { isAwaitingReplacementCard } from "../../lib/wirex/cardState";
import {
  __flushWirexSnapshotWritesForTests,
  WIREX_VERIFICATION_APPROVED_EVENT,
  wirexAccountService,
} from "./WirexAccountService";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const statusFor = (cardId: string) => ({
  verificationStatus: "Approved",
  cards: [{ id: cardId, status: "Active", last4: "1234" }],
  bankAccounts: [] as unknown[],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEthereumAddress.mockResolvedValue(WALLET);
  mocks.getAuthData.mockResolvedValue(null);
  mocks.storeAuthData.mockResolvedValue(undefined);
  mocks.deleteAuthData.mockResolvedValue(undefined);
  mocks.getRates.mockResolvedValue({ EUR: 1, USD: 1 });
  mocks.getWallet.mockResolvedValue({ walletAddress: WALLET, balances: [] });
  mocks.getCachedBalance.mockResolvedValue(null);
  mocks.clearCachedBalance.mockResolvedValue(undefined);
  // After the mocks are armed: reset() writes through deleteAuthData.
  wirexAccountService.reset();
});

describe("WirexAccountService snapshot ageing", () => {
  it("keeps the original age when a poll adds nothing to the cached snapshot", async () => {
    const complete = {
      verificationStatus: "Approved",
      cards: [{ id: "card-1", status: "Active", last4: "1234" }],
      bankAccounts: [] as unknown[],
    };
    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "10" }],
    });
    mocks.getStatus.mockResolvedValueOnce(complete);
    await wirexAccountService.silentRefresh(true);

    const firstPersist = mocks.storeAuthData.mock.calls.at(-1)?.[1];
    const firstAt = JSON.parse(String(firstPersist)).at;

    // Card gone but still approved: the merge keeps the prior complete snapshot,
    // so re-stamping it would renew stale data past the seven-day expiry.
    mocks.getStatus.mockResolvedValueOnce({ ...complete, cards: [] });
    await wirexAccountService.silentRefresh(true);

    const secondPersist = mocks.storeAuthData.mock.calls.at(-1)?.[1];
    expect(JSON.parse(String(secondPersist)).at).toBe(firstAt);
  });
});

describe("WirexAccountService closed cards", () => {
  const withBalance = { walletAddress: WALLET, balances: [{ tokenSymbol: "WEUR", balance: "10" }] };

  it("drops the card the user just closed instead of preserving it", async () => {
    // /status keeps returning a closed card forever. Filtered out, the response
    // looks approved-but-cardless — the same shape as an incomplete read — so
    // the merge used to keep the previous complete snapshot and the closed card
    // stayed in the carousel for good.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusFor("card-only"));
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.getSnapshot().cards).toHaveLength(1);

    mocks.getStatus.mockResolvedValueOnce({
      verificationStatus: "Approved",
      cards: [{ id: "card-only", status: "Closed", last4: "1234" }],
      bankAccounts: [] as unknown[],
    });
    await wirexAccountService.silentRefresh(true);

    expect(wirexAccountService.getSnapshot().cards).toEqual([]);
    expect(wirexAccountService.getSnapshot().card).toBeNull();
  });

  it("still keeps a complete snapshot when a read simply arrives without cards", async () => {
    // No cards listed at all is a gap, not a statement — the old behaviour has
    // to survive, or a blip drops an onboarded user's card off the screen.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusFor("card-kept"));
    await wirexAccountService.silentRefresh(true);

    mocks.getStatus.mockResolvedValueOnce({
      verificationStatus: "Approved",
      cards: [] as unknown[],
      bankAccounts: [] as unknown[],
    });
    await wirexAccountService.silentRefresh(true);

    expect(wirexAccountService.getSnapshot().card?.id).toBe("card-kept");
  });
});

describe("WirexAccountService card action reconciliation", () => {
  const withBalance = { walletAddress: WALLET, balances: [{ tokenSymbol: "WEUR", balance: "10" }] };
  const statusWithCards = (...ids: string[]) => ({
    verificationStatus: "Approved",
    cards: ids.map((id) => ({ id, status: "Active", last4: "1234" })),
    bankAccounts: [] as unknown[],
  });

  it("reports success when a failed issue turns out to have created the card", async () => {
    // Replay protection is per signature, so a re-armed CTA would sign a fresh
    // request and issue a SECOND card.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);

    mocks.issueVirtualCard.mockRejectedValueOnce(new Error("gateway timeout"));
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1", "card-2"));

    await expect(wirexAccountService.issueVirtualCard()).resolves.toBe(true);
    expect(wirexAccountService.getSnapshot().cards).toHaveLength(2);
  });

  it("reconciles with a read that started after the failed issuance", async () => {
    // A poll already open when issuance runs began before the card existed, so
    // joining it could never observe the card — and reporting that as a failure
    // re-arms the CTA for a second signed request.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);

    const slow = deferred<ReturnType<typeof statusWithCards>>();
    mocks.getStatus.mockReturnValueOnce(slow.promise);
    const poll = wirexAccountService.silentRefresh(true);
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));

    mocks.issueVirtualCard.mockRejectedValueOnce(new Error("gateway timeout"));
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1", "card-2"));
    const issue = wirexAccountService.issueVirtualCard();
    slow.resolve(statusWithCards("card-1"));
    await poll;

    await expect(issue).resolves.toBe(true);
    expect(mocks.getStatus).toHaveBeenCalledTimes(3);
    expect(wirexAccountService.issueUnresolved).toBe(false);
  });

  it("withholds a retry when the reconciling read could not answer", async () => {
    // /status failing leaves the outcome unknown. Re-arming the CTA on a guess
    // is the one path that costs the user a second card.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);

    mocks.issueVirtualCard.mockRejectedValueOnce(new Error("gateway timeout"));
    mocks.getStatus.mockRejectedValueOnce(new Error("status unavailable"));

    await expect(wirexAccountService.issueVirtualCard()).resolves.toBe(false);
    expect(wirexAccountService.issueUnresolved).toBe(true);

    // A later completed load settles it, so the CTA comes back.
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.issueUnresolved).toBe(false);
  });

  it("reads afresh after a successful issue too", async () => {
    // The success path had the same defect: joining a read that started before
    // the request closes the sheet over a carousel without the new card, and the
    // next tap in there signs a second issuance.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);

    const slow = deferred<ReturnType<typeof statusWithCards>>();
    mocks.getStatus.mockReturnValueOnce(slow.promise);
    const poll = wirexAccountService.silentRefresh(true);
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalledTimes(2));

    mocks.issueVirtualCard.mockResolvedValueOnce(undefined);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1", "card-2"));
    const issue = wirexAccountService.issueVirtualCard();
    slow.resolve(statusWithCards("card-1"));
    await poll;

    await expect(issue).resolves.toBe(true);
    expect(mocks.getStatus).toHaveBeenCalledTimes(3);
    expect(wirexAccountService.getSnapshot().cards).toHaveLength(2);
    expect(wirexAccountService.issueUnresolved).toBe(false);
  });

  it("withholds a retry when a successful issue is not visible afterwards", async () => {
    // The card was issued; nothing here can show it. Re-arming the CTA on that
    // is how a second card gets signed for.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);

    mocks.issueVirtualCard.mockResolvedValueOnce(undefined);
    mocks.getStatus.mockRejectedValueOnce(new Error("status unavailable"));

    await expect(wirexAccountService.issueVirtualCard()).resolves.toBe(true);
    expect(wirexAccountService.issueUnresolved).toBe(true);
  });

  it("keeps the retry withheld when the next poll is served from the status cache", async () => {
    // The card tab polls unforced, so `load()` can answer from the 60s status
    // cache that predates the issuance. Clearing the flag on that re-arms the
    // CTA with no server observation at all, and the next tap signs a second
    // request — a duplicate card for a request that may well have succeeded.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);

    mocks.issueVirtualCard.mockResolvedValueOnce(undefined);
    mocks.getStatus.mockRejectedValueOnce(new Error("status unavailable"));
    await wirexAccountService.issueVirtualCard();
    expect(wirexAccountService.issueUnresolved).toBe(true);

    const callsBeforePoll = mocks.getStatus.mock.calls.length;
    await wirexAccountService.silentRefresh(false);
    // Nothing was asked of the server, so nothing was learned.
    expect(mocks.getStatus).toHaveBeenCalledTimes(callsBeforePoll);
    expect(wirexAccountService.issueUnresolved).toBe(true);

    // A read that actually reaches the server settles it.
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1", "card-2"));
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.issueUnresolved).toBe(false);
  });

  it("reports a failed issue as failed when no card appeared", async () => {
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));
    await wirexAccountService.silentRefresh(true);

    mocks.issueVirtualCard.mockRejectedValueOnce(new Error("rejected"));
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));

    await expect(wirexAccountService.issueVirtualCard()).resolves.toBe(false);
  });

  it("reports success when a failed close turns out to have closed the card", async () => {
    // Otherwise the user is sent to confirm an irreversible action that already
    // happened.
    mocks.getWallet.mockResolvedValue(withBalance);
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1", "card-2"));
    await wirexAccountService.silentRefresh(true);

    mocks.closeCard.mockRejectedValueOnce(new Error("gateway timeout"));
    mocks.getStatus.mockResolvedValueOnce(statusWithCards("card-1"));

    await expect(wirexAccountService.closeCard("card-2", "1234")).resolves.toBe(true);
  });
});

describe("WirexAccountService snapshot persistence ordering", () => {
  // Arm a persist whose Keychain write stays open, and settle the teardown
  // delete queued behind it. Both tests start from a quiet queue.
  const persistWithOpenWrite = async () => {
    await __flushWirexSnapshotWritesForTests();
    mocks.deleteAuthData.mockClear();
    mocks.storeAuthData.mockClear();

    const write = deferred<void>();
    mocks.storeAuthData.mockReturnValue(write.promise);
    mocks.getStatus.mockResolvedValue(statusFor("card-previous"));
    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "10" }],
    });

    await wirexAccountService.silentRefresh(true);
    await vi.waitFor(() => expect(mocks.storeAuthData).toHaveBeenCalledTimes(1));
    return write;
  };

  it("deletes the snapshot after a write that was still open when reset landed", async () => {
    const write = await persistWithOpenWrite();

    // Sign-out lands while the Keychain write is in flight. Unordered, that
    // write could settle after the delete and put the card back on disk.
    wirexAccountService.reset();
    expect(mocks.deleteAuthData).not.toHaveBeenCalled();

    write.resolve();
    await __flushWirexSnapshotWritesForTests();

    expect(mocks.deleteAuthData).toHaveBeenCalledTimes(1);
    expect(mocks.storeAuthData).toHaveBeenCalledTimes(1);
  });

  it("drops a snapshot write that was still queued when reset landed", async () => {
    const write = await persistWithOpenWrite();

    // A second load finishes while the first write still holds the queue.
    await wirexAccountService.silentRefresh(true);
    wirexAccountService.reset();
    write.resolve();
    await __flushWirexSnapshotWritesForTests();

    // The queued write belongs to the wallet that just signed out.
    expect(mocks.storeAuthData).toHaveBeenCalledTimes(1);
    expect(mocks.deleteAuthData).toHaveBeenCalledTimes(1);
  });
});

describe("WirexAccountService bootstrap invalidation", () => {
  it("does not publish a restored snapshot after reset invalidated the bootstrap", async () => {
    const keychain = deferred<string>();
    mocks.getAuthData.mockReturnValueOnce(keychain.promise);
    mocks.getStatus.mockResolvedValue(statusFor("card-live"));

    wirexAccountService.ensureStarted();
    await vi.waitFor(() => expect(mocks.getAuthData).toHaveBeenCalled());

    // Sign-out lands while the Keychain read is still open.
    wirexAccountService.reset();

    keychain.resolve(
      JSON.stringify({
        wallet: WALLET,
        at: Date.now(),
        value: {
          ...statusFor("card-previous"),
          isApproved: true,
          card: { id: "card-previous", status: "Active", last4: "9999" },
          balanceEur: 42,
          smartAccountAddress: WALLET,
          wallet: WALLET,
        },
      }),
    );
    await vi.waitFor(() => expect(mocks.getAuthData).toHaveBeenCalled());

    // The previous wallet's card must never reach the new session.
    expect(wirexAccountService.getSnapshot().card?.id).toBeUndefined();
  });
});

describe("WirexAccountService reset during a running load", () => {
  it("does not publish the previous wallet's account after a reset mid-load", async () => {
    const slow = deferred<ReturnType<typeof statusFor>>();
    mocks.getStatus.mockReturnValueOnce(slow.promise);

    const load = wirexAccountService.silentRefresh(true);
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());

    // Sign-out lands while /status is still open.
    wirexAccountService.reset();
    slow.resolve(statusFor("card-previous"));
    await load;

    expect(wirexAccountService.getSnapshot().card).toBeNull();
    expect(mocks.setCachedBalance).not.toHaveBeenCalled();
    expect(mocks.storeAuthData).not.toHaveBeenCalled();
  });
});

describe("WirexAccountService visible-state teardown", () => {
  it("does not clear a new session's revalidating state from a reset load", async () => {
    const old = deferred<ReturnType<typeof statusFor>>();
    mocks.getStatus.mockReturnValueOnce(old.promise);

    const abandoned = wirexAccountService.refresh(true);
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());

    wirexAccountService.reset();

    // Relogin starts its own visible load; the abandoned one settling must not
    // tear down the state this one owns.
    const fresh = deferred<ReturnType<typeof statusFor>>();
    mocks.getStatus.mockReturnValueOnce(fresh.promise);
    const current = wirexAccountService.refresh(true);
    expect(wirexAccountService.revalidating).toBe(true);

    old.resolve(statusFor("card-previous"));
    await abandoned;
    expect(wirexAccountService.revalidating).toBe(true);

    fresh.resolve(statusFor("card-current"));
    await current;
    expect(wirexAccountService.revalidating).toBe(false);
  });
});

describe("WirexAccountService load serialization", () => {
  it("keeps at most one silent load in flight when getStatus is slow", async () => {
    // getStatus is documented to take up to 90s; the card tab polls every 10s.
    const first = deferred<ReturnType<typeof statusFor>>();
    mocks.getStatus.mockReturnValueOnce(first.promise);

    const a = wirexAccountService.silentRefresh(true);
    const b = wirexAccountService.silentRefresh(true);
    const c = wirexAccountService.silentRefresh(true);

    // load() awaits the address before reaching getStatus.
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    first.resolve(statusFor("card-1"));
    await Promise.all([a, b, c]);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it("does not let a slow earlier response overwrite newer card state", async () => {
    const slow = deferred<ReturnType<typeof statusFor>>();
    mocks.getStatus.mockReturnValueOnce(slow.promise);

    const stale = wirexAccountService.silentRefresh(true);
    // A second request while the first is still open joins it rather than
    // racing it, so there is no ordering in which the older result lands last.
    const joined = wirexAccountService.silentRefresh(true);
    expect(joined).toBe(stale);

    slow.resolve(statusFor("card-old"));
    await stale;

    mocks.getStatus.mockResolvedValueOnce(statusFor("card-new"));
    await wirexAccountService.silentRefresh(true);

    expect(wirexAccountService.getSnapshot().card?.id).toBe("card-new");
  });

  it("joins a running silent load instead of racing it from the foreground", async () => {
    const slow = deferred<ReturnType<typeof statusFor>>();
    mocks.getStatus.mockReturnValueOnce(slow.promise);

    const poll = wirexAccountService.silentRefresh(true);
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());

    // Pull-to-refresh over a running poll: shows the revalidating state, but
    // must not open a second status+wallet round trip that could land stale.
    const foreground = wirexAccountService.refresh(true);
    expect(wirexAccountService.revalidating).toBe(true);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);

    slow.resolve(statusFor("card-1"));
    await Promise.all([poll, foreground]);
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
    expect(wirexAccountService.revalidating).toBe(false);
  });

  it("clears the foreground revalidating state when the joined silent load fails", async () => {
    const slow = deferred<ReturnType<typeof statusFor>>();
    mocks.getStatus.mockReturnValueOnce(slow.promise);

    const poll = wirexAccountService.silentRefresh(true);
    await vi.waitFor(() => expect(mocks.getStatus).toHaveBeenCalled());

    const foreground = wirexAccountService.refresh(true);
    expect(wirexAccountService.revalidating).toBe(true);

    // The silent load's failure path skips every visible state update, so the
    // flag the foreground request set must still be cleared when it settles.
    slow.resolve(Promise.reject(new Error("status unavailable")) as never);
    await Promise.all([poll, foreground]);

    expect(wirexAccountService.revalidating).toBe(false);
    expect(wirexAccountService.getSnapshot().loading).toBe(false);
  });

  it("starts a fresh load once the previous one settled", async () => {
    mocks.getStatus.mockResolvedValue(statusFor("card-1"));

    await wirexAccountService.silentRefresh(true);
    await wirexAccountService.silentRefresh(true);

    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });
});

describe("WirexAccountService closed cards", () => {
  // Live mainnet shape after a permanent close: the card keeps its /status entry
  // with status "Closed". It can't be revealed, frozen or spent, so it must not
  // reach the carousel or become the primary card.
  it("drops a closed card and keeps the active one", async () => {
    mocks.getStatus.mockResolvedValue({
      verificationStatus: "Approved",
      cards: [
        { id: "card-closed", status: "Closed", last4: "7823" },
        { id: "card-active", status: "Active", last4: "3636" },
      ],
      bankAccounts: [] as unknown[],
    });

    await wirexAccountService.silentRefresh(true);

    const snapshot = wirexAccountService.getSnapshot();
    expect(snapshot.cards.map((c) => c.id)).toEqual(["card-active"]);
    expect(snapshot.card?.id).toBe("card-active");
  });

  it("reports no card at all once every card is closed", async () => {
    mocks.getStatus.mockResolvedValue({
      verificationStatus: "Approved",
      cards: [{ id: "card-closed", status: "Closed", last4: "7823" }],
      bankAccounts: [] as unknown[],
    });

    await wirexAccountService.silentRefresh(true);

    const snapshot = wirexAccountService.getSnapshot();
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.card).toBeNull();
    // A closed plastic card must not keep the physical-card CTA suppressed.
  });

  it("still reads the wallet once every card is closed so a replacement can be issued", async () => {
    // The wallet read used to be skipped without a usable card, leaving balance
    // and address null — the two fields the replacement state needs. The
    // placeholder was then untappable and the irreversible last close dead-ended
    // on the disabled verification path.
    mocks.getStatus.mockResolvedValue({
      verificationStatus: "Approved",
      cards: [{ id: "card-closed", status: "Closed", last4: "7823" }],
      bankAccounts: [] as unknown[],
    });
    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "10" }],
    });

    await wirexAccountService.silentRefresh(true);

    const snapshot = wirexAccountService.getSnapshot();
    expect(mocks.getWallet).toHaveBeenCalled();
    expect(snapshot.allCardsClosed).toBe(true);
    expect(snapshot.balanceEur).toBe(10);
    expect(snapshot.smartAccountAddress).toBe(WALLET);
    expect(isAwaitingReplacementCard(snapshot)).toBe(true);
  });
});

describe("WirexAccountService optimistic debit", () => {
  const withBalance = (eur: string) => ({
    verificationStatus: "Approved",
    cards: [{ id: "card-1", status: "Active", last4: "1234" }],
    bankAccounts: [] as unknown[],
    _eur: eur,
  });

  beforeEach(() => {
    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "100" }],
    });
  });

  it("moves the balance immediately and holds it against a stale read", async () => {
    mocks.getStatus.mockResolvedValue(withBalance("100"));
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(100);

    wirexAccountService.applyOptimisticDebit(25);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(75);

    // Ledger still serving the pre-withdrawal figure: must not snap back up.
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(75);
  });

  it("hands back to the live figure once the ledger has caught up", async () => {
    mocks.getStatus.mockResolvedValue(withBalance("100"));
    await wirexAccountService.silentRefresh(true);
    wirexAccountService.applyOptimisticDebit(25);

    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "70" }],
    });
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(70);
  });

  it("restores the previous balance when the send turned out to fail", async () => {
    mocks.getStatus.mockResolvedValue(withBalance("100"));
    await wirexAccountService.silentRefresh(true);
    const handle = wirexAccountService.applyOptimisticDebit(25);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(75);

    wirexAccountService.revertOptimisticBalance(handle);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(100);
  });
});

describe("WirexAccountService optimistic credit", () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({
      verificationStatus: "Approved",
      cards: [{ id: "card-1", status: "Active", last4: "1234" }],
      bankAccounts: [] as unknown[],
    });
    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "100" }],
    });
  });

  it("credits immediately and holds while the ledger is still behind", async () => {
    await wirexAccountService.silentRefresh(true);
    wirexAccountService.applyOptimisticCredit(30);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(130);

    // EURC not confirmed on Base yet, or Wirex has not swapped it to WEUR.
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(130);
  });

  it("hands back once the top-up has actually landed", async () => {
    await wirexAccountService.silentRefresh(true);
    wirexAccountService.applyOptimisticCredit(30);

    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "131" }],
    });
    await wirexAccountService.silentRefresh(true);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(131);
  });

  it("restores the previous balance when the transfer failed", async () => {
    await wirexAccountService.silentRefresh(true);
    const handle = wirexAccountService.applyOptimisticCredit(30);
    wirexAccountService.revertOptimisticBalance(handle);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(100);
  });
});

describe("WirexAccountService optimistic stacking", () => {
  it("stacks a credit on top of a debit instead of replacing it", async () => {
    mocks.getStatus.mockResolvedValue({
      verificationStatus: "Approved",
      cards: [{ id: "card-1", status: "Active", last4: "1234" }],
      bankAccounts: [] as unknown[],
    });
    mocks.getWallet.mockResolvedValue({
      walletAddress: WALLET,
      balances: [{ tokenSymbol: "WEUR", balance: "100" }],
    });
    await wirexAccountService.silentRefresh(true);

    // Send 1 to the wallet, then send it straight back: net zero, not -2.
    wirexAccountService.applyOptimisticDebit(1);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(99);
    wirexAccountService.applyOptimisticCredit(1);
    expect(wirexAccountService.getSnapshot().balanceEur).toBe(100);
  });
});

describe("WirexAccountService verification transition", () => {
  const pending = {
    verificationStatus: "Applied",
    cards: [] as unknown[],
    bankAccounts: [] as unknown[],
  };
  const approved = {
    verificationStatus: "Approved",
    cards: [] as unknown[],
    bankAccounts: [] as unknown[],
  };

  it("announces KYC turning approved while the app is open", async () => {
    mocks.getStatus.mockResolvedValueOnce(pending);
    await wirexAccountService.silentRefresh(true);
    expect(mocks.emit).not.toHaveBeenCalledWith(WIREX_VERIFICATION_APPROVED_EVENT);

    // The poll that flips it: this is the moment a card and an IBAN become due
    // without anything server-side re-running provisioning.
    mocks.getStatus.mockResolvedValueOnce(approved);
    await wirexAccountService.silentRefresh(true);
    expect(mocks.emit).toHaveBeenCalledWith(WIREX_VERIFICATION_APPROVED_EVENT);
  });

  it("stays quiet when the first read of the launch is already approved", async () => {
    // The launch check covers that account; re-announcing would just run it twice.
    mocks.getStatus.mockResolvedValueOnce(approved);
    await wirexAccountService.silentRefresh(true);
    expect(mocks.emit).not.toHaveBeenCalledWith(WIREX_VERIFICATION_APPROVED_EVENT);
  });

  it("does not repeat the announcement on every later poll", async () => {
    mocks.getStatus.mockResolvedValueOnce(pending);
    await wirexAccountService.silentRefresh(true);
    mocks.getStatus.mockResolvedValue(approved);
    await wirexAccountService.silentRefresh(true);
    await wirexAccountService.silentRefresh(true);
    const announcements = mocks.emit.mock.calls.filter(
      ([event]) => event === WIREX_VERIFICATION_APPROVED_EVENT,
    );
    expect(announcements).toHaveLength(1);
  });
});
