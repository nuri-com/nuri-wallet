import { beforeEach, describe, expect, it, vi } from "vitest";

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const CARD_ACTIVE = { type: "VisaVirtualCard", status: "Active" };

const mocks = vi.hoisted(() => ({
  getEthereumAddress: vi.fn(),
  getUser: vi.fn(),
  getStatus: vi.fn(),
  getOnboardEmail: vi.fn(),
  ensureStarted: vi.fn(),
  silentRefresh: vi.fn(),
  storage: new Map<string, string>(),
}));

// The marker module is the real one — the repair and WirexService share it, and
// these tests exercise that sharing — over a fake AsyncStorage.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => mocks.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      mocks.storage.set(key, value);
    }),
  },
}));
vi.mock("../../lib/secureKeyStorage", () => ({
  getEthereumAddress: mocks.getEthereumAddress,
}));
vi.mock("./WirexService", () => ({
  wirexService: {
    getUser: mocks.getUser,
    getStatus: mocks.getStatus,
    getOnboardEmail: mocks.getOnboardEmail,
  },
}));
vi.mock("./WirexAccountService", () => ({
  WIREX_VERIFICATION_APPROVED_EVENT: "wirex:verificationApproved",
  wirexAccountService: {
    ensureStarted: mocks.ensureStarted,
    silentRefresh: mocks.silentRefresh,
  },
}));
vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: { card: "💳" },
  logWithId: vi.fn(),
  warnWithId: vi.fn(),
}));

import { EventBus } from "../events/AppEventBusService";
import { markProvisioningAttempt } from "../../lib/wirex/provisioningAttemptMarker";
import {
  initWirexProvisioningRepair,
  resetWirexProvisioningRepair,
  runWirexProvisioningRepair,
} from "./WirexProvisioningRepairService";

// An approved account with the card rail Active and no card — the state this
// repair exists for.
type Snapshot = {
  card: { id: string } | null;
  cards: unknown[];
  iban: { iban: string } | null;
  allCardsClosed: boolean;
};

const CARDLESS: Snapshot = {
  card: null,
  cards: [],
  iban: null,
  allCardsClosed: false,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const retriggerCalls = () =>
  mocks.getStatus.mock.calls.filter(([params]) => Boolean(params?.email)).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.storage.clear();
  resetWirexProvisioningRepair();
  mocks.getEthereumAddress.mockResolvedValue(WALLET);
  mocks.getUser.mockResolvedValue({
    capabilities: [CARD_ACTIVE],
    visaVirtualCard: null,
    email: "user@example.com",
    country: "SM",
  });
  // Mirrors WirexService: an email-bearing status call records the attempt
  // first, and refuses to send when the caller has been abandoned.
  mocks.getStatus.mockImplementation(
    async (params: { wallet: string; email?: string; abortIf?: () => boolean }) => {
      if (params.email && !(await markProvisioningAttempt(params.wallet))) {
        throw new Error("wirex_provisioning_guard_unavailable");
      }
      if (params.abortIf?.()) throw new Error("wirex_request_abandoned");
      return {};
    },
  );
  mocks.getOnboardEmail.mockResolvedValue(null);
  mocks.silentRefresh.mockResolvedValue(CARDLESS);
});

// Drains the post-trigger poll (5 × 3s) without waiting in real time.
const settle = async (run: Promise<unknown>) => {
  await vi.runAllTimersAsync();
  return run;
};

