import { beforeEach, describe, expect, it, vi } from "vitest";

const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    listeners,
    EventBus: {
      on: (event: string, fn: (payload?: unknown) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(fn);
        listeners.set(event, set);
        return () => set.delete(fn);
      },
      emit: (event: string, payload?: unknown) => {
        for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
      },
    },
  };
});
vi.mock("../events/AppEventBusService", () => ({ EventBus: bus.EventBus }));

import { clearV2Moves, listV2Moves } from "../swapkit/SwapKitV2MoveStatus";
import { withCardTransferPill } from "./CardTransferPill";

const phases = () => listV2Moves().map((move) => [move.kind, move.phase]);

describe("withCardTransferPill", () => {
  beforeEach(() => {
    clearV2Moves();
    bus.listeners.clear();
  });

  it("shows Processing while the transfer runs and Completed when it resolves", async () => {
    let finish: () => void = () => {};
    const running = withCardTransferPill(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(phases()).toEqual([["transfer", "processing"]]);
    finish();
    await running;
    expect(phases()).toEqual([["transfer", "completed"]]);
  });

  it("stays Processing for a broadcast until its receipt settles", async () => {
    await withCardTransferPill(
      async () => ({ txHash: "0xABC", confirmed: false }),
      (r) => r,
    );
    expect(phases()).toEqual([["transfer", "processing"]]);
    bus.EventBus.emit("wallet:transferSettled", { txHash: "0xother" });
    expect(phases()).toEqual([["transfer", "processing"]]);
    bus.EventBus.emit("wallet:transferSettled", { txHash: "0xabc", reverted: false });
    expect(phases()).toEqual([["transfer", "completed"]]);
  });

  it("reports a reverted broadcast as failed", async () => {
    await withCardTransferPill(
      async () => ({ txHash: "0xdead", confirmed: false }),
      (r) => r,
    );
    bus.EventBus.emit("wallet:transferSettled", { txHash: "0xdead", reverted: true });
    expect(phases()).toEqual([["transfer", "failed"]]);
  });

  it("reports a failed transfer as failed and rethrows", async () => {
    await expect(
      withCardTransferPill(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(phases()).toEqual([["transfer", "failed"]]);
  });

  it("drops the pill when the user cancelled the passkey prompt", async () => {
    await expect(
      withCardTransferPill(async () => {
        throw new Error("User cancelled");
      }),
    ).rejects.toThrow();
    expect(phases()).toEqual([]);
  });
});
