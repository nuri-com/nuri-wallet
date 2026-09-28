import { beforeEach, describe, expect, it, vi } from "vitest";

// Review 5294728655 #2: a launch-time download can finish before this module loads, and its
// transition event is then already gone. The pending flag has to start from the state machine's
// current context, and a later transition to pending has to reach the auto-apply.

const state = vi.hoisted(() => ({
  latestPending: false,
  listener: null as null | ((event: { context: { isUpdatePending: boolean } }) => void),
}));

vi.mock("expo-updates", () => ({
  isEnabled: true,
  get latestContext() {
    return { isUpdatePending: state.latestPending };
  },
  addUpdatesStateChangeListener: (
    listener: (event: { context: { isUpdatePending: boolean } }) => void,
  ) => {
    state.listener = listener;
    return { remove: () => {} };
  },
  checkForUpdateAsync: vi.fn(),
  fetchUpdateAsync: vi.fn(),
  reloadAsync: vi.fn(),
}));
vi.mock("../../lib/OperationLogUtils", () => ({
  LOG_EMOJI: { app: "" },
  logWithId: () => {},
}));

async function load() {
  vi.resetModules();
  return import("./OtaUpdateService");
}

beforeEach(() => {
  state.latestPending = false;
  state.listener = null;
});

describe("OtaUpdateService pending mirror", () => {
  it("starts from a bundle the launch check downloaded before this module loaded", async () => {
    state.latestPending = true;
    const { isUpdatePending } = await load();
    expect(isUpdatePending()).toBe(true);
  });

  it("starts empty when nothing is pending", async () => {
    const { isUpdatePending } = await load();
    expect(isUpdatePending()).toBe(false);
  });

  it("tells its listeners the moment a bundle becomes pending, once", async () => {
    const { isUpdatePending, onUpdatePending } = await load();
    const heard = vi.fn();
    onUpdatePending(heard);

    state.listener?.({ context: { isUpdatePending: true } });
    state.listener?.({ context: { isUpdatePending: true } });

    expect(isUpdatePending()).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