describe("provisioning re-trigger", () => {
  it("fires with the account email and its own residence country", async () => {
    await settle(runWirexProvisioningRepair());
    expect(mocks.getStatus).toHaveBeenCalledWith({
      wallet: WALLET,
      email: "user@example.com",
      country: "SM",
      abortIf: expect.any(Function),
    });
  });

  it("omits the country rather than defaulting it when the account has none", async () => {
    mocks.getUser.mockResolvedValue({
      capabilities: [CARD_ACTIVE],
      visaVirtualCard: null,
      email: "user@example.com",
      country: null,
    });
    await settle(runWirexProvisioningRepair());
    expect(mocks.getStatus).toHaveBeenCalledWith({
      wallet: WALLET,
      email: "user@example.com",
      abortIf: expect.any(Function),
    });
  });

  it("polls read-only after firing — never a second re-trigger", async () => {
    await settle(runWirexProvisioningRepair());
    expect(retriggerCalls()).toBe(1);
    // The card never lands, so every poll attempt runs: the pre-check read plus
    // five poll reads, all read-only.
    expect(mocks.silentRefresh).toHaveBeenCalledTimes(6);
  });

  it("does not fire again on a relaunch while the first one is still settling", async () => {
    await settle(runWirexProvisioningRepair());
    expect(retriggerCalls()).toBe(1);

    // A relaunch loses both in-memory latches; the account still reads as
    // cardless because Wirex has not listed the card yet.
    resetWirexProvisioningRepair();
    const outcome = await settle(runWirexProvisioningRepair());

    expect(retriggerCalls()).toBe(1);
    expect(outcome).toMatchObject({ status: "cooling_down" });
  });

  it("retries once the cooldown has passed and nothing was provisioned", async () => {
    await settle(runWirexProvisioningRepair());
    resetWirexProvisioningRepair();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);

    const outcome = await settle(runWirexProvisioningRepair());
    expect(retriggerCalls()).toBe(2);
    expect(outcome).toMatchObject({ status: "triggered" });
  });

  it("does not fire while signup's own provisioning attempt is still settling", async () => {
    // Onboarding (/onboard/start) records the same marker through WirexService.
    // A launch that lands before Wirex lists the card would otherwise see
    // "capability Active + no card" and ask for a second one.
    await markProvisioningAttempt(WALLET);

    const outcome = await settle(runWirexProvisioningRepair());
    expect(retriggerCalls()).toBe(0);
    expect(outcome).toMatchObject({ status: "cooling_down" });
  });

  it("keeps one account's attempt from suppressing another's", async () => {
    await settle(runWirexProvisioningRepair());
    resetWirexProvisioningRepair();
    mocks.getEthereumAddress.mockResolvedValue(OTHER_WALLET);

    await settle(runWirexProvisioningRepair());
    expect(retriggerCalls()).toBe(2);
  });

  it("reads the card rail from the dedicated field when the list omits it", async () => {
    // The live response carries visa_virtual_card while summary.capabilities is
    // still empty — exactly the accounts this repair exists for.
    mocks.getUser.mockResolvedValue({
      capabilities: [],
      visaVirtualCard: { status: "Active" },
      email: "user@example.com",
      country: "SM",
    });
    const outcome = await settle(runWirexProvisioningRepair());
    expect(retriggerCalls()).toBe(1);
    expect(outcome).toMatchObject({ status: "triggered", cardDue: true });
  });

  it("does not provision when the attempt cannot be recorded durably", async () => {
    mocks.storage.set = () => {
      throw new Error("storage full");
    };
    const outcome = await settle(runWirexProvisioningRepair());
    expect(outcome).toMatchObject({ status: "failed" });
  });

  it("leaves an account that is missing nothing alone", async () => {
    mocks.silentRefresh.mockResolvedValue({ ...CARDLESS, card: { id: "card-1" } });
    const outcome = await settle(runWirexProvisioningRepair());
    expect(retriggerCalls()).toBe(0);
    expect(outcome).toMatchObject({ status: "not_due" });
  });
});

describe("KYC approval in the same session", () => {
  it("repairs when verification flips to Approved after the launch check ran", async () => {
    // Launch: still pending, nothing due, and the launch latch is spent.
    mocks.getUser.mockResolvedValue({
      capabilities: [{ type: "VisaVirtualCard", status: "NotAvailable" }],
      visaVirtualCard: null,
      email: "user@example.com",
      country: "SM",
    });
    initWirexProvisioningRepair();
    await settle(Promise.resolve());
    expect(retriggerCalls()).toBe(0);

    // Approval lands with the app open: the rail turns Active and the account
    // still has no card.
    mocks.getUser.mockResolvedValue({
      capabilities: [CARD_ACTIVE],
      visaVirtualCard: null,
      email: "user@example.com",
      country: "SM",
    });
    EventBus.emit("wirex:verificationApproved");
    await settle(Promise.resolve());

    expect(retriggerCalls()).toBe(1);
  });
});

describe("account switch mid-run", () => {
  it("does not re-trigger for an account that signed out before the call", async () => {
    const gate = deferred<Snapshot>();
    mocks.silentRefresh.mockReturnValueOnce(gate.promise);

    const run = runWirexProvisioningRepair();
    // Sign-out lands while the run is parked on the account read.
    resetWirexProvisioningRepair();
    gate.resolve(CARDLESS);
    const outcome = await settle(run);

    expect(retriggerCalls()).toBe(0);
    expect(outcome).toMatchObject({ status: "aborted" });
  });

  it("refuses to send the re-trigger once the account is gone", async () => {
    // The request's own session retry is the danger: a sign-out mid-flight would
    // otherwise resend this email under the next account's freshly minted
    // session. getStatus is handed `abortIf` and re-checks it at that point.
    const inFlight = deferred<void>();
    mocks.getStatus.mockImplementation(
      async (params: { email?: string; abortIf?: () => boolean }) => {
        if (!params.email) return {};
        await inFlight.promise;
        if (params.abortIf?.()) throw new Error("wirex_request_abandoned");
        return {};
      },
    );

    const run = runWirexProvisioningRepair();
    await vi.advanceTimersByTimeAsync(0);
    // Sign-out lands while the re-trigger is in flight.
    resetWirexProvisioningRepair();
    inFlight.resolve();
    const outcome = await settle(run);

    expect(outcome).toMatchObject({ status: "aborted" });
  });

  it("stops polling into the next account's snapshot", async () => {
    const run = runWirexProvisioningRepair();
    // Let the run reach its post-trigger poll, then sign out.
    await vi.advanceTimersByTimeAsync(0);
    resetWirexProvisioningRepair();
    mocks.silentRefresh.mockClear();
    await settle(run);

    // The poll's refreshes would have written the previous account's card and
    // IBAN into the snapshot the next user is looking at.
    expect(mocks.silentRefresh).not.toHaveBeenCalled();
  });
});
