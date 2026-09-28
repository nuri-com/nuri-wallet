import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import ts from "typescript";
import { isWalletOpenRecovery } from "../../services/swapkit/SwapKitWalletOpenRecovery";
import type { SwapKitOrder } from "../../services/swapkit/SwapKitOrderStore";
import type { SwapKitTrackResponse } from "../../services/swapkit/SwapKitService";
import fixture from "../../services/swapkit/__fixtures__/wallet-open-track.json";

// Execute the actual TSX component and effects without adding a DOM/native test dependency.
// Only React scheduling and its external boundaries are substituted.
function mountHost() {
  let cursor = 0;
  const slots: any[] = [];
  const effects: (() => void)[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const surfaces = new Set<() => void>();
  let open = false;
  let props = { owner: fixture.fromAddress, enabled: true };
  let tree: any;
  const order: SwapKitOrder = {
    txId: fixture.id,
    settleTarget: fixture.recipient,
    expectedUsdc: 0,
    usdcBaseline: "0",
    sats: 0,
    createdAt: 0,
    attempts: 0,
    kind: "discovered",
  };
  const rows = [order];
  const statuses = new Map<string, SwapKitTrackResponse>([[fixture.id, structuredClone(fixture)]]);
  const owner = vi.fn(async () => props.owner);
  const sheet = (): null => null;
  const react = {
    createElement: (type: unknown, p: any) => ({ type, props: p }),
    useRef: (initial: unknown) => {
      const i = cursor++;
      return (slots[i] ??= { current: initial });
    },
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [
        slots[i],
        (value: unknown) => {
          slots[i] = value;
        },
      ];
    },
    useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
      const i = cursor++;
      const old = slots[i];
      if (!old || deps.some((value, n) => value !== old.deps[n])) {
        effects.push(() => {
          old?.cleanup?.();
          slots[i] = { deps, cleanup: effect() };
        });
      }
    },
  };
  const modules: Record<string, unknown> = {
    react: { ...react, default: react },
    "../../lib/secureKeyStorage": { getEthereumAddress: owner },
    "../../lib/ui/openSurfaces": {
      hasOpenSurface: () => open,
      subscribeOpenSurfaces: (fn: () => void) => {
        surfaces.add(fn);
        return () => surfaces.delete(fn);
      },
    },
    "../../services/events/AppEventBusService": {
      EventBus: {
        on: (event: string, fn: () => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(fn);
          return () => listeners.get(event)?.delete(fn);
        },
      },
    },
    "../../services/swapkit/SwapKitOrderStore": { SwapKitOrderStore: { list: () => rows } },
    "../../services/swapkit/SwapKitPendingTracker": {
      getSwapKitLastStatus: (id: string) => statuses.get(id),
    },
    "../../services/swapkit/SwapKitWalletOpenRecovery": { isWalletOpenRecovery },
    "./SwapStatusDetailSheet": { default: sheet },
  };
  const source = readFileSync(
    new URL("./SwapKitWalletOpenRecoveryHost.tsx", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: false,
    },
  }).outputText;
  const exports: any = {};
  new Function("require", "exports", "React", compiled)(
    (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected side-effect dependency: ${name}`);
      return modules[name];
    },
    exports,
    react,
  );
  const render = () => {
    cursor = 0;
    tree = exports.default(props);
    while (effects.length) effects.shift()?.();
    return tree;
  };
  const flush = async () => {
    render();
    await vi.runAllTimersAsync();
    return render();
  };
  return {
    rows,
    statuses,
    order,
    owner,
    sheet,
    flush,
    render,
    emit: (event = "swapkit:trackUpdated") => {
      for (const fn of listeners.get(event) ?? []) fn();
    },
    surface: (value: boolean) => {
      open = value;
      for (const fn of surfaces) fn();
    },
    props: (value: Partial<typeof props>) => {
      props = { ...props, ...value };
      render();
    },
    close: () => tree.props.onClose(),
    unmount: () => {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("mounts the existing sheet from the real id/recipient/fromAddress server shape without a financial dependency", async () => {
  const host = mountHost();
  const tree = await host.flush();
  expect(tree.type).toBe(host.sheet);
  expect(tree.props.orderId).toBe(fixture.id);
  expect(tree.props.visible).toBe(true);
  expect(host.rows).toHaveLength(1);
  host.unmount();
});
it("handles events before/after initial scan, dismissal, multiple candidates and unchanged-message polls", async () => {
  const host = mountHost();
  host.statuses.clear();
  host.render();
  host.emit();
  expect(await host.flush()).toBeNull();
  host.statuses.set(fixture.id, structuredClone(fixture));
  host.emit();
  expect((await host.flush()).props.orderId).toBe(fixture.id);
  host.close();
  host.emit();
  expect(await host.flush()).toBeNull();
  const second = { ...host.order, txId: "second" };
  host.rows.push(second);
  host.statuses.set("second", { ...fixture, id: "second" });
  host.emit();
  expect((await host.flush()).props.orderId).toBe("second");
  expect(host.rows).toHaveLength(2);
  host.unmount();
});
it("defers behind signing/payment surfaces and cancels pending owner reads on lock/logout", async () => {
  const host = mountHost();
  host.surface(true);
  expect(await host.flush()).toBeNull();
  host.surface(false);
  host.props({ enabled: false });
  expect(await host.flush()).toBeNull();
  host.props({ enabled: true });
  expect((await host.flush()).props.orderId).toBe(fixture.id);
  host.props({ enabled: false });
  expect(await host.flush()).toBeNull();
  host.unmount();
});
it("rejects a switched wallet while the asynchronous owner lookup is pending", async () => {
  const host = mountHost();
  host.owner.mockResolvedValue(`0x${"22".repeat(20)}`);
  expect(await host.flush()).toBeNull();
  host.unmount();
});
it.each([
  "foreign",
  "recipient",
  "completed",
  "unfunded",
  "unsigned",
  "submitted",
  "accepted",
  "id mismatch",
])("does not open for %s", async (kind) => {
  const host = mountHost();
  const status = host.statuses.get(fixture.id)!;
  if (kind === "foreign") status.fromAddress = `0x${"22".repeat(20)}`;
  if (kind === "recipient") status.recipient = `0x${"22".repeat(20)}`;
  if (kind === "completed") status.status = "COMPLETED";
  if (kind === "unfunded") status.status = "AWAITING_FUNDING";
  if (kind === "unsigned") status.legs![0].state = {};
  if (kind === "submitted") status.legs![1].externalId = "provider-order";
  if (kind === "accepted") host.order.recoveryConsent = { accepted: {} } as any;
  if (kind === "id mismatch") status.txId = "foreign-order";
  expect(await host.flush()).toBeNull();
  expect(host.rows).toHaveLength(1);
  host.unmount();
});
it("replaces the v1 host with authenticated v2 foreground recovery and no Continue button", () => {
  const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  expect(app).not.toContain("SwapKitWalletOpenRecoveryHost");
  expect(app).toContain(
    "!isSignedInWithPRF || !isAppActive || biometricLockVisible || teardownBlocked",
  );
  expect(app).toContain("resumeSwapKitV2Orders()");
  const sheet = readFileSync(new URL("./SwapStatusDetailSheet.tsx", import.meta.url), "utf8");
  expect(sheet).not.toContain("recoveryContinue");
});
